import { GoogleGenAI, Type } from '@google/genai';

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

        candidates.push({
          name: rawName,
          version,
          isLite,
          isPreview,
        });
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          if (b.version !== a.version) return b.version - a.version;
          if (a.isLite !== b.isLite) return a.isLite ? -1 : 1;
          if (a.isPreview !== b.isPreview) return a.isPreview ? 1 : -1;
          return a.name.length - b.name.length;
        });

        this.resolvedModel = candidates[0].name;
        console.log(`🤖 [Gemini] Auto-selected model: ${this.resolvedModel}`);
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

    const prompt = `You are helping a WhatsApp user automatically join in on group birthday, anniversary, and festival wishes.

Group Name: "${groupName}"
Bot Owner Name (me): "${myName || 'User'}" (JID: "${myJid || 'unknown'}")
${alreadyWishedNote}
Recent messages in the group:
${formattedMessages}

Instructions:
1. Multiple people in the same group can have a birthday on the same day! Check if at least ${minWishers} DIFFERENT senders in the recent messages are wishing a specific person (or celebrating a festival) that is NOT in the "Already wished in this group today" list.
2. IMPORTANT: If the group members are wishing the Bot Owner ("${myName || 'me'}"), or if they are only wishing someone already in the "Already wished" list, set shouldWish = false!
3. Set eventType to one of: "birthday", "festival", "anniversary", "other".
4. Set eventKey to a canonical lowercase identifier per person or festival for per-group per-person deduplication:
   - If a person's JID is mentioned in [Mentions], prefer "birthday:<jid>" (e.g. "birthday:919876543210@s.whatsapp.net")
   - Else if a person's name is mentioned (e.g. Rahul), use "birthday:rahul"
   - If it's a festival (e.g. Diwali), use "festival:diwali"
5. If a specific person's WhatsApp JID appears in [Mentions] for this unwished person, set targetJid to that exact JID (e.g. "919876543210@s.whatsapp.net") and include "@<phone_number>" (e.g. "@919876543210") naturally in replyText, OR use their name if others used their name without tagging. Otherwise set targetJid to "".
6. Write replyText on behalf of the user following this style guide:
   ${this.userStylePrompt}`;

    const schemaConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          shouldWish: {
            type: Type.BOOLEAN,
            description: 'True if at least minWishers unique people are wishing an unwished person/festival.',
          },
          eventType: {
            type: Type.STRING,
            description: 'birthday, festival, anniversary, or other',
          },
          eventKey: {
            type: Type.STRING,
            description: 'Canonical lowercase identifier like birthday:rahul or birthday:919876543210@s.whatsapp.net or festival:diwali',
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
        required: ['shouldWish', 'eventType', 'eventKey', 'targetJid', 'replyText', 'reasoning'],
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
   * Groups wishes per person/mention so multiple birthdays on the same day work even in fallback mode!
   */
  _fallbackGenerate({ messages, alreadyWishedEvents = [], minWishers = 2 }) {
    const alreadySet = new Set(alreadyWishedEvents.map((e) => e.toLowerCase()));

    // Map candidate eventKey -> { senders: Set, targetJid: string|null, displayTarget: string, type: string }
    const candidates = new Map();

    const addCandidate = (key, senderJid, targetJid, displayTarget, type) => {
      const normKey = key.toLowerCase();
      if (alreadySet.has(normKey)) return;
      if (!candidates.has(normKey)) {
        candidates.set(normKey, {
          eventKey: normKey,
          senders: new Set(),
          targetJid,
          displayTarget,
          type,
        });
      }
      candidates.get(normKey).senders.add(senderJid);
    };

    for (const m of messages) {
      const text = m.text || '';
      if (/\b(?:bday|b'day|birthday|hbd|janamdin|returns)\b/i.test(text)) {
        if (m.mentionedJids && m.mentionedJids.length > 0) {
          for (const jid of m.mentionedJids) {
            addCandidate(`birthday:${jid}`, m.senderJid, jid, `@${jid.split('@')[0]}`, 'birthday');
          }
        } else {
          // Try extracting a name after birthday/hbd/day
          const nameMatch = text.match(
            /\b(?:birthday|bday|b'day|hbd|day)\s+(?:to\s+|dear\s+)?([A-Z][a-z]{2,15})\b/
          );
          const name = nameMatch ? nameMatch[1] : 'general';
          addCandidate(
            `birthday:${name.toLowerCase()}`,
            m.senderJid,
            null,
            name !== 'general' ? ` ${name}` : '',
            'birthday'
          );
        }
      }

      const festivalMatch = text.match(
        /\b(?:happy|shubh|merry)\s+(diwali|deepavali|holi|navratri|dussehra|christmas|new\s+year|eid|pongal|onam|ganesh\s+chaturthi|raksha\s+bandhan|janmashtami)\b/i
      );
      if (festivalMatch) {
        const fest = festivalMatch[1];
        addCandidate(`festival:${fest.toLowerCase()}`, m.senderJid, null, fest, 'festival');
      } else if (/\beid\s+mubarak\b/i.test(text)) {
        addCandidate('festival:eid', m.senderJid, null, 'Eid', 'festival');
      }
    }

    for (const cand of candidates.values()) {
      if (cand.senders.size >= minWishers) {
        if (cand.type === 'birthday') {
          const tagPart = cand.targetJid ? ` ${cand.displayTarget}` : cand.displayTarget;
          return {
            shouldWish: true,
            eventType: 'birthday',
            eventKey: cand.eventKey,
            targetJid: cand.targetJid,
            replyText: `Happy Birthday${tagPart}! Wishing you a great year ahead 🎂🥳`,
            reasoning: 'Fallback rule-based per-person birthday detection',
          };
        }
        if (cand.type === 'festival') {
          return {
            shouldWish: true,
            eventType: 'festival',
            eventKey: cand.eventKey,
            targetJid: null,
            replyText: `Happy ${cand.displayTarget} to everyone and your families! ✨🎉`,
            reasoning: `Fallback rule-based festival detection (${cand.displayTarget})`,
          };
        }
      }
    }

    return {
      shouldWish: false,
      eventType: 'other',
      eventKey: 'unknown',
      targetJid: null,
      replyText: '',
      reasoning: 'No unwished person/festival reached the minimum wisher threshold yet.',
    };
  }
}
