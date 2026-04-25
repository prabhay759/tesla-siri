# 🚗 Tesla Siri Server

Control your Tesla with natural voice commands through Siri — powered by Google Gemini AI, the Tesla Fleet API, and a self-hosted Node.js server.

Say **"Hey Siri, Tesla — let's go home"** and your car navigates home, sets the temperature to 22°, starts the climate, and texts your closed ones your ETA. All in one breath.

---

## What it does

- **Natural language commands** via Siri → Gemini AI → Tesla action
- **Smart macros** — one-shot phrases ("let's go home") that run multiple actions instantly
- **Multi-action compound commands** — navigate + climate + message in a single voice command
- **Auto ETA messaging** — calculates real driving time via OSRM routing and texts your contact
- **Live dashboard** — browser UI at `http://localhost:3000` with battery gauge, controls, and AI chat
- **Auto token refresh** — Tesla tokens refresh every 6 hours, server survives reboots via Task Scheduler
- **MCP server** — also works as a Claude Desktop plugin for AI-assisted car control

---

## Voice command examples

| Say this | What happens |
|---|---|
| "Let's go home" | Navigate home + climate 22° + text Priya with ETA |
| "Drive to work" | Navigate to work + climate 22° |
| "What's my battery?" | Speaks current battery % and range |
| "Lock the car" | Locks all doors |
| "Turn on sentry" | Enables sentry mode |
| "Set temp to 21" | Sets cabin temperature |
| "Charge to 80 percent" | Sets charge limit |
| "Help me plan a route via Costa Coffee then home" | Multi-stop navigation with AI |

---

## Architecture

```
Siri Shortcut (iPhone)
       │  POST /chat  { message, session }
       ▼
Express Server (localhost:3000)
       │
       ├── Macro match? ──► Run steps instantly (no AI needed)
       │
       ├── Gemini 2.5 Flash ──► Parse intent → tool + params
       │
       └── Tesla Fleet API (EU) ──► Vehicle commands
               │
               └── OSRM routing ──► Real drive-time ETA
```

---

## Prerequisites

- **Node.js 18+** and **npm**
- **Tesla Developer account** — [developer.tesla.com](https://developer.tesla.com)
- **ngrok account** (free) — for Tesla partner registration
- **Google Gemini API key** (free) — [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Windows PC that stays on (or any always-on machine)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/tesla-mcp.git
cd tesla-mcp
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` from your Tesla developer app
- `TESLA_VIN` — found on your Tesla touchscreen under Controls → Software
- `HOME_ADDRESS` and `WORK_ADDRESS` — used when you say "home" or "work"
- `GEMINI_API_KEY` — free from Google AI Studio
- `CONTACT_PRIYA` — name or phone number for auto-messaging (rename to your contact)

### 3. Generate Tesla key pair

```bash
node generate-keys.mjs
```

This creates `tesla-public.pem` and `tesla-private.pem`. The public key is served at `/.well-known/appspecific/com.tesla.3p.public-key.pem` — Tesla verifies it during partner registration.

> ⚠️ `tesla-private.pem` is in `.gitignore` — never commit it.

### 4. Get a Tesla user token

**Start the server and ngrok first:**

```powershell
.\start-tesla.ps1
```

Then register your app with Tesla and get an auth URL:

```bash
node get-tesla-token.mjs your-ngrok-domain.ngrok-free.dev
```

Open the printed URL in your browser, log in with your Tesla account, approve permissions. Tesla redirects to `http://localhost:5431/mcp?code=XXXX` — copy the `code=` value.

Exchange the code for tokens:

```bash
node exchange-code.mjs PASTE_CODE_HERE
```

This writes your `access_token` and `refresh_token` to `.env`. Tokens auto-refresh every 6 hours — you should never need to do this again unless you revoke access.

### 5. Complete Vehicle Command Protocol (VCP) setup

For climate, charging, and window commands, Tesla requires key pairing:

1. Make sure your server is running with ngrok active
2. Open the **Tesla mobile app**
3. Go to **Security & Privacy → Manage Third-Party Apps**
4. Find your app and tap **Grant Access**

Navigation, horn, lights, lock/unlock, and status commands work without VCP.

### 6. Start the server

```bash
npm run dev:siri
```

Or double-click `start-server-now.bat`.

The dashboard is at **http://localhost:3000**.

### 7. Auto-start on login (Windows)

Run once as Administrator:

```powershell
.\install-autostart.ps1
```

To remove: `.\install-autostart.ps1 -Remove`

---

## Siri Shortcut setup (iPhone)

Create a new shortcut named **Tesla** with these steps:

| Step | Action | Settings |
|---|---|---|
| 1 | **Dictate Text** | Language: your language |
| 2 | **Get Contents of URL** | URL: `https://your-ngrok.ngrok-free.dev/chat` · Method: POST · Body: JSON · Fields: `message` = Dictated Text, `session` = `siri-main` |
| 3 | **Get Dictionary Value** | Key: `reply` · From: Contents of URL → save as `ReplyText` |
| 4 | **Get Dictionary Value** | Key: `sms_to` · From: Contents of URL → save as `SmsTo` |
| 5 | **Get Dictionary Value** | Key: `sms_body` · From: Contents of URL → save as `SmsBody` |
| 6 | **If** `SmsTo` has any value → **Send Message** (Message: `SmsBody`, Recipients: `SmsTo`) · **End If** |
| 7 | **Speak** | `ReplyText` |

> **Tip:** Rename the shortcut to something short like **"Car"** so you say *"Hey Siri, Car, let's go home"*.

---

## Custom macros

Macros are instant multi-action phrases — no AI roundtrip, fire immediately. Edit the `MACROS` object in `src/siri-server.ts`:

```typescript
"saturday drive": {
  steps: [
    { tool: 'start_climate',   params: {} },
    { tool: 'set_temperature', params: { tempC: 20 } },
  ],
  reply: "Car is warming up for your drive.",
},
```

Restart the server to pick up changes.

---

## Adding contacts

In `.env`, add one line per contact:

```env
CONTACT_PRIYA=Priya
CONTACT_MOM=+41791234567
CONTACT_OFFICE=office@example.com
```

Use a phone number for SMS, a name for iMessage lookup, or an email for iMessage. The name (before the `=`) is what you say in voice commands — "tell Priya I'm on my way".

---

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Live dashboard |
| `/chat` | POST | Conversational AI + macro dispatch (Siri shortcut target) |
| `/siri` | GET/POST | Single-shot command (`?cmd=lock`) |
| `/api/status` | GET | Raw vehicle JSON |
| `/api/command` | POST | Run a command from the dashboard |
| `/api/test-gemini` | GET | Debug Gemini connectivity |
| `/health` | GET | Server + token status |
| `/commands` | GET | List all tools and aliases |

---

## Project structure

```
tesla-mcp/
├── src/
│   ├── siri-server.ts      # Main server — Express, Gemini, macros, /chat
│   ├── index.ts            # MCP server (Claude Desktop integration)
│   ├── tools/
│   │   └── index.ts        # Tesla tool definitions (plan_route, climate, etc.)
│   └── utils/
│       ├── tesla-client.ts # Tesla Fleet API HTTP client
│       └── token-manager.ts# OAuth token lifecycle (refresh, persist)
├── get-tesla-token.mjs     # Partner token + registration script
├── exchange-code.mjs       # Auth code → user token exchange
├── generate-keys.mjs       # EC key pair generation for VCP
├── install-autostart.ps1   # Windows Task Scheduler setup
├── start-server-now.bat    # Quick launch
├── .env.example            # Environment template (copy to .env)
└── tsconfig.json
```

---

## Troubleshooting

**"Sorry, I didn't understand"**
Run `http://localhost:3000/api/test-gemini` — check which models are available for your API key.

**403: Tesla Vehicle Command Protocol required**
Complete the VCP key pairing in the Tesla app (see Setup step 5). Navigation and basic commands still work without it.

**Token expired / login_required**
Run `node get-tesla-token.mjs` and `node exchange-code.mjs <code>` to get fresh tokens.

**"Could not find location"**
Check your `HOME_ADDRESS` and `WORK_ADDRESS` in `.env` are full addresses with city and country.

**ngrok URL changed**
Run `.\start-tesla.ps1` to get the new URL, then re-run `node get-tesla-token.mjs <new-domain>`.

---

## License

MIT — use freely, contribute back if you build something cool.
