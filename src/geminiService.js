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

        // Must be a Geminiflash/lite text generation model
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

        // Extract version number e.g. gemini-3.8-flash-lite -> 3.8
        const verMatch = rawName.match(/^gemini-(\d+(?:\.\d+)?)/);
        const version = verMatch ? parseFloat(verMatch[1]) : 0;
        const isLite = rawName.includes('lite');
        const isPreview = rawName.includes('preview');
        const isLatestAlias = rawName.endsWith('-latest');

        candidates.push({
          name: rawName,
          version,
          isLite,
          isPreview,
          isLatestAlias,
        });
      }

      if (candidates.length > 0) {
        // Sort:
        // 1. Highest major/minor version first (so deprecated old versions are skipped)
        // 2. Prefer 'flash-lite' over regular 'flash' within the newest generation
        // 3. Prefer stable over preview
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

    // Fallback alias if models.list() fails
    this.resolvedModel = 'gemini-flash-lite-latest';
    return this.resolvedModel;
  }

  /**
   * Analyzes a batch of recent wish messages from a WhatsApp group and produces a structured wish decision.
   */
  async analyzeAndGenerateWish({ groupName, messages, myJid = '', myName = '' }) {
    // Safety check: if multiple messages mention the bot owner themselves, they are wishing US!
    const myBareNumber = myJid ? myJid.split('@')[0].split(':')[0] : '';
    if (myBareNumber) {
      const mentionsMeCount = messages.filter((m) =>
        (m.mentionedJids || []).some((jid) => jid.includes(myBareNumber))
      ).length;
      if (mentionsMeCount > 0) {
        return {
          shouldWish: false,
          eventType: 'other',
          eventKey: 'self_wish_blocked',
          targetJid: null,
          replyText: '',
          reasoning: 'Group members are mentioning/wishing the bot owner themselves; skipping auto-wish.',
        };
      }
    }

    if (!this.ai || !this._checkAndIncrementDailyQuota()) {
      return this._fallbackGenerate({ messages });
    }

    const formattedMessages = messages
      .map((m, i) => {
        const mentions =
          m.mentionedJids && m.mentionedJids.length > 0
            ? ` [Mentions: ${m.mentionedJids.join(', ')}]`
            : '';
        return `${i + 1}. ${m.senderName}: "${m.text}"${mentions}`;
      })
      .join('\n');

    const prompt = `You are helping a WhatsApp user automatically join in on group birthday, anniversary, and festival wishes.

Group Name: "${groupName}"
Bot Owner Name (me): "${myName || 'User'}" (JID: "${myJid || 'unknown'}")

Recent messages in the group:
${formattedMessages}

Instructions:
1. Determine if these messages are genuinely wishing someone a Happy Birthday, Happy Anniversary, or celebrating a Festival/Holiday (e.g., Diwali, Eid, Christmas, Holi, New Year, Navratri, etc.).
2. IMPORTANT: If the group members are wishing the Bot Owner ("${myName || 'me'}"), set shouldWish = false!
3. If multiple people are wishing the same person or celebrating the same festival, set shouldWish = true.
4. Set eventType to one of: "birthday", "festival", "anniversary", "other".
5. Set eventKey to a short, canonical lowercase identifier for deduplication:
   - If a person's JID is mentioned in [Mentions], use e.g. "birthday:919876543210@s.whatsapp.net"
   - Else if a person's name is mentioned (e.g. Rahul), use "birthday:rahul"
   - If it's a festival (e.g. Diwali), use "festival:diwali"
6. If a specific person's WhatsApp JID appears in [Mentions] across the wishes, set targetJid to that exact JID (e.g. "919876543210@s.whatsapp.net") and include "@<phone_number>" (e.g. "@919876543210") naturally in replyText, OR just use their name if others used their name without tagging. Otherwise set targetJid to "".
7. Write replyText on behalf of the user following this style guide:
   ${this.userStylePrompt}`;

    const schemaConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          shouldWish: {
            type: Type.BOOLEAN,
            description: 'True if we should send a wish reply in the group.',
          },
          eventType: {
            type: Type.STRING,
            description: 'birthday, festival, anniversary, or other',
          },
          eventKey: {
            type: Type.STRING,
            description: 'Canonical lowercase identifier like birthday:rahul or festival:diwali',
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
        // If a model was deprecated/404, re-discover the latest available model from the API and retry once
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
      return this._fallbackGenerate({ messages });
    }
  }

  /**
   * Rule-based fallback if GEMINI_API_KEY is not configured or API fails.
   */
  _fallbackGenerate({ messages }) {
    const combined = messages.map((m) => m.text).join(' ');
    const mentionCounts = new Map();
    for (const m of messages) {
      for (const jid of m.mentionedJids || []) {
        mentionCounts.set(jid, (mentionCounts.get(jid) || 0) + 1);
      }
    }
    let topMentionJid = null;
    let maxCount = 0;
    for (const [jid, count] of mentionCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        topMentionJid = jid;
      }
    }

    if (/\b(?:bday|b'day|birthday|hbd|janamdin|returns)\b/i.test(combined)) {
      const mentionTag = topMentionJid ? ` @${topMentionJid.split('@')[0]}` : '';
      return {
        shouldWish: true,
        eventType: 'birthday',
        eventKey: topMentionJid ? `birthday:${topMentionJid}` : 'birthday:general',
        targetJid: topMentionJid,
        replyText: `Happy Birthday${mentionTag}! Wishing you a great year ahead 🎂🥳`,
        reasoning: 'Fallback rule-based birthday detection',
      };
    }

    const festivalMatch = combined.match(
      /\b(?:happy|shubh|merry)\s+(diwali|deepavali|holi|navratri|dussehra|christmas|new\s+year|eid|pongal|onam|ganesh\s+chaturthi|raksha\s+bandhan|janmashtami)\b/i
    );
    if (festivalMatch) {
      const fest = festivalMatch[1];
      return {
        shouldWish: true,
        eventType: 'festival',
        eventKey: `festival:${fest.toLowerCase()}`,
        targetJid: null,
        replyText: `Happy ${fest} to everyone and your families! ✨🎉`,
        reasoning: `Fallback rule-based festival detection (${fest})`,
      };
    }

    if (/\beid\s+mubarak\b/i.test(combined)) {
      return {
        shouldWish: true,
        eventType: 'festival',
        eventKey: 'festival:eid',
        targetJid: null,
        replyText: 'Eid Mubarak to everyone! 🌙✨',
        reasoning: 'Fallback rule-based Eid detection',
      };
    }

    return {
      shouldWish: false,
      eventType: 'other',
      eventKey: 'unknown',
      targetJid: null,
      replyText: '',
      reasoning: 'Could not confidently classify wish without Gemini API key',
    };
  }
}
