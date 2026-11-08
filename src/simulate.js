import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config.js';
import { WishTracker } from './wishDetector.js';
import { GeminiWishService } from './geminiService.js';
import { StateStore } from './stateStore.js';

async function runSimulation() {
  console.log('🧪 Starting Local Simulation of WhatsApp Wish Bot...\n');
  console.log(
    `🔑 Gemini API Key configured: ${config.geminiApiKey ? 'YES (Using live Gemini AI)' : 'NO (Using built-in template fallback)'}`
  );

  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbot-sim-'));
  const stateStore = new StateStore(tmpDataDir, { cooldownHours: config.cooldownHours });
  const tracker = new WishTracker({ minWishers: 2, windowMinutes: 45 });
  const gemini = new GeminiWishService({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    userStylePrompt: config.userStylePrompt,
    maxDailyCalls: config.maxDailyGeminiCalls,
  });

  const groupId = '120363099999999@g.us';
  const groupName = 'College Friends';

  const simulatedMessages = [
    { senderJid: '111@s.whatsapp.net', senderName: 'Aman', text: 'Hey guys, is the meeting at 4?' },
    {
      senderJid: '222@s.whatsapp.net',
      senderName: 'Priya',
      text: 'Happy Birthday @919876543210 !! Have an amazing year ahead Rahul 🎂🥳',
      mentionedJids: ['919876543210@s.whatsapp.net'],
    },
    {
      senderJid: '333@s.whatsapp.net',
      senderName: 'Karan',
      text: 'Many many happy returns of the day Rahul! 🥳🎉',
      mentionedJids: ['919876543210@s.whatsapp.net'],
    },
    {
      senderJid: '444@s.whatsapp.net',
      senderName: 'Neha',
      text: 'Happy birthday Rahul! 🎂',
      mentionedJids: ['919876543210@s.whatsapp.net'],
    },
  ];

  for (const msg of simulatedMessages) {
    console.log(`\n📨 Incoming message in [${groupName}] from ${msg.senderName}: "${msg.text}"`);
    const res = tracker.addMessage({
      groupId,
      senderJid: msg.senderJid,
      senderName: msg.senderName,
      text: msg.text,
      mentionedJids: msg.mentionedJids || [],
    });

    if (!res.matched) {
      console.log('   ↳ Ignored (not a wish)');
      continue;
    }

    console.log(`   ↳ Wish detected! Unique wishers in window: ${res.uniqueWisherCount}/2`);

    if (res.readyToTrigger) {
      const analysis = await gemini.analyzeAndGenerateWish({
        groupName,
        messages: res.recentMessages,
        myJid: '19998887777@s.whatsapp.net',
        myName: 'Dhaivat',
      });

      console.log('   🤖 Analysis result:', JSON.stringify(analysis, null, 2));

      const cooldown = stateStore.canWish(groupId, analysis.eventKey);
      if (!cooldown.allowed) {
        console.log(`   ⏳ Blocked by 2-day cooldown: ${cooldown.reason}`);
      } else if (analysis.shouldWish) {
        console.log(`   ✅ Bot Replies: "${analysis.replyText}"`);
        stateStore.recordWish(groupId, analysis.eventKey);
        tracker.clearGroup(groupId);
      }
    }
  }

  // Test that a 4th wisher 10 minutes later is blocked by the 48-hour cooldown
  console.log('\n--- Simulating another wish for Rahul 10 minutes later (testing 48h cooldown) ---');
  tracker.addMessage({
    groupId,
    senderJid: '555@s.whatsapp.net',
    senderName: 'Vikram',
    text: 'Happy Birthday Rahul 🎂',
    mentionedJids: ['919876543210@s.whatsapp.net'],
  });
  const res2 = tracker.addMessage({
    groupId,
    senderJid: '666@s.whatsapp.net',
    senderName: 'Sneha',
    text: 'HBD Rahul!! 🥳',
    mentionedJids: ['919876543210@s.whatsapp.net'],
  });
  if (res2.readyToTrigger) {
    const analysis2 = await gemini.analyzeAndGenerateWish({
      groupName,
      messages: res2.recentMessages,
      myJid: '19998887777@s.whatsapp.net',
      myName: 'Dhaivat',
    });
    const cooldown2 = stateStore.canWish(groupId, analysis2.eventKey);
    console.log(`   ⏳ Cooldown check for "${analysis2.eventKey}":`, cooldown2);
  }

  fs.rmSync(tmpDataDir, { recursive: true, force: true });
}

runSimulation().catch(console.error);

