# WhatsApp Group Birthday & Festival Auto-Wish Bot 🎂🎉

A lightweight, 24/7 WhatsApp group auto-reply bot built with **Node.js**, **`@whiskeysockets/baileys`**, and **Google Gemini (`gemini-2.5-flash`)**.

## Why This Stack for 24/7 Always-On Operation (Even When Your Computer Sleeps)

1. **WhatsApp Multi-Device WebSocket Protocol (`@whiskeysockets/baileys`)**:
   - Links as a companion device on your WhatsApp account (just like WhatsApp Web/Desktop).
   - Once hosted in the cloud, **neither your laptop nor your phone needs to stay awake**.
   - Uses pure WebSockets (~40MB RAM) instead of launching a heavy headless Chrome browser (`whatsapp-web.js` uses 500MB–1GB+ RAM), so it runs reliably on the smallest/cheapest cloud containers or free-tier VMs.
2. **Cloud-Friendly Phone Pairing Code**:
   - Supports linking via an **8-character Pairing Code** (`PAIRING_PHONE_NUMBER` in `.env`) in addition to QR codes, making it effortless to link from cloud server logs.

---

## Key Features

- **Group Whitelist (`ALLOWED_GROUPS`)**: Only monitors and replies in groups you explicitly allow (matched by Group Name or Group ID).
- **Hybrid Detection (`MIN_WISHERS=2` or `3`)**:
  1. Fast local regex/keyword filter detects potential birthday, anniversary, and festival wishes in a sliding window (`WINDOW_MINUTES=45`).
  2. Once `MIN_WISHERS` unique group members wish within the window, **Gemini (`gemini-2.5-flash`)** analyzes the messages to confirm the occasion, identify who is being wished, and write a natural, warm 1-sentence wish matching the group's language/vibe.
  3. **Self-Wish Protection**: Automatically detects if the group is wishing *you* on your own birthday and skips auto-replying.
- **Strict >= 2-Day Cooldown (`COOLDOWN_HOURS=48`)**:
  - Persists wish history in `data/wish_history.json` so it enforces at least a **2-day (48-hour) delay** before wishing the same event/person again (and optionally `GROUP_GLOBAL_COOLDOWN_HOURS=48` if you want at least 2 days between *any* two wishes in the same group).
- **Human-like Random Delay & Manual Override**:
  - Waits a random delay (`45s–180s` by default) and sends a 3-second `"typing..."` indicator before sending.
  - If you manually send a wish from your phone during the delay countdown, the bot automatically cancels its pending auto-wish.

---

## Quick Start (Local Setup)

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create your `.env` file**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set:
   - `GEMINI_API_KEY`: Your free Gemini API key from https://aistudio.google.com/apikey
   - `ALLOWED_GROUPS`: Comma-separated group names (e.g. `Family,College Friends,Work`)

3. **Start the bot**:
   ```bash
   npm start
   ```
   Scan the QR code printed in your terminal (or set `PAIRING_PHONE_NUMBER` in `.env` to get an 8-digit pairing code). On startup, the bot also prints all your WhatsApp group names and IDs so you can easily copy them into `ALLOWED_GROUPS`.

---

## Running 24/7 (When Your Computer is Asleep)

To keep the bot running 24/7 while your laptop is closed/asleep, deploy it to a cloud host with a **persistent volume** mounted at `/app/data` (so your WhatsApp login session and 2-day cooldown state survive restarts):

### Option A: Railway (Easiest Cloud Deploy)
1. Push this repo to a private GitHub repository.
2. Create a new project on Railway from your GitHub repo (it will automatically detect [Dockerfile](./Dockerfile) and [railway.json](./railway.json)).
3. Add a **Volume** mounted at `/app/data`.
4. Add your `.env` variables in Railway's **Variables** tab (set `PAIRING_PHONE_NUMBER` to your phone number with country code so Railway prints an 8-digit login code in the deploy logs).

### Option B: Free 24/7 Cloud VM (Oracle Cloud Free Tier / GCP e2-micro / AWS Free Tier)
1. SSH into your Linux VM, clone this repo, and create `.env`.
2. Run with Docker Compose or PM2:
   ```bash
   npm install -g pm2
   pm2 start src/index.js --name whatsapp-wish-bot
   pm2 save
   pm2 startup
   ```
