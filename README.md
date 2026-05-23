# Tesla Siri Server

Control your Tesla with natural voice commands through Siri — powered by **Groq (free Llama 3.3)**, the Tesla Fleet API, and a Node.js server deployed on Railway.

Say **"Hey Siri, Car — let's go home"** and your Tesla navigates home, sets the temperature to 22°, starts the climate, and texts your ETA. All in one breath.

---

## What it does

- **Natural language commands** via Siri → Groq/Llama AI → Tesla action
- **Smart macros** — instant phrases ("let's go home") that run multiple actions without any AI roundtrip
- **Multi-action commands** — navigate + climate + message in a single voice command
- **Auto ETA messaging** — calculates real driving time via OSRM routing and texts your contact
- **Live dashboard** — browser UI with battery gauge, quick controls, and AI chat
- **Auto token refresh** — Tesla OAuth tokens refresh every 6 hours
- **MCP server** — also works as a Claude Desktop plugin

---

## Voice command examples

| Say this | What happens |
|---|---|
| "Let's go home" | Navigate home + climate 22° + text ETA to contact |
| "Drive to work" | Navigate to work + climate 22° |
| "What's my battery?" | Speaks current battery % and range |
| "Lock the car" | Locks all doors |
| "Turn on sentry" | Enables sentry mode |
| "Set temp to 21" | Sets cabin temperature |
| "Charge to 80 percent" | Sets charge limit |
| "Plan a route via Costa Coffee then home" | Multi-stop navigation |

---

## Architecture

```
Siri Shortcut (iPhone)
       │  POST /chat  { message, session }
       ▼
Express Server (Railway — port from env)
       │
       ├── Macro match? ──► Run steps instantly (no AI)
       │
       ├── Groq Llama 3.3 ──► Parse intent → tool + params
       │
       └── Tesla Fleet API (EU) ──► Vehicle commands
               │
               └── OSRM routing ──► Real drive-time ETA
```

---

## Prerequisites

- **Node.js 18+** and **npm**
- **Tesla Developer account** — [developer.tesla.com](https://developer.tesla.com)
- **Groq API key** (free) — [console.groq.com](https://console.groq.com)
- **Railway account** (free tier works) — [railway.app](https://railway.app)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/tesla-siri.git
cd tesla-siri
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` — from your Tesla developer app
- `TESLA_VIN` — found on your Tesla touchscreen under Controls → Software
- `HOME_ADDRESS` and `WORK_ADDRESS` — used when you say "home" or "work"
- `GROQ_API_KEY` — free from [console.groq.com](https://console.groq.com)
- `SIRI_SECRET` — any random string to protect your endpoints
- `CONTACT_<NAME>=<phone>` — e.g. `CONTACT_PRIYA=+44...` for SMS notifications

### 3. Generate Tesla key pair

```bash
node generate-keys.mjs
```

Creates `tesla-public.pem` and `tesla-private.pem`. The public key is served at `/.well-known/appspecific/com.tesla.3p.public-key.pem` — Tesla verifies it during partner registration.

> `tesla-private.pem` is in `.gitignore` — never commit it.

### 4. Get Tesla tokens

Get a partner token and print the OAuth URL:

```bash
node get-tesla-token.mjs
```

Open the printed URL in your browser, log in with your Tesla account, approve permissions. Tesla redirects to `http://localhost:5431/mcp?code=XXXX` — copy the `code=` value.

Exchange it for your user tokens:

```bash
node exchange-code.mjs PASTE_CODE_HERE
```

This writes `TESLA_ACCESS_TOKEN` and `TESLA_REFRESH_TOKEN` to `.env`. Tokens auto-refresh every 6 hours.

### 5. Deploy to Railway

**Option A — GitHub (recommended):**

1. Push your repo to GitHub (make sure `.env` and `*.pem` are in `.gitignore`)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Add all environment variables from your `.env` in Railway's Variables tab:
   - Copy every variable from `.env`, including `TESLA_REFRESH_TOKEN`
   - **Critical**: `TESLA_REFRESH_TOKEN` is how the server authenticates after restarts
5. Railway auto-detects `railway.toml` and builds + starts the server

**Option B — Railway CLI:**

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

After deployment, your app URL will be `https://your-app.railway.app`.

### 6. Register with Tesla

Once the server is live, register your Railway domain with Tesla:

```bash
node get-tesla-token.mjs your-app.railway.app
```

This tells Tesla where to find your public key and allow API calls from your domain.

In the **Tesla Developer Portal**, add your Railway URL to **Allowed Origins**.

### 7. Complete Vehicle Command Protocol (VCP) setup

For climate, charging, and window commands, Tesla requires key pairing:

1. Make sure your Railway server is running
2. Open the **Tesla mobile app**
3. Go to **Security & Privacy → Manage Third-Party Apps**
4. Find your app → **Grant Access**

Navigation, horn, lights, lock/unlock, and status commands work without VCP.

### 8. Test locally

```bash
npm run dev:siri
```

Dashboard at `http://localhost:3000`. Test AI at `http://localhost:3000/api/test-ai`.

---

## Siri Shortcut setup (iPhone)

Create a shortcut named **"Car"** (so you say *"Hey Siri, Car, let's go home"*):

| Step | Action | Settings |
|---|---|---|
| 1 | **Dictate Text** | Language: your language |
| 2 | **Get Contents of URL** | URL: `https://your-app.railway.app/chat?secret=<SIRI_SECRET>` · Method: POST · Body: JSON · Fields: `message` = Dictated Text, `session` = `siri-main` |
| 3 | **Get Dictionary Value** | Key: `reply` · From: Contents of URL |
| 4 | **Get Dictionary Value** | Key: `sms_to` · From: Contents of URL |
| 5 | **Get Dictionary Value** | Key: `sms_body` · From: Contents of URL |
| 6 | **If** `sms_to` has any value → **Send Message** (Message: `sms_body`, Recipients: `sms_to`) · **End If** |
| 7 | **Speak** `reply` |

---

## Custom macros

Macros are instant multi-action phrases — no AI needed. Edit `MACROS` in `src/siri-server.ts`:

```typescript
"saturday drive": {
  steps: [
    { tool: 'start_climate',   params: {} },
    { tool: 'set_temperature', params: { tempC: 20 } },
  ],
  reply: "Car is warming up for your drive.",
},
```

Rebuild and redeploy after changes.

---

## Adding contacts

In Railway Variables (or `.env`), add one line per contact:

```
CONTACT_PRIYA=Priya
CONTACT_MOM=+41791234567
CONTACT_OFFICE=office@example.com
```

Use a phone number for SMS, a name for iMessage lookup. The name (before `=`) is what you say: "tell Priya I'm on my way".

---

## API endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | SIRI_SECRET | Live dashboard |
| `/chat` | POST | SIRI_SECRET | Conversational AI + macros (Siri target) |
| `/siri` | GET/POST | SIRI_SECRET | Single-shot command (`?cmd=lock`) |
| `/api/status` | GET | SIRI_SECRET | Raw vehicle JSON |
| `/api/command` | POST | SIRI_SECRET | Run a command from dashboard |
| `/api/test-ai` | GET | none | Test Groq AI connectivity |
| `/health` | GET | none | Server + token status |
| `/commands` | GET | none | List all tools and aliases |

Auth: pass `?secret=<SIRI_SECRET>` or header `x-siri-secret: <SIRI_SECRET>`.

---

## Project structure

```
tesla-siri/
├── src/
│   ├── siri-server.ts      Main server — Express, Groq AI, macros, /chat, dashboard
│   ├── index.ts            MCP server (Claude Desktop integration)
│   ├── tools/
│   │   └── index.ts        Tesla tool definitions (19 tools)
│   └── utils/
│       ├── tesla-client.ts Tesla Fleet API HTTP client
│       └── token-manager.ts OAuth token lifecycle (refresh, persist)
├── get-tesla-token.mjs     Partner token + Tesla registration
├── exchange-code.mjs       Auth code → user token exchange
├── generate-keys.mjs       EC key pair generation for VCP
├── railway.toml            Railway deployment config
├── CLAUDE.md               Project memory for Claude Code
├── .env.example            Environment template
└── tsconfig.json
```

---

## Troubleshooting

**AI not responding / "I didn't catch that"**
Visit `/api/test-ai` to check Groq connectivity. Ensure `GROQ_API_KEY` is set.

**403: Tesla Vehicle Command Protocol required**
Complete VCP key pairing in the Tesla app (Setup step 7). Navigation and basic commands still work without it.

**Token expired / login_required**
Run `node get-tesla-token.mjs` and `node exchange-code.mjs <code>` locally to get fresh tokens, then update `TESLA_REFRESH_TOKEN` in Railway Variables.

**"Could not find location"**
Check `HOME_ADDRESS` and `WORK_ADDRESS` are full addresses with city and country.

**Public key 404**
`tesla-public.pem` not found. Run `node generate-keys.mjs` and ensure `TESLA_PUBLIC_KEY_FILE` points to it (or set the file path in Railway).

---

## License

MIT — use freely, contribute back if you build something cool.
