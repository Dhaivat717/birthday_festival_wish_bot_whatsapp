import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { StateStore } from './stateStore.js';
import { WishTracker, looksLikeWish } from './wishDetector.js';
import { GeminiWishService } from './geminiService.js';

export class WhatsAppWishBot {
  constructor() {
    this.authDir = path.join(config.dataDir, 'auth_info_baileys');
    fs.mkdirSync(this.authDir, { recursive: true });

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
    });

    // Cache of groupId -> groupSubject (name)
    this.groupNames = new Map();
    // Map of groupId -> Timeout ID for pending delayed wishes
    this.pendingTimers = new Map();
    // Set of groupIds currently being analyzed by Gemini to avoid concurrent duplicate triggers
    this.inFlightGroups = new Set();
    this.sock = null;
    this.pairingRequested = false;
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
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

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
      }, 3000);
    }

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !config.pairingPhoneNumber) {
        console.log('\n📱 Scan this QR code in WhatsApp (Settings -> Linked Devices -> Link a Device):');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(
          `[Bot] Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`
        );
        if (shouldReconnect) {
          this.pairingRequested = false;
          setTimeout(() => this.start(), 4000);
        } else {
          console.log('[Bot] Logged out from WhatsApp. Delete data/auth_info_baileys and restart to re-link.');
        }
      } else if (connection === 'open') {
        console.log('\n✅ Connected to WhatsApp!');
        await this.refreshGroupMetadata();
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await this.handleIncomingMessage(msg).catch((err) => {
          console.error('[Bot] Error handling message:', err);
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
    if (!remoteJid || !remoteJid.endsWith('@g.us')) return; // Only group chats

    const { text, mentionedJids } = this.extractMessageDetails(msg);
    if (!text) return;

    const groupName = await this.getGroupName(remoteJid);
    if (!this.isGroupAllowed(remoteJid, groupName)) {
      return;
    }

    // If YOU manually sent a wish in this group from your phone, cancel any pending auto-wish for this group
    if (msg.key.fromMe) {
      if (looksLikeWish(text)) {
        for (const [timerKey, timer] of this.pendingTimers.entries()) {
          if (timerKey.startsWith(`${remoteJid}::`)) {
            clearTimeout(timer);
            this.pendingTimers.delete(timerKey);
            console.log(`[Bot] Cancelled pending auto-wish (${timerKey}) in "${groupName}" because you manually wished.`);
          }
        }
        this.wishTracker.clearGroup(remoteJid);
      }
      return;
    }

    const senderJid = msg.key.participant || msg.participant || '';
    const senderName = msg.pushName || senderJid.split('@')[0];

    const trackResult = this.wishTracker.addMessage({
      groupId: remoteJid,
      senderJid,
      senderName,
      text,
      mentionedJids,
    });

    if (!trackResult.matched) return;

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

          await this.sock.sendMessage(remoteJid, payload);
          this.stateStore.recordWish(remoteJid, normEventKey);

          console.log(
            `✅ [${groupName}] Sent auto-wish (${normEventKey}): "${analysis.replyText}" (Next wish for ${normEventKey} allowed after ${config.cooldownHours}h)`
          );
        } catch (sendErr) {
          console.error(`[Bot] Failed to send wish in "${groupName}":`, sendErr.message);
        }
      }, delaySec * 1000);

      this.pendingTimers.set(timerKey, timer);
    } finally {
      this.inFlightGroups.delete(remoteJid);
    }
  }
}
