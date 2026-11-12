import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikeWish, WishTracker } from '../src/wishDetector.js';
import { StateStore } from '../src/stateStore.js';
import { GeminiWishService } from '../src/geminiService.js';
import { MetricsStore } from '../src/metricsStore.js';

test('looksLikeWish detects birthdays, festivals, and ignores normal chat', () => {
  assert.equal(looksLikeWish('Happy birthday Rahul!! 🎂🥳'), true);
  assert.equal(looksLikeWish('HBD bro!'), true);
  assert.equal(looksLikeWish('Many many happy returns of the day @919876543210'), true);
  assert.equal(looksLikeWish('Happy Diwali to everyone and your family! 🪔'), true);
  assert.equal(looksLikeWish('Eid Mubarak everyone! 🌙'), true);
  assert.equal(looksLikeWish('Merry Christmas! 🎄'), true);
  assert.equal(looksLikeWish('Are we meeting at 5pm tomorrow?'), false);
  assert.equal(looksLikeWish('Please send the report PDF'), false);
});

test('WishTracker waits for N unique wishers within the sliding window', () => {
  const tracker = new WishTracker({ minWishers: 2, windowMinutes: 45 });
  const groupId = '12345@g.us';
  const now = 1_700_000_000_000;

  // 1st wisher
  const r1 = tracker.addMessage({
    groupId,
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    text: 'Happy Birthday Rohan! 🎂',
    timestamp: now,
  });
  assert.equal(r1.matched, true);
  assert.equal(r1.uniqueWisherCount, 1);
  assert.equal(r1.readyToTrigger, false);

  // Same wisher sends a second message -> still 1 unique wisher
  const r2 = tracker.addMessage({
    groupId,
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    text: 'Have a great year ahead🥳',
    timestamp: now + 5000,
  });
  assert.equal(r2.uniqueWisherCount, 1);
  assert.equal(r2.readyToTrigger, false);

  // 2nd unique wisher -> triggers!
  const r3 = tracker.addMessage({
    groupId,
    senderJid: 'bob@s.whatsapp.net',
    senderName: 'Bob',
    text: 'Many happy returns of the day Rohan!',
    timestamp: now + 15000,
  });
  assert.equal(r3.matched, true);
  assert.equal(r3.uniqueWisherCount, 2);
  assert.equal(r3.readyToTrigger, true);
});

test('StateStore enforces at least 2-day (48h) cooldown before wishing again', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbot-test-'));
  try {
    const store = new StateStore(tmpDir, { cooldownHours: 48, groupGlobalCooldownHours: 48 });
    const groupId = 'family@g.us';
    const eventKey = 'birthday:rohan';
    const t0 = 1_700_000_000_000;

    // Initially allowed
    assert.equal(store.canWish(groupId, eventKey, t0).allowed, true);

    // Record wish at t0
    store.recordWish(groupId, eventKey, t0);

    // 24 hours later (1 day) -> blocked (needs 48h = 2 days)
    const t24h = t0 + 24 * 3600 * 1000;
    const check1 = store.canWish(groupId, eventKey, t24h);
    assert.equal(check1.allowed, false);

    // 49 hours later (> 2 days) -> allowed again!
    const t49h = t0 + 49 * 3600 * 1000;
    const check2 = store.canWish(groupId, eventKey, t49h);
    assert.equal(check2.allowed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore allows multiple people to have birthdays on the same day in the same group', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbot-multi-'));
  try {
    const store = new StateStore(tmpDir, { cooldownHours: 48 });
    const groupId = '120363156175890746@g.us';
    const t0 = 1_700_000_000_000;

    // 1. Wish Rahul in this group
    store.recordWish(groupId, 'birthday:rahul', t0);

    // 10 minutes later on the SAME day:
    const t10m = t0 + 10 * 60 * 1000;

    // Rahul is on cooldown in this group:
    assert.equal(store.canWish(groupId, 'birthday:rahul', t10m).allowed, false);
    assert.deepEqual(store.getActiveEventsForGroup(groupId, t10m), ['birthday:rahul']);

    // Priya ALSO has a birthday on the same day in the SAME group -> allowed!
    assert.equal(store.canWish(groupId, 'birthday:priya', t10m).allowed, true);

    // Rahul in a DIFFERENT group -> also allowed independently!
    assert.equal(store.canWish('other_group@g.us', 'birthday:rahul', t10m).allowed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Manual wish from user extracts person/event keys and adds them to group cooldown', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbot-manual-'));
  try {
    const store = new StateStore(tmpDir, { cooldownHours: 48 });
    const gemini = new GeminiWishService({ apiKey: '' });
    const groupId = '120363380053782639@g.us';

    const keys = gemini.extractManualWishKeys({
      text: 'Happy birthday @919876543210 Krunal! 🎂',
      mentionedJids: ['919876543210@s.whatsapp.net'],
      recentMessages: [],
    });

    assert.equal(keys.includes('birthday:919876543210@s.whatsapp.net'), true);
    assert.equal(keys.includes('birthday:krunal'), true);

    for (const k of keys) {
      store.recordWish(groupId, k);
    }

    assert.equal(store.canWish(groupId, 'birthday:919876543210@s.whatsapp.net').allowed, false);
    assert.equal(store.canWish(groupId, 'birthday:krunal').allowed, false);
    // Another person in the same group is still allowed:
    assert.equal(store.canWish(groupId, 'birthday:deep').allowed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MetricsStore tracks wishes per group, faults, and exports Prometheus & WhatsApp summaries', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbot-metrics-'));
  try {
    const metrics = new MetricsStore(tmpDir);
    metrics.registerGroups([{ id: '120363380053782639@g.us', subject: 'JC RU' }]);
    metrics.setConnectionStatus('open');

    metrics.recordWishCandidate('120363380053782639@g.us', 'JC RU', 'Alice');
    metrics.recordWishSent({
      groupId: '120363380053782639@g.us',
      groupName: 'JC RU',
      targetName: 'Krunal',
      eventType: 'birthday',
      eventKey: 'birthday:krunal',
      replyText: 'Happy Birthday Krunal! 🎂',
      isDryRun: false,
    });
    metrics.recordFault('gemini_error', new Error('Quota exceeded'), {
      groupId: '120363380053782639@g.us',
      groupName: 'JC RU',
    });

    const snap = metrics.getSnapshot();
    assert.equal(snap.totals.wishesSent, 1);
    assert.equal(snap.totals.faultsTotal, 1);
    assert.equal(snap.groups[0].wishesSent, 1);
    assert.equal(snap.groups[0].byType.birthday, 1);

    const prom = metrics.toPrometheus();
    assert.equal(prom.includes('whatsapp_wishes_sent_total{group_id="120363380053782639@g.us",group_name="JC RU",event_type="birthday"} 1'), true);
    assert.equal(prom.includes('whatsapp_faults_total{category="gemini_error"} 1'), true);

    const waSummary = metrics.formatWhatsAppSummary();
    assert.equal(waSummary.includes('JC RU'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
