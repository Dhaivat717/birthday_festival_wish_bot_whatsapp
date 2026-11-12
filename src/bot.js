import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { config } from './config.js';
import { StateStore } from './stateStore.js';
import { WishTracker, looksLikeWish } from './wishDetector.js';
import { GeminiWishService } from './geminiService.js';
import { MetricsStore } from './metricsStore.js';

export class WhatsAppWishBot {
  constructor() {
    this.authDir = path.join(config.dataDir, 'auth_info_baileys');
    fs.mkdirSync(this.authDir, { recursive: true });

    this.metrics = new MetricsStore(config.dataDir);

    this.stateStore = new StateStore(config.dataDir, {
      cooldownHours: config.cooldownHours,
      groupGlobalCooldownHours: config.groupGlobalCooldownHours,
    });

    this.wishTracker = new WishTracker({
      minWishers: config.minWishers,
      windowMinutes: config.windowMinutes,
    });

    this.gemini = new GeminiWishService({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      userStylePrompt: config.userStylePrompt,
      maxDailyCalls: config.maxDailyGeminiCalls,
      metrics: this.metrics,
    });

    // Cache of groupId -> groupSubject (name)
    this.groupNames = new Map();
    // Map of groupId -> Timeout ID for pending delayed wishes
    this.pendingTimers = new Map();
    // Set of groupIds currently being analyzed by Gemini to avoid concurrent duplicate triggers
    this.inFlightGroups = new Set();
    // Set of message IDs sent by the bot itself so it never reacts to its own auto-replies
    this.sentByBotIds = new Set();
    this.sock = null;
    this.pairingRequested = false;
    this.reconnectTimer = null;
    this.connectAttemptTimeout = null;
    this.wsWatchdogTimer = null;
    this.lastKnownVersion = null;
  }

  _scheduleReconnect(delayMs = 5000) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        this.metrics.recordWsStuckDisconnected({
          reason: `Reconnect start() threw: ${err.message}`,
          countAsAttemptFailure: true,
        });
        this._scheduleReconnect(10000);
      }
    }, delayMs);
  }

  _startWsWatchdog() {
    if (this.wsWatchdogTimer) return;
    // Check after 60s if the WebSocket is still disconnected, and every 2 minutes thereafter while unrecovered
    this.wsWatchdogTimer = setInterval(() => {
      if (this.metrics.connectionStatus !== 'open') {
        this.metrics.recordWsStuckDisconnected({
          reason: 'WebSocket remained disconnected past 60s watchdog threshold',
          countAsAttemptFailure: false,
        });
      } else {
        this._clearWsWatchdog();
      }
    }, 60000);
  }

  _clearWsWatchdog() {
    if (this.wsWatchdogTimer) {
      clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = null;
    }
    if (this.connectAttemptTimeout) {
      clearTimeout(this.connectAttemptTimeout);
      this.connectAttemptTimeout = null;
    }
  }

  /**
   * Checks if a group is whitelisted in ALLOWED_GROUPS by JID or case-insensitive name match.
   */
  isGroupAllowed(groupId, groupName = '') {
    if (!config.allowedGroups || config.allowedGroups.length === 0) {
      return false;
    }
    const lowerName = (groupName || '').toLowerCase();
    return config.allowedGroups.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p === '*') return true;
      if (groupId.toLowerCase() === p) return true;
      if (lowerName && lowerName.includes(p)) return true;
      return false;
    });
  }

  /**
   * Extracts plain text and mentioned JIDs from a Baileys WAMessage object.
   */
  extractMessageDetails(msg) {
    const m = msg.message;
    if (!m) return { text: '', mentionedJids: [] };

    const text =
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      '';

    const contextInfo =
      m.extendedTextMessage?.contextInfo ||
      m.imageMessage?.contextInfo ||
      m.videoMessage?.contextInfo ||
      {};

    const mentionedJids = contextInfo.mentionedJid || [];
    return { text, mentionedJids };
  }

  async start() {
    // If a previous pairing code attempt timed out before finishing registration,
    // clear the incomplete auth folder so the next pairing code or seed starts fresh.
    const credsFile = path.join(this.authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        if (creds && creds.registered === false) {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          fs.mkdirSync(this.authDir, { recursive: true });
        }
      } catch {
        // ignore parse errors
      }
    }

    // Bootstrap pre-linked local WhatsApp session onto the cloud volume if AUTH_SEED_B64 is provided
    if (!fs.existsSync(credsFile) && process.env.AUTH_SEED_B64) {
      try {
        const rawJson = zlib.gunzipSync(Buffer.from(process.env.AUTH_SEED_B64, 'base64')).toString('utf8');
        const fileMap = JSON.parse(rawJson);
        fs.mkdirSync(this.authDir, { recursive: true });
        for (const [filename, content] of Object.entries(fileMap)) {
          fs.writeFileSync(path.join(this.authDir, filename), content, 'utf8');
        }
        console.log(`🔑 Restored ${Object.keys(fileMap).length} WhatsApp auth files from AUTH_SEED_B64 onto volume!`);
      } catch (seedErr) {
        console.error('[Bot] Failed to restore AUTH_SEED_B64:', seedErr.message);
      }
    }

    // Clean up any previous socket instance before opening a new one
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.ws?.close();
      } catch {
        // ignore cleanup errors
      }
      this.sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version = this.lastKnownVersion;
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched?.version) {
        version = fetched.version;
        this.lastKnownVersion = version;
      }
    } catch (verErr) {
      console.warn('[Bot] Could not fetch latest Baileys version, using cached/fallback:', verErr.message);
      version = version || [2, 3000, 1015901307];
    }

    // Start the watchdog while connecting/reconnecting so we emit a metric if the WebSocket fails to connect within 60s
    this._startWsWatchdog();

    // Guard against a single socket attempt hanging silently in 'connecting' state for >45s
    if (this.connectAttemptTimeout) {
      clearTimeout(this.connectAttemptTimeout);
    }
    this.connectAttemptTimeout = setTimeout(() => {
      if (this.metrics.connectionStatus !== 'open') {
        this.metrics.recordWsStuckDisconnected({
          reason: 'WebSocket handshake timed out after 45s without opening',
          countAsAttemptFailure: true,
        });
        this._scheduleReconnect(3000);
      }
    }, 45000);

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, // Keeps your normal phone push notifications working smoothly
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Optional: Phone pairing code support (ideal for headless cloud servers like Railway/Fly.io/VPS)
    if (!this.sock.authState.creds.registered && config.pairingPhoneNumber && !this.pairingRequested) {
      this.pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(config.pairingPhoneNumber);
          console.log('\n======================================================');
          console.log(`📱 WHATSAPP PAIRING CODE FOR +${config.pairingPhoneNumber}: ${code}`);
          console.log('Open WhatsApp on your phone -> Linked Devices -> Link a Device -> Link with phone number instead');
          console.log('======================================================\n');
        } catch (err) {
          console.error('[Bot] Failed to request pairing code:', err.message);
        }
      }, 4000);
    }

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !config.pairingPhoneNumber) {
        console.log('\n📱 Scan this QR code in WhatsApp (Settings -> Linked Devices -> Link a Device):');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        if (this.connectAttemptTimeout) {
          clearTimeout(this.connectAttemptTimeout);
          this.connectAttemptTimeout = null;
        }
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reasonMsg = lastDisconnect?.error?.message || '';
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(
          `[Bot] Connection closed (status: ${statusCode}).`
        );
        this.metrics.recordWsDisconnect({
          statusCode: statusCode ?? 'unknown',
          reason: reasonMsg,
          isLoggedOut,
        });
        this._startWsWatchdog();
        if (isLoggedOut) {
          console.log('[Bot] Session logged out or pairing expired. Clearing auth state and requesting a fresh link in 5s...');
          fs.rmSync(this.authDir, { recursive: true, force: true });
          fs.mkdirSync(this.authDir, { recursive: true });
        }
        this.pairingRequested = false;
        this._scheduleReconnect(5000);
      } else if (connection === 'open') {
        this._clearWsWatchdog();
        this.metrics.setConnectionOpen();
        console.log('\n✅ Connected to WhatsApp!');
        await this.refreshGroupMetadata();
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await this.handleIncomingMessage(msg).catch((err) => {
          console.error('[Bot] Error handling message:', err);
          this.metrics.recordFault('message_handler_error', err);
        });
      }
    });
  }

  async refreshGroupMetadata() {
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const entries = Object.values(groups);
      for (const g of entries) {
        this.groupNames.set(g.id, g.subject);
      }

      console.log(`\n📋 Found ${entries.length} WhatsApp groups.`);
      const whitelisted = entries.filter((g) => this.isGroupAllowed(g.id, g.subject));
      this.metrics.registerGroups(whitelisted);

      // Also save all groups to data/groups_list.txt for easy searching
      const groupLines = entries.map((g, idx) => `${idx + 1}. "${g.subject}" (${g.id})`);
      const groupsFilePath = path.join(config.dataDir, 'groups_list.txt');
      fs.writeFileSync(groupsFilePath, groupLines.join('\n') + '\n', 'utf8');

      if (config.allowedGroups.length === 0) {
        console.log('⚠️  ALLOWED_GROUPS is currently empty in .env! The bot will NOT reply in any group yet.');
        console.log(`Here are all ${entries.length} of your groups (also saved to ${groupsFilePath}):`);
        entries.forEach((g, idx) => {
          console.log(`   ${idx + 1}. "${g.subject}" (${g.id})`);
        });
      } else {
        console.log(`🛡️  Whitelisted active groups (${whitelisted.length}):`);
        for (const g of whitelisted) {
          console.log(`   ✅ "${g.subject}" (${g.id})`);
        }
      }
      console.log(
        `⚙️  Rules: Trigger after ${config.minWishers} unique wishers within ${config.windowMinutes}m | Cooldown: ${config.cooldownHours}h (${(config.cooldownHours / 24).toFixed(1)} days) | Mode: ${config.dryRun ? '🧪 DRY RUN (Logs only, no messages sent)' : '🟢 LIVE'}\n`
      );
    } catch (err) {
      console.error('[Bot] Could not fetch group list:', err.message);
    }
  }

  async getGroupName(groupId) {
    if (this.groupNames.has(groupId)) {
      return this.groupNames.get(groupId);
    }
    try {
      const meta = await this.sock.groupMetadata(groupId);
      if (meta?.subject) {
        this.groupNames.set(groupId, meta.subject);
        return meta.subject;
      }
    } catch {
      // Ignore metadata lookup errors
    }
    return groupId;
  }

  async handleIncomingMessage(msg) {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;

    const { text, mentionedJids } = this.extractMessageDetails(msg);
    if (!text) return;

    // Never react to a message that the bot itself just sent!
    if (msg.key?.id && this.sentByBotIds.has(msg.key.id)) {
      return;
    }

    // Allow sending "!stats" or "!metrics" in your own "Message Yourself" chat to get live metrics on WhatsApp!
    if (!remoteJid.endsWith('@g.us')) {
      if (msg.key?.fromMe && /^!(?:stats|metrics|status)\b/i.test(text.trim())) {
        const summary = this.metrics.formatWhatsAppSummary();
        const sent = await this.sock.sendMessage(remoteJid, { text: summary });
        if (sent?.key?.id) this.sentByBotIds.add(sent.key.id);
      }
      return;
    }

    const groupName = await this.getGroupName(remoteJid);
    if (!this.isGroupAllowed(remoteJid, groupName)) {
      return;
    }

    // If YOU manually sent a wish in this group from your phone (and self-triggering is not enabled),
    // cancel any pending auto-wish AND add that person/event + group to the 48h cooldown!
    if (msg.key.fromMe && !config.dryRun && !config.allowSelfTrigger) {
      if (looksLikeWish(text)) {
        const recordedKeys = new Set();

        for (const [timerKey, timer] of this.pendingTimers.entries()) {
          if (timerKey.startsWith(`${remoteJid}::`)) {
            clearTimeout(timer);
            this.pendingTimers.delete(timerKey);
            const pendingEventKey = timerKey.slice(`${remoteJid}::`.length);
            this.stateStore.recordWish(remoteJid, pendingEventKey);
            recordedKeys.add(pendingEventKey);
            console.log(
              `[Bot] Cancelled pending auto-wish (${pendingEventKey}) in "${groupName}" because you manually wished.`
            );
          }
        }

        const recentMessages = this.wishTracker.buffers.get(remoteJid) || [];
        const manualKeys = this.gemini.extractManualWishKeys({
          text,
          mentionedJids,
          recentMessages,
        });
        for (const k of manualKeys) {
          const normKey = StateStore.normalizeKey(k);
          this.stateStore.recordWish(remoteJid, normKey);
          recordedKeys.add(normKey);
        }

        this.metrics.recordManualWish(remoteJid, groupName, [...recordedKeys]);
        console.log(
          `🛑 [${groupName}] Detected manual wish from you ("${text}"). Added [${[...recordedKeys].join(', ') || 'manual_wish'}] to ${config.cooldownHours}h cooldown.`
        );
        this.wishTracker.clearGroup(remoteJid);
      }
      return;
    }

    const isSelfTest = Boolean(msg.key.fromMe && (config.dryRun || config.allowSelfTrigger));
    const senderJid = isSelfTest
      ? 'dryrun_tester@s.whatsapp.net'
      : msg.key.participant || msg.participant || '';
    const senderName = isSelfTest
      ? 'Group Member'
      : msg.pushName || senderJid.split('@')[0];

    const trackResult = this.wishTracker.addMessage({
      groupId: remoteJid,
      senderJid,
      senderName,
      text,
      mentionedJids,
    });

    if (!trackResult.matched) return;

    this.metrics.recordWishCandidate(remoteJid, groupName, senderName);
    console.log(
      `💬 [${groupName}] Wish detected from ${senderName}: "${text}" (${trackResult.uniqueWisherCount}/${config.minWishers} wishers in window)`
    );

    if (!trackResult.readyToTrigger) return;
    if (this.inFlightGroups.has(remoteJid)) {
      return; // Already analyzing this group
    }

    this.inFlightGroups.add(remoteJid);
    try {
      const myJid = this.sock.user?.id || '';
      const myName = this.sock.user?.name || '';

      // Gather all people/events already wished in this group today (or currently scheduled)
      const alreadyWishedEvents = [
        ...this.stateStore.getActiveEventsForGroup(remoteJid),
        ...[...this.pendingTimers.keys()]
          .filter((k) => k.startsWith(`${remoteJid}::`))
          .map((k) => k.slice(`${remoteJid}::`.length)),
      ];

      const analysis = await this.gemini.analyzeAndGenerateWish({
        groupName,
        messages: trackResult.recentMessages,
        myJid,
        myName,
        alreadyWishedEvents,
        minWishers: config.minWishers,
      });

      // Clear the current window buffer so subsequent messages require a fresh pair of wishers
      this.wishTracker.clearGroup(remoteJid);

      if (!analysis.shouldWish || !analysis.replyText) {
        console.log(`🤖 [${groupName}] Skipped auto-wish: ${analysis.reasoning}`);
        return;
      }

      const normEventKey = StateStore.normalizeKey(analysis.eventKey);
      const timerKey = `${remoteJid}::${normEventKey}`;
      if (this.pendingTimers.has(timerKey)) {
        return;
      }

      // Check 2-day (48h) cooldown for this group + specific person/eventKey
      const cooldownCheck = this.stateStore.canWish(remoteJid, normEventKey);
      if (!cooldownCheck.allowed) {
        this.metrics.recordCooldownSkip(remoteJid, groupName, normEventKey);
        console.log(`⏳ [${groupName}] Cooldown active: ${cooldownCheck.reason}`);
        return;
      }

      // Schedule human-like random delay
      const delaySec =
        Math.floor(
          Math.random() * (config.maxDelaySeconds - config.minDelaySeconds + 1)
        ) + config.minDelaySeconds;

      console.log(
        `⏰ [${groupName}] Scheduled "${normEventKey}" wish in ${delaySec}s: "${analysis.replyText}"`
      );

      const timer = setTimeout(async () => {
        this.pendingTimers.delete(timerKey);
        try {
          // Double check cooldown right before sending
          const recheck = this.stateStore.canWish(remoteJid, normEventKey);
          if (!recheck.allowed) return;

          if (config.dryRun) {
            console.log(
              `🧪 [DRY RUN] [${groupName}] Would have sent wish (${normEventKey}): "${analysis.replyText}"`
            );
            this.stateStore.recordWish(remoteJid, normEventKey);
            this.metrics.recordWishSent({
              groupId: remoteJid,
              groupName,
              targetName: analysis.targetName || normEventKey,
              eventType: analysis.eventType,
              eventKey: normEventKey,
              replyText: analysis.replyText,
              isDryRun: true,
            });
            await this.notifySelf({
              targetName: analysis.targetName || normEventKey,
              replyText: analysis.replyText,
              groupName,
              isDryRun: true,
            });
            return;
          }

          // Simulate typing for 3 seconds for natural presence
          await this.sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise((r) => setTimeout(r, 3000));
          await this.sock.sendPresenceUpdate('paused', remoteJid);

          const payload = { text: analysis.replyText };
          if (analysis.targetJid && analysis.replyText.includes(`@${analysis.targetJid.split('@')[0]}`)) {
            payload.mentions = [analysis.targetJid];
          }

          // Record cooldown BEFORE sending so the outgoing message upsert never re-triggers
          this.stateStore.recordWish(remoteJid, normEventKey);

          const sentMsg = await this.sock.sendMessage(remoteJid, payload);
          if (sentMsg?.key?.id) {
            this.sentByBotIds.add(sentMsg.key.id);
          }

          this.metrics.recordWishSent({
            groupId: remoteJid,
            groupName,
            targetName: analysis.targetName || normEventKey,
            eventType: analysis.eventType,
            eventKey: normEventKey,
            replyText: analysis.replyText,
            isDryRun: false,
          });

          console.log(
            `✅ [${groupName}] Sent auto-wish (${normEventKey}): "${analysis.replyText}" (Next wish for ${normEventKey} allowed after ${config.cooldownHours}h)`
          );

          await this.notifySelf({
            targetName: analysis.targetName || normEventKey,
            replyText: analysis.replyText,
            groupName,
            isDryRun: false,
          });
        } catch (sendErr) {
          console.error(`[Bot] Failed to send wish in "${groupName}":`, sendErr.message);
          this.metrics.recordFault('send_message_error', sendErr, {
            groupId: remoteJid,
            groupName,
          });
        }
      }, delaySec * 1000);

      this.pendingTimers.set(timerKey, timer);
    } finally {
      this.inFlightGroups.delete(remoteJid);
    }
  }

  /**
   * Sends a confirmation message to your own WhatsApp "Message Yourself" chat
   * right after the bot wishes someone in a group.
   */
  async notifySelf({ targetName, replyText, groupName, isDryRun = false }) {
    try {
      const rawMyId = this.sock?.user?.id;
      if (!rawMyId) return;
      const mySelfJid = `${rawMyId.split(':')[0].split('@')[0]}@s.whatsapp.net`;
      const prefix = isDryRun ? '🧪 [DRY RUN] ' : '🤖 ';
      const summary = `${prefix}Wished ${targetName} "${replyText}" in group chat "${groupName}"`;
      await this.sock.sendMessage(mySelfJid, { text: summary });
      console.log(`📩 Sent self-notification to your WhatsApp: ${summary}`);
    } catch (err) {
      console.warn('[Bot] Could not send self-notification DM:', err.message);
    }
  }
}
