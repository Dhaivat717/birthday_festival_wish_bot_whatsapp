import fs from 'fs';
import path from 'path';

export class MetricsStore {
  /**
   * Persistent observability store for tracking wishes per group, Gemini usage,
   * connection state, and faults/errors.
   * @param {string} dataDir
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'metrics.json');
    this.startedAt = new Date().toISOString();
    this.connectionStatus = 'starting';
    this.lastConnectedAt = null;
    this.reconnectCount = 0;

    this.data = {
      totals: {
        wishesSent: 0,
        wishCandidatesDetected: 0,
        manualWishesDetected: 0,
        cooldownSkips: 0,
        geminiCalls: 0,
        geminiFallbacks: 0,
        faultsTotal: 0,
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

  setConnectionStatus(status) {
    this.connectionStatus = status;
    if (status === 'open') {
      this.lastConnectedAt = new Date().toISOString();
    } else if (status === 'reconnecting') {
      this.reconnectCount += 1;
    }
  }

  recordWishCandidate(groupId, groupName, senderName) {
    this.data.totals.wishCandidatesDetected += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.wishCandidatesDetected += 1;
    this._emitStructured('METRIC', 'wish_candidate_detected', {
      groupId,
      groupName: g.groupName,
      senderName,
      groupCandidatesTotal: g.wishCandidatesDetected,
    });
    this._save();
  }

  recordManualWish(groupId, groupName, recordedKeys = []) {
    this.data.totals.manualWishesDetected += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.manualWishesDetected += 1;
    this._emitStructured('METRIC', 'manual_wish_detected', {
      groupId,
      groupName: g.groupName,
      recordedKeys,
      groupManualWishesTotal: g.manualWishesDetected,
    });
    this._save();
  }

  recordCooldownSkip(groupId, groupName, eventKey) {
    this.data.totals.cooldownSkips += 1;
    const g = this._ensureGroup(groupId, groupName);
    g.cooldownSkips += 1;
    this._emitStructured('METRIC', 'cooldown_skip', {
      groupId,
      groupName: g.groupName,
      eventKey,
      groupCooldownSkipsTotal: g.cooldownSkips,
    });
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

    this._emitStructured('METRIC', 'wish_sent', {
      groupId,
      groupName: g.groupName,
      targetName: targetName || eventKey,
      eventType: typeKey,
      eventKey,
      isDryRun,
      groupWishesSentTotal: g.wishesSent,
      globalWishesSentTotal: this.data.totals.wishesSent,
    });
    this._save();
  }

  recordFault(category, errorOrMessage, { groupId = null, groupName = null } = {}) {
    const nowIso = new Date().toISOString();
    const message =
      errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage || 'Unknown error');

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

    this._emitStructured('FAULT', category, {
      groupId,
      groupName,
      message,
      categoryFaultsTotal: this.data.faultsByCategory[category],
      globalFaultsTotal: this.data.totals.faultsTotal,
    });
    this._save();
  }

  _emitStructured(type, event, payload) {
    console.log(
      JSON.stringify({
        type,
        event,
        timestamp: new Date().toISOString(),
        ...payload,
      })
    );
  }

  getSnapshot() {
    const uptimeSeconds = Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000);
    const groupsArray = Object.values(this.data.groups).sort(
      (a, b) => b.wishesSent - a.wishesSent || b.wishCandidatesDetected - a.wishCandidatesDetected
    );
    return {
      status: this.connectionStatus,
      startedAt: this.startedAt,
      lastConnectedAt: this.lastConnectedAt,
      uptimeSeconds,
      reconnectCount: this.reconnectCount,
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
    const lines = [
      `📊 *WhatsApp Wish Bot Metrics*`,
      `• Status: ${snap.status === 'open' ? '🟢 Connected' : snap.status} (Uptime: ${hours}h)`,
      `• Total Wishes Sent: *${snap.totals.wishesSent}*`,
      `• Wish Messages Detected: ${snap.totals.wishCandidatesDetected}`,
      `• Manual Wishes by You: ${snap.totals.manualWishesDetected}`,
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
      `whatsapp_bot_up ${snap.status === 'open' ? 1 : 0}`,
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
