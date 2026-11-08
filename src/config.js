import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function parseList(val) {
  if (!val || !val.trim()) return [];
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'auto',
  pairingPhoneNumber: (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, ''),
  allowedGroups: parseList(process.env.ALLOWED_GROUPS),
  minWishers: Math.max(1, parseInt(process.env.MIN_WISHERS || '2', 10)),
  windowMinutes: Math.max(1, parseInt(process.env.WINDOW_MINUTES || '45', 10)),
  cooldownHours: Math.max(1, parseFloat(process.env.COOLDOWN_HOURS || '48')),
  groupGlobalCooldownHours: Math.max(0, parseFloat(process.env.GROUP_GLOBAL_COOLDOWN_HOURS || '0')),
  minDelaySeconds: Math.max(5, parseInt(process.env.MIN_DELAY_SECONDS || '45', 10)),
  maxDelaySeconds: Math.max(10, parseInt(process.env.MAX_DELAY_SECONDS || '180', 10)),
  maxDailyGeminiCalls: Math.max(1, parseInt(process.env.MAX_DAILY_GEMINI_CALLS || '20', 10)),
  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  userStylePrompt:
    process.env.USER_STYLE_PROMPT ||
    'Keep it warm, natural, casual, and concise (1 short sentence). Match the language/vibe of the other group members. Do not sound overly formal or robotic.',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
};
