import fs from 'fs';
import path from 'path';

export class StateStore {
  /**
   * @param {string} dataDir Directory to persist state JSON
   * @param {object} options
   * @param {number} options.cooldownHours Minimum hours before wishing the same event/person again (default 48h = 2 days)
   * @param {number} options.groupGlobalCooldownHours Optional minimum hours between ANY two wishes in the same group
   */
  constructor(dataDir, { cooldownHours = 48, groupGlobalCooldownHours = 0 } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'wish_history.json');
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    this.groupGlobalCooldownMs = groupGlobalCooldownHours * 60 * 60 * 1000;
    this.state = {
      // key: `${groupId}::${normalizedEventKey}` -> timestamp (ms)
      events: {},
      // key: `${groupId}` -> timestamp (ms)
      groups: {},
    };
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = {
          events: parsed.events || {},
          groups: parsed.groups || {},
        };
      }
    } catch (err) {
      console.error('[StateStore] Failed to load state file, starting fresh:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
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
   * Checks whether we are allowed to send a wish for this group + eventKey right now.
   * Enforces the >= 2-day (48h) cooldown.
   * @param {string} groupId
   * @param {string} eventKey
   * @param {number} [now]
   * @returns {{ allowed: boolean, reason?: string, remainingHours?: number }}
   */
  canWish(groupId, eventKey, now = Date.now()) {
    const normEvent = StateStore.normalizeKey(eventKey);
    const compositeKey = `${groupId}::${normEvent}`;

    // 1. Check group-wide cooldown if configured
    if (this.groupGlobalCooldownMs > 0) {
      const lastGroupWish = this.state.groups[groupId];
      if (lastGroupWish && now - lastGroupWish < this.groupGlobalCooldownMs) {
        const remainingHours = ((this.groupGlobalCooldownMs - (now - lastGroupWish)) / 3600000).toFixed(1);
        return {
          allowed: false,
          reason: `Group cooldown active (${remainingHours}h remaining)`,
          remainingHours: Number(remainingHours),
        };
      }
    }

    // 2. Check specific event/person cooldown in this group (default 48h = 2 days)
    const lastEventWish = this.state.events[compositeKey];
    if (lastEventWish && now - lastEventWish < this.cooldownMs) {
      const remainingHours = ((this.cooldownMs - (now - lastEventWish)) / 3600000).toFixed(1);
      return {
        allowed: false,
        reason: `Event "${normEvent}" already wished recently (${remainingHours}h remaining of ${this.cooldownMs / 3600000}h cooldown)`,
        remainingHours: Number(remainingHours),
      };
    }

    return { allowed: true };
  }

  /**
   * Records that a wish was sent (or manually sent by the user) so we don't wish again for >= 2 days.
   * @param {string} groupId
   * @param {string} eventKey
   * @param {number} [now]
   */
  recordWish(groupId, eventKey, now = Date.now()) {
    const normEvent = StateStore.normalizeKey(eventKey);
    const compositeKey = `${groupId}::${normEvent}`;
    this.state.events[compositeKey] = now;
    this.state.groups[groupId] = now;
    this._pruneOldEntries(now);
    this._save();
  }

  _pruneOldEntries(now = Date.now()) {
    const maxAge = Math.max(this.cooldownMs, this.groupGlobalCooldownMs, 14 * 24 * 3600 * 1000);
    for (const [k, ts] of Object.entries(this.state.events)) {
      if (now - ts > maxAge) delete this.state.events[k];
    }
    for (const [k, ts] of Object.entries(this.state.groups)) {
      if (now - ts > maxAge) delete this.state.groups[k];
    }
  }
}
