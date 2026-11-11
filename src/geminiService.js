import { GoogleGenAI, Type } from '@google/genai';

const BIRTHDAY_TEMPLATES = [
  (tag) => `Happy Birthday${tag}! Wishing you a wonderful year ahead 🎂🥳`,
  (tag) => `Many many happy returns of the day${tag}! Have a fantastic birthday 🎉🎂`,
  (tag) => `Happy Birthday${tag}! Hope you have an amazing day and a great year ahead 🥳✨`,
  (tag) => `Wishing you a very Happy Birthday${tag}! Stay blessed and keep smiling 🎂🎉`,
];

const ANNIVERSARY_TEMPLATES = [
  (tag) => `Happy Anniversary${tag}! Wishing you both many more years of happiness and togetherness 🥂💐✨`,
  (tag) => `Heartiest congratulations and Happy Wedding Anniversary${tag}! Wishing you both endless love and joy 💐🎉`,
  (tag) => `Happy Anniversary${tag}! May your bond continue to grow stronger every year 🥂✨`,
];

const FESTIVAL_TEMPLATES = {
  diwali: [
    'Happy Diwali to everyone and your families! May this festival of lights bring joy and prosperity 🪔✨',
    'Shubh Deepavali to all! Wishing you and your family peace, health, and happiness 🪔🎉',
  ],
  'saal mubarak': [
    'Saal Mubarak to everyone and your families! Wishing you a joyful and prosperous New Year 🙏✨',
    'Nutan Varshabhinandan & Saal Mubarak to all! May the new year bring health and happiness 🙏🎉',
  ],
  holi: [
    'Happy Holi to everyone! May your year be filled with vibrant colors and happiness 🎨🥳',
  ],
  eid: [
    'Eid Mubarak to everyone and your families! Wishing you peace, joy, and blessings 🌙✨',
  ],
  christmas: [
    'Merry Christmas to everyone! Wishing you warm holidays filled with peace and cheer 🎄✨',
  ],
  default: (fest) => [
    `Happy ${fest} to everyone and your families! Wishing you joy and blessings ✨🎉`,
    `Warmest wishes on ${fest} to you and your family! 🙏✨`,
  ],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class GeminiWishService {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model] Set to 'auto' (default) to automatically pick the latest flash-lite / flash model
   * @param {string} [options.userStylePrompt]
   * @param {number} [options.maxDailyCalls] Hard daily cap on Gemini API requests
   */
  constructor({ apiKey, model = 'auto', userStylePrompt = '', maxDailyCalls = 20 } = {}) {
    this.apiKey = apiKey;
    this.configuredModel = model || 'auto';
    this.resolvedModel = null;
    this.userStylePrompt = userStylePrompt;
    this.maxDailyCalls = maxDailyCalls;
    this.dailyCount = 0;
    this.currentDay = new Date().toISOString().slice(0, 10);
    this.ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  _checkAndIncrementDailyQuota() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.dailyCount = 0;
    }
    if (this.dailyCount >= this.maxDailyCalls) {
      return false;
    }
    this.dailyCount += 1;
    return true;
  }

  /**
   * Dynamically discovers the newest available Gemini flash-lite (or flash) model
   * from the API so you never have to manually update model names in .env.
   */
  async _resolveBestLiteModel(forceRefresh = false) {
    if (!forceRefresh && this.resolvedModel) {
      return this.resolvedModel;
    }
    if (!forceRefresh && this.configuredModel && this.configuredModel !== 'auto') {
      this.resolvedModel = this.configuredModel;
      return this.resolvedModel;
    }

    try {
      const pager = await this.ai.models.list();
      const candidates = [];

      for await (const m of pager) {
        const rawName = (m.name || '').replace(/^models\//, '');
        const actions = m.supportedActions || m.supportedGenerationMethods || [];

        if (!rawName.startsWith('gemini-')) continue;
        if (!rawName.includes('flash')) continue;
        if (
          /tts|image|vision|embedding|audio|live|thinking|computer-use|robotics|exp/i.test(rawName)
        ) {
          continue;
        }
        if (
          Array.isArray(actions) &&
          actions.length > 0 &&
          !actions.includes('generateContent')
        ) {
          continue;
        }

        const verMatch = rawName.match(/^gemini-(\d+(?:\.\d+)?)/);
        const version = verMatch ? parseFloat(verMatch[1]) : 0;
        const isLite = rawName.includes('lite');
        const isPreview = rawName.includes('preview');
        const isLatestAlias = rawName === 'gemini-flash-lite-latest';

        candidates.push({
          name: rawName,
          version,
          isLite,
          isPreview,
          isLatestAlias,
        });
      }

      if (candidates.length > 0) {
        // Prioritize:
        // 1. 'flash-lite' models first (fastest, lightest, no slow thinking delay)
        // 2. Stable over preview
        // 3. Highest version number (e.g. 3.8 > 3.5 > 3.0 > 2.5)
        candidates.sort((a, b) => {
          if (a.isLite !== b.isLite) return a.isLite ? -1 : 1;
          if (a.isPreview !== b.isPreview) return a.isPreview ? 1 : -1;
          if (b.version !== a.version) return b.version - a.version;
          if (a.isLatestAlias !== b.isLatestAlias) return a.isLatestAlias ? -1 : 1;
          return a.name.length - b.name.length;
        });

        this.resolvedModel = candidates[0].name;
        console.log(`🤖 [Gemini] Auto-selected lite model: ${this.resolvedModel}`);
        return this.resolvedModel;
      }
    } catch (err) {
      console.warn(`[Gemini] Model auto-discovery fallback (${err.message})`);
    }

    this.resolvedModel = 'gemini-flash-lite-latest';
    return this.resolvedModel;
  }

  /**
   * Analyzes a batch of recent wish messages from a WhatsApp group and produces a structured wish decision.
   * Supports multiple people having birthdays on the same day in the same group via alreadyWishedEvents.
   */
  async analyzeAndGenerateWish({
    groupName,
    messages,
    myJid = '',
    myName = '',
    alreadyWishedEvents = [],
    minWishers = 2,
  }) {
    const myBareNumber = myJid ? myJid.split('@')[0].split(':')[0] : '';

    // Filter out any message that explicitly tags ONLY the bot owner
    const nonSelfMessages = myBareNumber
      ? messages.filter(
          (m) => !(m.mentionedJids || []).some((jid) => jid.includes(myBareNumber))
        )
      : messages;

    if (nonSelfMessages.length < minWishers) {
      return {
        shouldWish: false,
        eventType: 'other',
        eventKey: 'self_wish_blocked',
        targetName: '',
        targetJid: null,
        replyText: '',
        reasoning: 'Not enough wishers for someone other than the bot owner.',
      };
    }

    if (!this.ai || !this._checkAndIncrementDailyQuota()) {
      return this._fallbackGenerate({
        messages: nonSelfMessages,
        alreadyWishedEvents,
        minWishers,
      });
    }

    const formattedMessages = nonSelfMessages
      .map((m, i) => {
        const mentions =
          m.mentionedJids && m.mentionedJids.length > 0
            ? ` [Mentions: ${m.mentionedJids.join(', ')}]`
            : '';
        return `${i + 1}. ${m.senderName} (${m.senderJid}): "${m.text}"${mentions}`;
      })
      .join('\n');

    const alreadyWishedNote =
      alreadyWishedEvents.length > 0
        ? `\nIMPORTANT - Already wished in this group today (IGNORE wishes for these people/events and ONLY look for a DIFFERENT person or event that has NOT been wished yet): ${JSON.stringify(alreadyWishedEvents)}\n`
        : '';

    const prompt = `You are helping a WhatsApp user automatically join in on group birthday, wedding anniversary, and festival wishes.

Group Name: "${groupName}"
Bot Owner Name (me): "${myName || 'User'}" (JID: "${myJid || 'unknown'}")
${alreadyWishedNote}
Recent messages in the group:
${formattedMessages}

Instructions:
1. Multiple people in the same group can have a birthday/anniversary on the same day! Check if at least ${minWishers} DIFFERENT senders in the recent messages are wishing a specific person/couple (or celebrating a festival) that is NOT in the "Already wished in this group today" list.
2. IMPORTANT: If the group members are wishing the Bot Owner ("${myName || 'me'}"), or if they are only wishing someone already in the "Already wished" list, set shouldWish = false!
3. Set eventType to one of: "birthday", "anniversary", "festival", "other".
4. Set targetName to the human-readable name of who or what is being wished (e.g., "Rahul", "Krunal & Bhavna", "Diwali", "Saal Mubarak").
5. Set eventKey to a canonical lowercase identifier per person, couple, or festival for per-group per-person deduplication:
   - Birthday: "birthday:<jid>" if tagged in [Mentions], else "birthday:<name>" (e.g. "birthday:rahul")
   - Anniversary: "anniversary:<jid>" if tagged, else "anniversary:<names>" (e.g. "anniversary:rahul_priya")
   - Festival: "festival:<name>" (e.g. "festival:diwali", "festival:saal_mubarak")
6. If a specific person's WhatsApp JID appears in [Mentions] for this unwished person, set targetJid to that exact JID (e.g. "919876543210@s.whatsapp.net") and include "@<phone_number>" (e.g. "@919876543210") naturally in replyText, OR use their name if others used their name without tagging. Otherwise set targetJid to "".
7. Craft a distinct, natural replyText tailored specifically to the eventType:
   - If "birthday": Write a warm, natural birthday wish for that person (vary your wording naturally—do not use the exact same phrase every time).
   - If "anniversary": Write a warm wedding/couple anniversary wish (e.g. wishing them both love, happiness, and many more wonderful years together 🥂💐).
   - If "festival": Write a festive greeting tailored specifically to that festival and matching the group's cultural vibe/language (e.g., Diwali 🪔, Saal Mubarak / Nutan Varshabhinandan 🙏, Uttarayan 🪁, Holi 🎨, Eid 🌙, Christmas 🎄).
   - Style guide: ${this.userStylePrompt}`;

    const schemaConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          shouldWish: {
            type: Type.BOOLEAN,
            description: 'True if at least minWishers unique people are wishing an unwished person/couple/festival.',
          },
          eventType: {
            type: Type.STRING,
            description: 'birthday, anniversary, festival, or other',
          },
          targetName: {
            type: Type.STRING,
            description: 'Human-readable name of the person, couple, or festival being wished',
          },
          eventKey: {
            type: Type.STRING,
            description: 'Canonical lowercase identifier like birthday:rahul, anniversary:rahul_priya, or festival:diwali',
          },
          targetJid: {
            type: Type.STRING,
            description: 'JID of the mentioned birthday/anniversary person if tagged, else empty string',
          },
          replyText: {
            type: Type.STRING,
            description: 'The natural wish message to send on the user behalf',
          },
          reasoning: {
            type: Type.STRING,
            description: 'Brief explanation of the decision',
          },
        },
        required: [
          'shouldWish',
          'eventType',
          'targetName',
          'eventKey',
          'targetJid',
          'replyText',
          'reasoning',
        ],
      },
    };

    try {
      let modelName = await this._resolveBestLiteModel(false);
      let response;
      try {
        response = await this.ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: schemaConfig,
        });
      } catch (firstErr) {
        if (String(firstErr.message || '').includes('404') || String(firstErr.message || '').includes('NOT_FOUND')) {
          console.log(`[Gemini] Model "${modelName}" unavailable, auto-discovering newest lite model...`);
          modelName = await this._resolveBestLiteModel(true);
          response = await this.ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: schemaConfig,
          });
        } else {
          throw firstErr;
        }
      }

      const parsed = JSON.parse(response.text);
      return {
        shouldWish: Boolean(parsed.shouldWish),
        eventType: parsed.eventType || 'other',
        targetName: (parsed.targetName || parsed.eventKey || 'someone').trim(),
        eventKey: parsed.eventKey || 'general_wish',
        targetJid: parsed.targetJid ? parsed.targetJid.trim() : null,
        replyText: (parsed.replyText || '').trim(),
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      console.warn(`[Gemini] API call failed (${err.message}), using fallback wish generator.`);
      return this._fallbackGenerate({
        messages: nonSelfMessages,
        alreadyWishedEvents,
        minWishers,
      });
    }
  }

  /**
   * Rule-based fallback if GEMINI_API_KEY is not configured or API fails.
   * Generates distinct messages for birthdays, anniversaries, and specific festivals.
   */
  _fallbackGenerate({ messages, alreadyWishedEvents = [], minWishers = 2 }) {
    const alreadySet = new Set(alreadyWishedEvents.map((e) => e.toLowerCase()));
    const candidates = new Map();

    const addCandidate = (key, senderJid, targetJid, displayTarget, targetName, type) => {
      const normKey = key.toLowerCase();
      if (alreadySet.has(normKey)) return;
      if (!candidates.has(normKey)) {
        candidates.set(normKey, {
          eventKey: normKey,
          senders: new Set(),
          targetJid,
          displayTarget,
          targetName,
          type,
        });
      }
      candidates.get(normKey).senders.add(senderJid);
    };

    for (const m of messages) {
      const text = m.text || '';

      // 1. Check Anniversary
      if (/\b(?:anniversary|salgirah)\b/i.test(text)) {
        if (m.mentionedJids && m.mentionedJids.length > 0) {
          const jid = m.mentionedJids[0];
          const num = jid.split('@')[0];
          addCandidate(`anniversary:${jid}`, m.senderJid, jid, ` @${num}`, `@${num}`, 'anniversary');
        } else {
          const nameMatch = text.match(
            /\b(?:anniversary|salgirah(?:\s+mubarak)?)\s+(?:to\s+|dear\s+)?([A-Z][a-z]{2,15}(?:\s*(?:&|and)\s*[A-Z][a-z]{2,15})?)\b/
          );
          const name = nameMatch ? nameMatch[1].trim() : 'both of you';
          addCandidate(
            `anniversary:${name.toLowerCase().replace(/\s+/g, '_')}`,
            m.senderJid,
            null,
            name !== 'both of you' ? ` ${name}` : '',
            name,
            'anniversary'
          );
        }
        continue;
      }

      // 2. Check Birthday
      if (/\b(?:bday|b'day|birthday|hbd|janamdin|returns)\b/i.test(text)) {
        if (m.mentionedJids && m.mentionedJids.length > 0) {
          for (const jid of m.mentionedJids) {
            const num = jid.split('@')[0];
            // Also try extracting their spoken name from the message text if present
            const spokenNameMatch = text.match(
              /\b(?:birthday|bday|b'day|hbd|day)\s+(?:@[0-9]+\s+)?([A-Z][a-z]{2,15})\b/
            );
            const humanName = spokenNameMatch ? spokenNameMatch[1] : `@${num}`;
            addCandidate(`birthday:${jid}`, m.senderJid, jid, ` @${num}`, humanName, 'birthday');
          }
        } else {
          const nameMatch = text.match(
            /\b(?:birthday|bday|b'day|hbd|day)\s+(?:to\s+|dear\s+|bhai\s+|ben\s+)?([a-zA-Z]{2,15})\b/i
          );
          const name = nameMatch ? nameMatch[1] : 'general';
          addCandidate(
            `birthday:${name.toLowerCase()}`,
            m.senderJid,
            null,
            name !== 'general' ? ` ${name}` : '',
            name !== 'general' ? name : 'Birthday Person',
            'birthday'
          );
        }
        continue;
      }

      // 3. Check Festivals
      if (/\b(?:saal\s+mubarak|nutan\s+varshabhinandan)\b/i.test(text)) {
        addCandidate('festival:saal_mubarak', m.senderJid, null, 'Saal Mubarak', 'Saal Mubarak', 'festival');
      } else if (/\beid\s+mubarak\b/i.test(text)) {
        addCandidate('festival:eid', m.senderJid, null, 'Eid', 'Eid', 'festival');
      } else {
        const festivalMatch = text.match(
          /\b(?:happy|shubh|merry)\s+(diwali|deepavali|holi|dhuleti|navratri|dussehra|christmas|new\s+year|eid|pongal|onam|uttarayan|makar\s+sankranti|ganesh\s+chaturthi|raksha\s+bandhan|janmashtami|dhanteras|maha\s+shivratri)\b/i
        );
        if (festivalMatch) {
          const fest = festivalMatch[1];
          addCandidate(`festival:${fest.toLowerCase()}`, m.senderJid, null, fest, fest, 'festival');
        }
      }
    }

    for (const cand of candidates.values()) {
      if (cand.senders.size >= minWishers) {
        if (cand.type === 'birthday') {
          const templateFn = pickRandom(BIRTHDAY_TEMPLATES);
          return {
            shouldWish: true,
            eventType: 'birthday',
            targetName: cand.targetName,
            eventKey: cand.eventKey,
            targetJid: cand.targetJid,
            replyText: templateFn(cand.displayTarget),
            reasoning: 'Fallback rule-based per-person birthday detection',
          };
        }
        if (cand.type === 'anniversary') {
          const templateFn = pickRandom(ANNIVERSARY_TEMPLATES);
          return {
            shouldWish: true,
            eventType: 'anniversary',
            targetName: cand.targetName,
            eventKey: cand.eventKey,
            targetJid: cand.targetJid,
            replyText: templateFn(cand.displayTarget),
            reasoning: 'Fallback rule-based per-couple anniversary detection',
          };
        }
        if (cand.type === 'festival') {
          const festKey = cand.displayTarget.toLowerCase();
          const pool = FESTIVAL_TEMPLATES[festKey] || FESTIVAL_TEMPLATES.default(cand.displayTarget);
          return {
            shouldWish: true,
            eventType: 'festival',
            targetName: cand.targetName,
            eventKey: cand.eventKey,
            targetJid: null,
            replyText: pickRandom(pool),
            reasoning: `Fallback rule-based festival detection (${cand.displayTarget})`,
          };
        }
      }
    }

    return {
      shouldWish: false,
      eventType: 'other',
      targetName: '',
      eventKey: 'unknown',
      targetJid: null,
      replyText: '',
      reasoning: 'No unwished person/festival reached the minimum wisher threshold yet.',
    };
  }

  /**
   * Extracts canonical eventKeys (e.g. 'birthday:rahul', 'birthday:919876543210@s.whatsapp.net', 'festival:diwali')
   * when YOU manually send a wish in a group, so the bot adds that person/event + group to the 48h cooldown.
   */
  extractManualWishKeys({ text, mentionedJids = [], recentMessages = [] }) {
    const keys = new Set();
    const allMsgs = [
      { senderJid: 'me', text, mentionedJids },
      ...recentMessages,
    ];

    for (const m of allMsgs) {
      const res = this._fallbackGenerate({
        messages: [m],
        alreadyWishedEvents: [],
        minWishers: 1,
      });
      if (res.shouldWish && res.eventKey && res.eventKey !== 'unknown') {
        keys.add(res.eventKey);
      }
      // Also if the manual message both tagged a JID and wrote a name, record both keys so either form matches!
      if (m.mentionedJids && m.mentionedJids.length > 0 && /\b(?:bday|b'day|birthday|hbd|janamdin|returns)\b/i.test(m.text || '')) {
        const nameMatch = (m.text || '').match(
          /\b(?:birthday|bday|b'day|hbd|day)\s+(?:@[0-9]+\s+)?(?:to\s+|dear\s+|bhai\s+|ben\s+)?([a-zA-Z]{2,15})\b/i
        );
        if (nameMatch) {
          keys.add(`birthday:${nameMatch[1].toLowerCase()}`);
        }
      }
    }

    return [...keys];
  }
}
