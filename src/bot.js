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

      if (config.allowedGroups.length === 0) {
        console.log('⚠️  ALLOWED_GROUPS is currently empty in .env! The bot will NOT reply in any group yet.');
        console.log('Here are your groups so you can add their names or IDs to ALLOWED_GROUPS in .env:');
        entries.slice(0, 30).forEach((g) => {
          console.log(`   - "${g.subject}" (${g.id})`);
        });
      } else {
        console.log(`🛡️  Whitelisted active groups (${whitelisted.length}):`);
        for (const g of whitelisted) {
          console.log(`   ✅ "${g.subject}" (${g.id})`);
        }
      }
      console.log(
        `⚙️  Rules: Trigger after ${config.minWishers} unique wishers within ${config.windowMinutes}m | Cooldown: ${config.cooldownHours}h (${(config.cooldownHours / 24).toFixed(1)} days)\n`
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

    // If YOU manually sent a wish in this group from your phone, cancel any pending auto-wish
    // and record cooldown so the bot won't send a redundant wish after you!
    if (msg.key.fromMe) {
      if (looksLikeWish(text)) {
        if (this.pendingTimers.has(remoteJid)) {
          clearTimeout(this.pendingTimers.get(remoteJid));
          this.pendingTimers.delete(remoteJid);
          console.log(`[Bot] Cancelled pending auto-wish in "${groupName}" because you manually wished.`);
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
    if (this.pendingTimers.has(remoteJid) || this.inFlightGroups.has(remoteJid)) {
      return; // Already analyzing or scheduled a reply for this group
    }

    this.inFlightGroups.add(remoteJid);
    try {
      const myJid = this.sock.user?.id || '';
      const myName = this.sock.user?.name || '';

      const analysis = await this.gemini.analyzeAndGenerateWish({
        groupName,
        messages: trackResult.recentMessages,
        myJid,
        myName,
      });

      if (!analysis.shouldWish || !analysis.replyText) {
        console.log(`🤖 [${groupName}] Skipped auto-wish: ${analysis.reasoning}`);
        return;
      }

      // Check 2-day (48h) cooldown for this group + eventKey
      const cooldownCheck = this.stateStore.canWish(remoteJid, analysis.eventKey);
      if (!cooldownCheck.allowed) {
        console.log(`⏳ [${groupName}] Cooldown active: ${cooldownCheck.reason}`);
        this.wishTracker.clearGroup(remoteJid);
        return;
      }

      // Schedule human-like random delay
      const delaySec =
        Math.floor(
          Math.random() * (config.maxDelaySeconds - config.minDelaySeconds + 1)
        ) + config.minDelaySeconds;

      console.log(
        `⏰ [${groupName}] Scheduled "${analysis.eventKey}" wish in ${delaySec}s: "${analysis.replyText}"`
      );

      const timer = setTimeout(async () => {
        this.pendingTimers.delete(remoteJid);
        try {
          // Double check cooldown right before sending
          const recheck = this.stateStore.canWish(remoteJid, analysis.eventKey);
          if (!recheck.allowed) return;

          // Simulate typing for 3 seconds for natural presence
          await this.sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise((r) => setTimeout(r, 3000));
          await this.sock.sendPresenceUpdate('paused', remoteJid);

          const payload = { text: analysis.replyText };
          if (analysis.targetJid && analysis.replyText.includes(`@${analysis.targetJid.split('@')[0]}`)) {
            payload.mentions = [analysis.targetJid];
          }

          await this.sock.sendMessage(remoteJid, payload);
          this.stateStore.recordWish(remoteJid, analysis.eventKey);
          this.wishTracker.clearGroup(remoteJid);

          console.log(
            `✅ [${groupName}] Sent auto-wish (${analysis.eventKey}): "${analysis.replyText}" (Next wish allowed after ${config.cooldownHours}h)`
          );
        } catch (sendErr) {
          console.error(`[Bot] Failed to send wish in "${groupName}":`, sendErr.message);
        }
      }, delaySec * 1000);

      this.pendingTimers.set(remoteJid, timer);
    } finally {
      this.inFlightGroups.delete(remoteJid);
    }
  }
}
