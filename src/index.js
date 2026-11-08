import http from 'http';
import { config } from './config.js';
import { WhatsAppWishBot } from './bot.js';

console.log('🚀 Starting WhatsApp Birthday & Festival Wish Bot...');

if (!config.geminiApiKey) {
  console.warn(
    '⚠️  GEMINI_API_KEY is not set in .env! The bot will use its built-in template fallback until you add GEMINI_API_KEY.'
  );
}

// Optional lightweight healthcheck server for 24/7 cloud hosts (Railway, Render, Fly.io)
if (process.env.PORT) {
  const port = Number(process.env.PORT);
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'whatsapp-wish-bot' }));
    })
    .listen(port, () => {
      console.log(`🌐 Healthcheck server listening on port ${port}`);
    });
}

const bot = new WhatsAppWishBot();
bot.start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
