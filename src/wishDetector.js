/**
 * Fast local pre-filter and sliding-window aggregator for group wish messages.
 * Waits until N unique members in a group send wish-like messages within the time window
 * before invoking the LLM.
 */

const WISH_PATTERNS = [
  // Birthday patterns
  /\bhappy\s+b(?:'?day|irthday)\b/i,
  /\bhbd\b/i,
  /\bbelated\s+happy\s+birthday\b/i,
  /\bmany\s+(?:many\s+)?happy\s+returns\b/i,
  /\bjanamdin\s+mubarak\b/i,
  /\bwishing\s+you\s+a\s+very\s+happy\b/i,
  /\bhave\s+a\s+(?:great|wonderful|blessed)\s+(?:birthday|year\s+ahead|day)\b/i,
  // Anniversary / Milestones
  /\bhappy\s+(?:wedding\s+)?anniversary\b/i,
  // Festival & Holiday patterns
  /\bhappy\s+(?:diwali|deepavali|holi|navratri|dussehra|ganesh\s+chaturthi|makar\s+sankranti|pongal|onam|ugadi|gudi\s+padwa|baisakhi|lohri|raksha\s+bandhan|rakhi|janmashtami|ram\s+navami|maha\s+shivratri)\b/i,
  /\bhappy\s+(?:new\s+year|easter|thanksgiving|hanukkah|passover|halloween|independence\s+day|republic\s+day)\b/i,
  /\bmerry\s+christmas\b/i,
  /\bxmas\b/i,
  /\beid\s+mubarak\b/i,
  /\bramadan\s+(?:mubarak|kareem)\b/i,
  /\bshubh\s+(?:diwali|deepavali|navratri|holi|dhanteras|dussehra|ganesh\s+chaturthi)\b/i,
  /\bsaal\s+mubarak\b/i,
  /\bnutan\s+varshabhinandan\b/i,
  /\bchag\s+sameach\b/i,
  /\b(?:heartiest|warmest)\s+(?:greetings|wishes)\b/i,
];

const BIRTHDAY_EMOJIS = ['🎂', '🥳', '🎉', '🎈', '🎊', '🪔', '🎄', '🌙'];

/**
 * Checks if a message text looks like a birthday, festival, or celebratory wish.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWish(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 500) return false;

  for (const regex of WISH_PATTERNS) {
    if (regex.test(trimmed)) return true;
  }

  // Also match short messages that combine "happy" or "wish" with celebratory emojis
  if (/\b(?:happy|wish|wishing|mubarak|shubh|blessings)\b/i.test(trimmed)) {
    if (BIRTHDAY_EMOJIS.some((emoji) => trimmed.includes(emoji))) {
      return true;
    }
  }

  // Or pure cake + party emoji bursts often used in birthday threads ("🎂🎂🥳🎉")
  if (trimmed.includes('🎂') && trimmed.length <= 30) {
    return true;
  }

  return false;
}

export class WishTracker {
  /**
   * @param {object} options
   * @param {number} options.minWishers Minimum unique senders required to trigger (e.g. 2 or 3)
   * @param {number} options.windowMinutes Sliding window duration in minutes (e.g. 45)
   */
  constructor({ minWishers = 2, windowMinutes = 45 } = {}) {
    this.minWishers = minWishers;
    this.windowMs = windowMinutes * 60 * 1000;
    // Map: groupId -> Array<{ senderJid, senderName, text, mentionedJids, timestamp }>
    this.buffers = new Map();
  }

  /**
   * Adds a message to the group's sliding window buffer if it looks like a wish.
   * @param {object} msg
   * @param {string} msg.groupId
   * @param {string} msg.senderJid
   * @param {string} msg.senderName
   * @param {string} msg.text
   * @param {string[]} [msg.mentionedJids]
   * @param {number} [msg.timestamp]
   * @returns {{ matched: boolean, readyToTrigger: boolean, uniqueWisherCount: number, recentMessages: Array }}
   */
  addMessage({ groupId, senderJid, senderName, text, mentionedJids = [], timestamp = Date.now() }) {
    this._prune(groupId, timestamp);

    if (!looksLikeWish(text)) {
      return {
        matched: false,
        readyToTrigger: false,
        uniqueWisherCount: this.getUniqueWisherCount(groupId, timestamp),
        recentMessages: this.buffers.get(groupId) || [],
      };
    }

    const list = this.buffers.get(groupId) || [];
    list.push({
      senderJid,
      senderName: senderName || senderJid.split('@')[0],
      text: text.trim(),
      mentionedJids,
      timestamp,
    });
    this.buffers.set(groupId, list);

    const uniqueSenders = new Set(list.map((m) => m.senderJid));
    const uniqueWisherCount = uniqueSenders.size;

    return {
      matched: true,
      readyToTrigger: uniqueWisherCount >= this.minWishers,
      uniqueWisherCount,
      recentMessages: [...list],
    };
  }

  getUniqueWisherCount(groupId, now = Date.now()) {
    this._prune(groupId, now);
    const list = this.buffers.get(groupId) || [];
    return new Set(list.map((m) => m.senderJid)).size;
  }

  clearGroup(groupId) {
    this.buffers.delete(groupId);
  }

  _prune(groupId, now = Date.now()) {
    const list = this.buffers.get(groupId);
    if (!list) return;
    const cutoff = now - this.windowMs;
    const filtered = list.filter((m) => m.timestamp >= cutoff);
    if (filtered.length === 0) {
      this.buffers.delete(groupId);
    } else {
      this.buffers.set(groupId, filtered);
    }
  }
}
