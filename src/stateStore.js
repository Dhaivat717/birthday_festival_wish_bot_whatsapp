import fs from 'fs';
import path from 'path';

export class StateStore {
  /**
   * Stores cooldown timestamps per (groupId, person/eventKey) in memory (Map)
   * and syncs to disk so restarts don't lose the 48h state.
   * @param {string} dataDir Directory to persist state JSON
   * @param {object} options
   * @param {number} options.cooldownHours Minimum hours before wishing the same person/event in the same group again (default 48h = 2 days)
   */
  constructor(dataDir, { cooldownHours = 48 } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'wish_history.json');
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    // In-memory Map: `${groupId}::${normalizedEventKey}` -> timestamp (ms)
    this.events = new Map();
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = parsed.events || {};
        for (const [k, ts] of Object.entries(entries)) {
          this.events.set(k, Number(ts));
        }
        this._pruneOldEntries();
      }
    } catch (err) {
      console.error('[StateStore] Failed to load state file, starting fresh:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const obj = { events: Object.fromEntries(this.events.entries()) };
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[StateStore] Failed to save state file:', err.message);
    }
  }

  static normalizeKey(key) {
    return String(key || 'general')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
  }

  /**
   * Returns all active (currently on cooldown) eventKeys in a specific group.
   * Useful when multiple people have a birthday on the same day in the same group!
   * @param {string} groupId
   * @param {number} [now]
   * @returns {string[]} e.g. ['birthday:rahul', 'birthday:919876543210@s.whatsapp.net']
   */
  getActiveEventsForGroup(groupId, now = Date.now()) {
    this._pruneOldEntries(now);
    const prefix = `${groupId}::`;
    const active = [];
    for (const [compositeKey, ts] of this.events.entries()) {
      if (compositeKey.startsWith(prefix) && now - ts < this.cooldownMs) {
        active.push(compositeKey.slice(prefix.length));
      }
    }
    return active;
  }

  /**
   * Checks whether we are allowed to send a wish for this specific (groupId, person/eventKey).
   * Enforces the >= 2-day (48h) cooldown per group per person/event.
   * @param {string} groupId
   * @param {string} eventKey
   * @param {number} [now]
   * @returns {{ allowed: boolean, reason?: string, remainingHours?: number }}
   */
  canWish(groupId, eventKey, now = Date.now()) {
    const normEvent = StateStore.normalizeKey(eventKey);
    const compositeKey = `${groupId}::${normEvent}`;

    const lastEventWish = this.events.get(compositeKey);
    if (lastEventWish && now - lastEventWish < this.cooldownMs) {
      const remainingHours = ((this.cooldownMs - (now - lastEventWish)) / 3600000).toFixed(1);
      return {
        allowed: false,
        reason: `Event "${normEvent}" in this group already wished recently (${remainingHours}h remaining of ${this.cooldownMs / 3600000}h cooldown)`,
        remainingHours: Number(remainingHours),
      };
    }

    return { allowed: true };
  }

  /**
   * Records that a wish was sent for this (groupId, eventKey) so we don't wish the same person/event
   * in this group again for >= 2 days, while still allowing OTHER people's birthdays in the same group!
   * @param {string} groupId
   * @param {string} eventKey
   * @param {number} [now]
   */
  recordWish(groupId, eventKey, now = Date.now()) {
    const normEvent = StateStore.normalizeKey(eventKey);
    const compositeKey = `${groupId}::${normEvent}`;
    this.events.set(compositeKey, now);
    this._pruneOldEntries(now);
    this._save();
  }

  _pruneOldEntries(now = Date.now()) {
    for (const [k, ts] of this.events.entries()) {
      if (now - ts >= this.cooldownMs) {
        this.events.delete(k);
      }
    }
  }
}
