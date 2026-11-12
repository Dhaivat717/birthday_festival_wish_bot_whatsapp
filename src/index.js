import http from 'http';
import { config } from './config.js';
import { WhatsAppWishBot } from './bot.js';

console.log('🚀 Starting WhatsApp Birthday & Festival Wish Bot...');

if (!config.geminiApiKey) {
  console.warn(
    '⚠️  GEMINI_API_KEY is not set in .env! The bot will use its built-in template fallback until you add GEMINI_API_KEY.'
  );
}

const bot = new WhatsAppWishBot();

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  bot.metrics.recordFault('uncaught_exception', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason);
  bot.metrics.recordFault('unhandled_rejection', reason);
});

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDashboardHtml(snap) {
  const uptimeHours = (snap.uptimeSeconds / 3600).toFixed(2);
  const statusBadge =
    snap.status === 'open'
      ? '<span style="color:#22c55e;font-weight:700;">● Connected</span>'
      : `<span style="color:#eab308;font-weight:700;">● ${escapeHtml(snap.status)}</span>`;

  const groupRows =
    snap.groups.length === 0
      ? '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">No groups registered yet</td></tr>'
      : snap.groups
          .map(
            (g) => `
        <tr>
          <td><strong>${escapeHtml(g.groupName)}</strong><br><small style="color:#64748b">${escapeHtml(g.groupId)}</small></td>
          <td style="font-weight:700;color:#38bdf8;font-size:1.1rem;">${g.wishesSent}</td>
          <td>🎂 ${g.byType?.birthday || 0} &nbsp; 🥂 ${g.byType?.anniversary || 0} &nbsp; 🪔 ${g.byType?.festival || 0}</td>
          <td>${g.wishCandidatesDetected}</td>
          <td>${g.manualWishesDetected}</td>
          <td>${g.cooldownSkips}</td>
          <td>${
            g.lastWishAt
              ? `<small>${escapeHtml(g.lastWishAt.replace('T', ' ').slice(0, 19))} UTC<br><em>${escapeHtml(g.lastWishTarget || '')}</em></small>`
              : '<span style="color:#64748b;">—</span>'
          }</td>
        </tr>`
          )
          .join('');

  const faultRows =
    snap.recentFaults.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:#22c55e;">No faults or errors recorded ✅</td></tr>'
      : snap.recentFaults
          .slice(0, 20)
          .map(
            (f) => `
        <tr>
          <td><small>${escapeHtml(f.timestamp.replace('T', ' ').slice(0, 19))} UTC</small></td>
          <td><span style="background:#7f1d1d;color:#fecaca;padding:2px 8px;border-radius:4px;font-size:0.8rem;">${escapeHtml(f.category)}</span></td>
          <td>${escapeHtml(f.groupName || '—')}</td>
          <td style="font-family:monospace;font-size:0.85rem;color:#fca5a5;">${escapeHtml(f.message)}</td>
        </tr>`
          )
          .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="refresh" content="15" />
  <title>WhatsApp Wish Bot — Observability</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 1100px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #1e293b; padding-bottom: 14px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; }
    .card .label { color: #94a3b8; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .card .val { font-size: 1.6rem; font-weight: 700; margin-top: 6px; }
    h2 { font-size: 1.15rem; margin: 24px 0 10px; color: #e2e8f0; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; border: 1px solid #334155; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 0.9rem; }
    th { background: #0f172a; color: #94a3b8; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
    .links a { color: #38bdf8; text-decoration: none; margin-left: 14px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 style="margin:0;font-size:1.4rem;">🎂 WhatsApp Wish Bot — Observability</h1>
        <small style="color:#94a3b8;">Auto-refreshes every 15s • Tip: Send <code>!stats</code> in your WhatsApp "Message Yourself" chat anytime</small>
      </div>
      <div class="links">
        ${statusBadge}
        <a href="/api/metrics">JSON API</a>
        <a href="/metrics">Prometheus</a>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="label">Total Wishes Sent</div><div class="val" style="color:#38bdf8;">${snap.totals.wishesSent}</div></div>
      <div class="card"><div class="label">Wish Msgs Detected</div><div class="val">${snap.totals.wishCandidatesDetected}</div></div>
      <div class="card"><div class="label">Manual Wishes by You</div><div class="val" style="color:#a78bfa;">${snap.totals.manualWishesDetected}</div></div>
      <div class="card"><div class="label">Gemini Calls</div><div class="val">${snap.totals.geminiCalls}</div><small style="color:#64748b;">Model: ${escapeHtml(snap.lastModelUsed)}</small></div>
      <div class="card"><div class="label">Faults / Errors</div><div class="val" style="color:${snap.totals.faultsTotal > 0 ? '#f87171' : '#22c55e'};">${snap.totals.faultsTotal}</div></div>
      <div class="card"><div class="label">Uptime</div><div class="val">${uptimeHours}h</div><small style="color:#64748b;">Reconnects: ${snap.reconnectCount}</small></div>
    </div>

    <h2>📊 Wishes Per Group (${snap.groups.length} Whitelisted Groups)</h2>
    <table>
      <thead>
        <tr>
          <th>Group</th>
          <th>Wishes Sent</th>
          <th>By Occasion</th>
          <th>Detected</th>
          <th>Manual (You)</th>
          <th>Cooldown Skips</th>
          <th>Last Wish Sent</th>
        </tr>
      </thead>
      <tbody>${groupRows}</tbody>
    </table>

    <h2>⚠️ Recent Faults &amp; Errors</h2>
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Category</th>
          <th>Group</th>
          <th>Error Message</th>
        </tr>
      </thead>
      <tbody>${faultRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

const port = Number(process.env.PORT || 8080);
http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/metrics' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bot.metrics.getSnapshot(), null, 2));
      return;
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(bot.metrics.toPrometheus());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml(bot.metrics.getSnapshot()));
  })
  .listen(port, () => {
    console.log(`🌐 Observability dashboard & metrics server listening on port ${port}`);
  });

bot.start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  bot.metrics.recordFault('startup_fatal_error', err);
  process.exit(1);
});
