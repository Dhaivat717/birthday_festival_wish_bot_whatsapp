import { GoogleGenAI, Type } from '@google/genai';

export class GeminiWishService {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model]
   * @param {string} [options.userStylePrompt]
   */
  constructor({ apiKey, model = 'gemini-2.5-flash', userStylePrompt = '' } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.userStylePrompt = userStylePrompt;
    this.ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  /**
   * Analyzes a batch of recent wish messages from a WhatsApp group and produces a structured wish decision.
   * @param {object} params
   * @param {string} params.groupName
   * @param {Array<{ senderJid: string, senderName: string, text: string, mentionedJids: string[] }>} params.messages
   * @param {string} [params.myJid] The bot owner's WhatsApp JID (to avoid wishing ourselves!)
   * @param {string} [params.myName] The bot owner's display name
   * @returns {Promise<{
   *   shouldWish: boolean,
   *   eventType: 'birthday' | 'festival' | 'anniversary' | 'other',
   *   eventKey: string,
   *   targetJid: string | null,
   *   replyText: string,
   *   reasoning: string
   * }>}
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

    if (!this.ai) {
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

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
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
      },
    });

    const parsed = JSON.parse(response.text);
    return {
      shouldWish: Boolean(parsed.shouldWish),
      eventType: parsed.eventType || 'other',
      eventKey: parsed.eventKey || 'general_wish',
      targetJid: parsed.targetJid ? parsed.targetJid.trim() : null,
      replyText: (parsed.replyText || '').trim(),
      reasoning: parsed.reasoning || '',
    };
  }

  /**
   * Rule-based fallback if GEMINI_API_KEY is not configured.
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
