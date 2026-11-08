import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikeWish, WishTracker } from '../src/wishDetector.js';
import { StateStore } from '../src/stateStore.js';

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
