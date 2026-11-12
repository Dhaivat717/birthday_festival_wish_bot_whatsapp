import fs from 'fs';
import path from 'path';

export class MetricsStore {
  /**
   * Persistent observability store for tracking wishes per group, Gemini usage,
   * WebSocket disconnect / failed-reconnect state, and faults/errors.
   * Emits Railway-native single-line structured JSON logs (with `level` and `message`)
   * so Railway's Observability Dashboard & Log Explorer can filter by `@event:...` and `@level:...`.
   * @param {string} dataDir
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'metrics.json');
    this.startedAt = new Date().toISOString();
    this.connectionStatus = 'starting';
    this.lastConnectedAt = null;
    this.disconnectedSince = new Date().toISOString();
    this.lastDisconnectAt = null;
    this.lastDisconnectStatusCode = null;
    this.consecutiveReconnectFailures = 0;
    this.wsStuckDisconnected = false;

    this.data = {
      totals: {
        wishesSent: 0,
        wishCandidatesDetected: 0,
        manualWishesDetected: 0,
        cooldownSkips: 0,
        geminiCalls: 0,
        geminiFallbacks: 0,
        faultsTotal: 0,
        wsDisconnects: 0,
        wsReconnectSuccess: 0,
        wsReconnectFailures: 0,
        wsStuckDisconnectedAlerts: 0,
      },
      // groupId -> { groupId, groupName, wishesSent, byType: { birthday, anniversary, festival, other }, wishCandidatesDetected, manualWishesDetected, cooldownSkips, lastWishAt, lastWishTarget, lastWishText }
      groups: {},
      // category -> count
      faultsByCategory: {},
      // Ring buffer of last 50 faults/errors: [{ timestamp, category, groupName, message }]
      recentFaults: [],
      // Ring buffer of last 30 sent wishes: [{ timestamp, groupId, groupName, targetName, eventType, eventKey, replyText, isDryRun }]
      recentWishes: [],
      lastModelUsed: 'auto',
    };

    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          this.data.totals = { ...this.data.totals, ...(parsed.totals || {}) };
          this.data.groups = parsed.groups || {};
          this.data.faultsByCategory = parsed.faultsByCategory || {};
          this.data.recentFaults = Array.isArray(parsed.recentFaults) ? parsed.recentFaults : [];
          this.data.recentWishes = Array.isArray(parsed.recentWishes) ? parsed.recentWishes : [];
          this.data.lastModelUsed = parsed.lastModelUsed || 'auto';
        }
      }
    } catch (err) {
      console.error('[MetricsStore] Failed to load metrics.json, starting fresh:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[MetricsStore] Failed to save metrics.json:', err.message);
    }
  }

  _ensureGroup(groupId, groupName = '') {
    if (!this.data.groups[groupId]) {
      this.data.groups[groupId] = {
        groupId,
        groupName: groupName || groupId,
        wishesSent: 0,
        byType: { birthday: 0, anniversary: 0, festival: 0, other: 0 },
        wishCandidatesDetected: 0,
        manualWishesDetected: 0,
        cooldownSkips: 0,
        lastWishAt: null,
        lastWishTarget: null,
        lastWishText: null,
      };
    } else if (groupName && groupName !== groupId) {
      this.data.groups[groupId].groupName = groupName;
    }
    return this.data.groups[groupId];
  }

  /**
   * Pre-registers whitelisted groups so they appear in the dashboard even with 0 wishes.
   */
  registerGroups(groupList = []) {
    for (const g of groupList) {
      this._ensureGroup(g.id, g.subject);
    }
    this._save();
  }

  /**
   * Called when the WhatsApp WebSocket successfully opens (`connection === 'open'`).
   */
  setConnectionOpen() {
    const nowIso = new Date().toISOString();
    const wasDisconnectedAfterOpen = this.lastConnectedAt !== null && this.connectionStatus !== 'open';
    const downtimeSeconds = this.disconnectedSince
      ? Math.max(0, Math.round((Date.now() - new Date(this.disconnectedSince).getTime()) / 1000))
      : 0;
    const attemptsTaken = this.consecutiveReconnectFailures + (wasDisconnectedAfterOpen ? 1 : 0);

    this.connectionStatus = 'open';
    this.lastConnectedAt = nowIso;
    this.disconnectedSince = null;
    this.consecutiveReconnectFailures = 0;
    this.wsStuckDisconnected = false;

    if (wasDisconnectedAfterOpen) {
      this.data.totals.wsReconnectSuccess += 1;
      this._emitStructured(
        'info',
        'ws_reconnected',
        `WhatsApp WebSocket reconnected after ${downtimeSeconds}s (${attemptsTaken} attempt(s))`,
        {
          wsConnected: true,
          wsStuckDisconnected: false,
          downtimeSeconds,
          attemptsTaken,
          wsReconnectSuccessTotal: this.data.totals.wsReconnectSuccess,
        }
      );
      this._save();
    } else {
      this._emitStructured('info', 'ws_connected', 'WhatsApp WebSocket connected and ready', {
        wsConnected: true,
        wsStuckDisconnected: false,
      });
    }
  }

  /**
   * Legacy compatibility helper for setting connection status directly.
   */
  setConnectionStatus(status) {
    if (status === 'open') {
      this.setConnectionOpen();
    } else {
      this.connectionStatus = status;
      if (!this.disconnectedSince) {
        this.disconnectedSince = new Date().toISOString();
      }
    }
  }

  /**
   * Called whenever the WhatsApp WebSocket closes (`connection === 'close'`).
   * Distinguishes initial disconnect from a failed reconnect attempt (`wasAlreadyReconnecting`).
   */
  recordWsDisconnect({ statusCode = 'unknown', reason = '', isLoggedOut = false } = {}) {
    const nowIso = new Date().toISOString();
    const wasAlreadyReconnecting = this.connectionStatus === 'reconnecting';

    this.lastDisconnectAt = nowIso;
    this.lastDisconnectStatusCode = statusCode;
    if (!this.disconnectedSince) {
      this.disconnectedSince = nowIso;
    }

    this.connectionStatus = 'reconnecting';
    this.data.totals.wsDisconnects += 1;

    const downtimeSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(this.disconnectedSince).getTime()) / 1000)
    );

    if (wasAlreadyReconnecting) {
      // We were already trying to reconnect and the socket closed again without opening!
      this.consecutiveReconnectFailures += 1;
      this.data.totals.wsReconnectFailures += 1;
      if (this.consecutiveReconnectFailures >= 2 || downtimeSeconds >= 60) {
        this.wsStuckDisconnected = true;
      }

      this._recordFaultInternal(
        'ws_reconnect_failed',
        `WebSocket reconnect attempt #${this.consecutiveReconnectFailures} failed (status: ${statusCode}${reason ? `, ${reason}` : ''}, downtime: ${downtimeSeconds}s)`
      );

      this._emitStructured(
        'error',
        'ws_reconnect_failed',
        `WhatsApp WebSocket failed to reconnect on attempt #${this.consecutiveReconnectFailures} (status ${statusCode}, down ${downtimeSeconds}s)`,
        {
          wsConnected: false,
          wsStuckDisconnected: this.wsStuckDisconnected,
          statusCode,
          isLoggedOut,
          consecutiveFailures: this.consecutiveReconnectFailures,
          downtimeSeconds,
          wsReconnectFailuresTotal: this.data.totals.wsReconnectFailures,
          wsDisconnectsTotal: this.data.totals.wsDisconnects,
        }
      );
    } else {
      // First disconnect from an open session
      this._recordFaultInternal(
        'whatsapp_disconnect',
        `Connection closed with status ${statusCode}${reason ? ` (${reason})` : ''}`
      );

      this._emitStructured(
        'warn',
        'ws_disconnected',
        `WhatsApp WebSocket disconnected (status ${statusCode}) — scheduling reconnect`,
        {
          wsConnected: false,
          wsStuckDisconnected: false,
          statusCode,
          isLoggedOut,
          wsDisconnectsTotal: this.data.totals.wsDisconnects,
        }
      );
    }

    this._save();
  }

  /**
   * Called when a reconnect attempt throws or hangs (e.g. connect timeout) without ever reaching `open`,
   * OR when the watchdog detects the WebSocket has stayed disconnected for >= 60s without reconnecting.
   */
  recordWsStuckDisconnected({ reason = 'Watchdog threshold exceeded', countAsAttemptFailure = false } = {}) {
    if (!this.disconnectedSince) {
      this.disconnectedSince = new Date().toISOString();
    }
    const downtimeSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(this.disconnectedSince).getTime()) / 1000)
    );

    if (countAsAttemptFailure) {
      this.consecutiveReconnectFailures += 1;
      this.data.totals.wsReconnectFailures += 1;
    }

    this.wsStuckDisconnected = true;
    this.data.totals.wsStuckDisconnectedAlerts += 1;

    const msg = `WhatsApp WebSocket disconnected and has NOT reconnected for ${downtimeSeconds}s (failed attempts: ${this.consecutiveReconnectFailures}, last status: ${this.lastDisconnectStatusCode ?? 'none'}, reason: ${reason})`;

    this._recordFaultInternal('ws_stuck_disconnected', msg);

    this._emitStructured('error', 'ws_stuck_disconnected', `🚨 ${msg}`, {
      wsConnected: false,
      wsStuckDisconnected: true,
      downtimeSeconds,
      consecutiveFailures: this.consecutiveReconnectFailures,
      lastStatusCode: this.lastDisconnectStatusCode,
      reason,
      wsStuckAlertsTotal: this.data.totals.wsStuckDisconnectedAlerts,
      wsReconnectFailuresTotal: this.data.totals.wsReconnectFailures,
    });

    this._save();
  }

  recordWishCandidate(groupId, groupName, senderName) {
    this.data.totals.wishCandidatesDetected += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.wishCandidatesDetected += 1;
    this._emitStructured(
      'info',
      'wish_candidate_detected',
      `Wish candidate detected in "${g.groupName}" from ${senderName}`,
      {
        groupId,
        groupName: g.groupName,
        senderName,
        groupCandidatesTotal: g.wishCandidatesDetected,
        globalCandidatesTotal: this.data.totals.wishCandidatesDetected,
      }
    );
    this._save();
  }

  recordManualWish(groupId, groupName, recordedKeys = []) {
    this.data.totals.manualWishesDetected += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.manualWishesDetected += 1;
    this._emitStructured(
      'info',
      'manual_wish_detected',
      `Manual wish by owner in "${g.groupName}" (cooldown added for: ${recordedKeys.join(', ') || 'manual_wish'})`,
      {
        groupId,
        groupName: g.groupName,
        recordedKeys,
        groupManualWishesTotal: g.manualWishesDetected,
        globalManualWishesTotal: this.data.totals.manualWishesDetected,
      }
    );
    this._save();
  }

  recordCooldownSkip(groupId, groupName, eventKey) {
    this.data.totals.cooldownSkips += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.cooldownSkips += 1;
    this._emitStructured(
      'info',
      'cooldown_skip',
      `Skipped auto-wish in "${g.groupName}" for ${eventKey} (48h cooldown active)`,
      {
        groupId,
        groupName: g.groupName,
        eventKey,
        groupCooldownSkipsTotal: g.cooldownSkips,
      }
    );
    this._save();
  }

  recordGeminiCall({ model, usedFallback = false }) {
    this.data.totals.geminiCalls += 1;
    if (model) this.data.lastModelUsed = model;
    if (usedFallback) {
      this.data.totals.geminiFallbacks += 1;
    }
    this._save();
  }

  recordWishSent({ groupId, groupName, targetName, eventType = 'other', eventKey, replyText, isDryRun = false }) {
    const nowIso = new Date().toISOString();
    this.data.totals.wishesSent += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.wishesSent += 1;
    const typeKey = ['birthday', 'anniversary', 'festival'].includes(eventType) ? eventType : 'other';
    g.byType[typeKey] = (g.byType[typeKey] || 0) + 1;
    g.lastWishAt = nowIso;
    g.lastWishTarget = targetName || eventKey;
    g.lastWishText = replyText;

    this.data.recentWishes.unshift({
      timestamp: nowIso,
      groupId,
      groupName: g.groupName,
      targetName: targetName || eventKey,
      eventType: typeKey,
      eventKey,
      replyText,
      isDryRun,
    });
    if (this.data.recentWishes.length > 30) {
      this.data.recentWishes.length = 30;
    }

    this._emitStructured(
      'info',
      'wish_sent',
      `Sent ${typeKey} wish to ${targetName || eventKey} in "${g.groupName}": "${replyText}"`,
      {
        groupId,
        groupName: g.groupName,
        targetName: targetName || eventKey,
        eventType: typeKey,
        eventKey,
        replyText,
        isDryRun,
        groupWishesSentTotal: g.wishesSent,
        globalWishesSentTotal: this.data.totals.wishesSent,
      }
    );
    this._save();
  }

  _recordFaultInternal(category, message, { groupId = null, groupName = null } = {}) {
    const nowIso = new Date().toISOString();
    this.data.totals.faultsTotal += 1;
    this.data.faultsByCategory[category] = (this.data.faultsByCategory[category] || 0) + 1;

    this.data.recentFaults.unshift({
      timestamp: nowIso,
      category,
      groupId,
      groupName,
      message,
    });
    if (this.data.recentFaults.length > 50) {
      this.data.recentFaults.length = 50;
    }
  }

  recordFault(category, errorOrMessage, { groupId = null, groupName = null } = {}) {
    const message =
      errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage || 'Unknown error');

    this._recordFaultInternal(category, message, { groupId, groupName });

    this._emitStructured('error', category, `[Fault:${category}] ${message}`, {
      category,
      groupId,
      groupName,
      errorMessage: message,
      categoryFaultsTotal: this.data.faultsByCategory[category],
      globalFaultsTotal: this.data.totals.faultsTotal,
    });
    this._save();
  }

  /**
   * Emits a single-line JSON log compatible with Railway's Observability Dashboard & Log Explorer.
   * Railway parses `level` (info, warn, error), `message`, and indexes all top-level keys as `@key:value`.
   */
  _emitStructured(level, event, message, payload = {}) {
    console.log(
      JSON.stringify({
        level,
        message,
        event,
        timestamp: new Date().toISOString(),
        ...payload,
      })
    );
  }

  getSnapshot() {
    const uptimeSeconds = Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000);
    const currentDowntimeSeconds =
      this.connectionStatus !== 'open' && this.disconnectedSince
        ? Math.max(0, Math.floor((Date.now() - new Date(this.disconnectedSince).getTime()) / 1000))
        : 0;

    const groupsArray = Object.values(this.data.groups).sort(
      (a, b) => b.wishesSent - a.wishesSent || b.wishCandidatesDetected - a.wishCandidatesDetected
    );
    return {
      status: this.connectionStatus,
      wsConnected: this.connectionStatus === 'open',
      wsStuckDisconnected: this.wsStuckDisconnected,
      startedAt: this.startedAt,
      lastConnectedAt: this.lastConnectedAt,
      disconnectedSince: this.disconnectedSince,
      lastDisconnectAt: this.lastDisconnectAt,
      lastDisconnectStatusCode: this.lastDisconnectStatusCode,
      currentDowntimeSeconds,
      consecutiveReconnectFailures: this.consecutiveReconnectFailures,
      uptimeSeconds,
      reconnectCount: this.data.totals.wsDisconnects,
      lastModelUsed: this.data.lastModelUsed,
      totals: this.data.totals,
      faultsByCategory: this.data.faultsByCategory,
      groups: groupsArray,
      recentWishes: this.data.recentWishes,
      recentFaults: this.data.recentFaults,
    };
  }

  /**
   * Formats a concise text summary for when you send "!stats" in your WhatsApp "Message Yourself" chat.
   */
  formatWhatsAppSummary() {
    const snap = this.getSnapshot();
    const hours = (snap.uptimeSeconds / 3600).toFixed(1);
    const wsStatusLine = snap.wsConnected
      ? `🟢 Connected (Uptime: ${hours}h)`
      : snap.wsStuckDisconnected
      ? `🚨 STUCK DISCONNECTED (${snap.currentDowntimeSeconds}s down, ${snap.consecutiveReconnectFailures} failed attempts)`
      : `🟡 Reconnecting (${snap.currentDowntimeSeconds}s down)`;

    const lines = [
      `📊 *WhatsApp Wish Bot Metrics*`,
      `• Status: ${wsStatusLine}`,
      `• Total Wishes Sent: *${snap.totals.wishesSent}*`,
      `• Wish Messages Detected: ${snap.totals.wishCandidatesDetected}`,
      `• Manual Wishes by You: ${snap.totals.manualWishesDetected}`,
      `• WS Disconnects: ${snap.totals.wsDisconnects} (Recovered: ${snap.totals.wsReconnectSuccess}, Failed Reconnects: *${snap.totals.wsReconnectFailures}*, Stuck Alerts: *${snap.totals.wsStuckDisconnectedAlerts}*)`,
      `• Gemini Calls: ${snap.totals.geminiCalls} (Model: ${snap.lastModelUsed})`,
      `• Total Faults/Errors: *${snap.totals.faultsTotal}*`,
      ``,
      `🏆 *Wishes Per Group:*`,
    ];

    if (snap.groups.length === 0) {
      lines.push(`  (No group activity yet)`);
    } else {
      for (const g of snap.groups) {
        lines.push(
          `  • *${g.groupName}*: ${g.wishesSent} sent (🎂${g.byType.birthday || 0} 🥂${g.byType.anniversary || 0} 🪔${g.byType.festival || 0}) | ${g.wishCandidatesDetected} detected | ${g.manualWishesDetected} manual`
        );
      }
    }

    if (snap.recentFaults.length > 0) {
      lines.push(``, `⚠️ *Recent Faults (last 3):*`);
      for (const f of snap.recentFaults.slice(0, 3)) {
        lines.push(`  • [${f.category}] ${f.message.slice(0, 80)} (${f.timestamp.slice(11, 19)} UTC)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Renders Prometheus text exposition format for /metrics scraping.
   */
  toPrometheus() {
    const snap = this.getSnapshot();
    const lines = [
      '# HELP whatsapp_bot_up Whether the WhatsApp WebSocket is currently open (1 = open, 0 = not open)',
      '# TYPE whatsapp_bot_up gauge',
      `whatsapp_bot_up ${snap.wsConnected ? 1 : 0}`,
      '# HELP whatsapp_ws_stuck_disconnected Whether the WebSocket disconnected and failed to reconnect (1 = stuck disconnected, 0 = healthy)',
      '# TYPE whatsapp_ws_stuck_disconnected gauge',
      `whatsapp_ws_stuck_disconnected ${snap.wsStuckDisconnected ? 1 : 0}`,
      '# HELP whatsapp_ws_downtime_seconds Seconds the WebSocket has currently been disconnected without reconnecting (0 when connected)',
      '# TYPE whatsapp_ws_downtime_seconds gauge',
      `whatsapp_ws_downtime_seconds ${snap.currentDowntimeSeconds}`,
      '# HELP whatsapp_ws_consecutive_reconnect_failures Current number of consecutive failed WebSocket reconnect attempts',
      '# TYPE whatsapp_ws_consecutive_reconnect_failures gauge',
      `whatsapp_ws_consecutive_reconnect_failures ${snap.consecutiveReconnectFailures}`,
      '# HELP whatsapp_ws_disconnects_total Total times the WhatsApp WebSocket disconnected',
      '# TYPE whatsapp_ws_disconnects_total counter',
      `whatsapp_ws_disconnects_total ${snap.totals.wsDisconnects}`,
      '# HELP whatsapp_ws_reconnect_success_total Total times the WhatsApp WebSocket successfully reconnected after a disconnect',
      '# TYPE whatsapp_ws_reconnect_success_total counter',
      `whatsapp_ws_reconnect_success_total ${snap.totals.wsReconnectSuccess}`,
      '# HELP whatsapp_ws_reconnect_failures_total Total failed WebSocket reconnect attempts',
      '# TYPE whatsapp_ws_reconnect_failures_total counter',
      `whatsapp_ws_reconnect_failures_total ${snap.totals.wsReconnectFailures}`,
      '# HELP whatsapp_ws_stuck_disconnected_alerts_total Total alerts emitted when WebSocket disconnected and failed to reconnect within threshold',
      '# TYPE whatsapp_ws_stuck_disconnected_alerts_total counter',
      `whatsapp_ws_stuck_disconnected_alerts_total ${snap.totals.wsStuckDisconnectedAlerts}`,
      '# HELP whatsapp_bot_uptime_seconds Bot process uptime in seconds',
      '# TYPE whatsapp_bot_uptime_seconds gauge',
      `whatsapp_bot_uptime_seconds ${snap.uptimeSeconds}`,
      '# HELP whatsapp_wishes_sent_total Total auto-wishes sent per group and event type',
      '# TYPE whatsapp_wishes_sent_total counter',
    ];

    for (const g of snap.groups) {
      const safeName = (g.groupName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      for (const [type, count] of Object.entries(g.byType || {})) {
        lines.push(
          `whatsapp_wishes_sent_total{group_id="${g.groupId}",group_name="${safeName}",event_type="${type}"} ${count}`
        );
      }
    }

    lines.push(
      '# HELP whatsapp_wish_candidates_total Total candidate wish messages detected per group',
      '# TYPE whatsapp_wish_candidates_total counter'
    );
    for (const g of snap.groups) {
      const safeName = (g.groupName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(
        `whatsapp_wish_candidates_total{group_id="${g.groupId}",group_name="${safeName}"} ${g.wishCandidatesDetected}`
      );
    }

    lines.push(
      '# HELP whatsapp_manual_wishes_total Total manual wishes sent by bot owner per group',
      '# TYPE whatsapp_manual_wishes_total counter'
    );
    for (const g of snap.groups) {
      const safeName = (g.groupName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(
        `whatsapp_manual_wishes_total{group_id="${g.groupId}",group_name="${safeName}"} ${g.manualWishesDetected}`
      );
    }

    lines.push(
      '# HELP whatsapp_faults_total Total faults and errors by category',
      '# TYPE whatsapp_faults_total counter'
    );
    for (const [cat, count] of Object.entries(snap.faultsByCategory)) {
      lines.push(`whatsapp_faults_total{category="${cat}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}
