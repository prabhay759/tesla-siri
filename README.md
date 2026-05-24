# Tesla Siri Server

Control your Tesla with **Siri**, **HomeKit**, **Claude**, and any AI agent — powered by Groq (free Llama 3.3 AI) and deployed on Railway. No always-on computer, no ngrok.

Say **"Hey Siri, Car — warm up the car"** and your Tesla starts climate and sets temperature. Or ask Claude: *"Lock my car and set the charge limit to 80%"* — and it does both at once.

---

## What it does

- **Siri voice commands** — natural language via Groq AI (free)
- **HomeKit accessories** — lock, climate, sentry, charging, temperature as native Home app tiles
- **Smart macros** — instant multi-step phrases that fire without any AI roundtrip
- **Auto ETA SMS** — calculates real drive time and texts your contact
- **Live dashboard** — browser UI with battery arc, quick controls, and AI chat
- **MCP server** — Claude Desktop, Claude.ai, and any MCP-compatible AI agent can control your car
- **Auto token refresh** — Tesla tokens refresh every 6 hours, survives restarts

---

## Voice command examples

| Say this | What happens |
|---|---|
| "Let's go home" | Navigate home + climate 22° + text ETA |
| "Drive to work" | Navigate to work + climate 22° |
| "Warm up the car" | Climate on at 22° |
| "What's my battery?" | Speaks battery % and range |
| "Lock the car" | Locks all doors |
| "Turn on sentry" | Enables sentry mode |
| "Set temp to 21" | Sets cabin temperature |
| "Charge to 80 percent" | Sets charge limit |
| "Plan a route via Costa Coffee then home" | Multi-stop navigation |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INPUT SOURCES                               │
│                                                                     │
│  📱 Siri Shortcut     🤖 Claude Desktop    🌐 Claude.ai / Agents   │
│  "Hey Siri, Car..."   Claude Desktop app   claude.ai browser        │
│  POST /chat           /mcp or /sse         /mcp (remote)            │
└────────────┬──────────────────┬─────────────────────┬──────────────┘
             │                  │                     │
             ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    RAILWAY SERVER (siri-server.ts)                  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Auth middleware — x-siri-secret header or ?secret= param   │   │
│  └───────────────────────────────┬─────────────────────────────┘   │
│                                  │                                  │
│         POST /chat               │         POST /mcp                │
│  ┌───────────────────────┐       │   ┌──────────────────────────┐  │
│  │  1. Macro match?      │       │   │  MCP tool dispatcher     │  │
│  │     → instant reply   │       │   │  (19 Tesla tools)        │  │
│  │  2. Groq Llama 3.3    │       │   │  get_battery             │  │
│  │     → parse intent    │       │   │  lock_doors              │  │
│  │  3. Keyword fallback  │       │   │  start_climate           │  │
│  └──────────┬────────────┘       │   │  set_charge_limit ...    │  │
│             │                    │   └──────────┬───────────────┘  │
│             └────────────────────┼──────────────┘                  │
│                                  ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Tesla Fleet API (EU)                                       │   │
│  │  fleet-api.prd.eu.vn.cloud.tesla.com                        │   │
│  │  • Auto-wake vehicle (5 retries × 3s)                       │   │
│  │  • OAuth2 token (auto-refreshes every 6h)                   │   │
│  │  • 401 → invalidate + retry once                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────────┘
                             │  GET /homekit/* (polled every 3s)
                             │  60-second status cache prevents
                             │  waking sleeping car on every poll
                             ▼
             ┌──────────────────────────────┐
             │  Homebridge                  │
             │  (Raspberry Pi / Mac / NAS)  │
             │  homebridge-http-switch      │
             │  homebridge-http-thermostat  │
             └──────────────┬───────────────┘
                            ▼
             ┌──────────────────────────────┐
             │  Apple Home app              │
             │  🔒 Lock  🌡 Climate         │
             │  👁 Sentry  ⚡ Charging      │
             └──────────────────────────────┘
```

### Request flow — Siri voice command

```
"Hey Siri, warm up my car"
        │
        ▼
Shortcuts app dictates text
        │  POST /chat  { "message": "warm up my car" }
        ▼
Railway server receives request
        │
        ├─► Macro check: "warm up" → matched!
        │   Runs: start_climate + set_temperature(22°)
        │   Returns: { "reply": "Climate on and set to 22°" }
        │
        ▼  (if no macro match)
        ├─► Groq Llama 3.3 parses intent → { tool: "start_climate" }
        │
        ▼
Tesla Fleet API → vehicle command
        │
        ▼
{ "reply": "Climate started." } ──► Siri speaks it aloud
```

### Request flow — Claude / AI agent

```
User asks Claude: "What's my battery and lock the car"
        │
        ▼
Claude calls MCP tools in sequence:
  1. get_battery   → "Battery: 78%, 230 km range"
  2. lock_doors    → "Doors locked"
        │
        ▼
Claude replies: "Your battery is at 78% (230 km range) and I've locked the car."
```

---

## Prerequisites

- **Tesla Developer account** — [developer.tesla.com](https://developer.tesla.com) (free)
- **Groq API key** (free) — [console.groq.com](https://console.groq.com)
- **Railway account** (free tier) — [railway.app](https://railway.app)
- **GitHub account** — to fork the repo and link to Railway

> **No laptop?** Follow the [Phone-only setup](#phone-only-setup-no-laptop-needed) section below.

---

## Part 1 — One-time setup (with a laptop)

These steps run on your machine once. After this, everything lives on Railway.

### 1. Clone and install

```bash
git clone https://github.com/your-username/tesla-siri.git
cd tesla-siri
npm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Fill in:
- `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` — from [developer.tesla.com](https://developer.tesla.com) → your app
- `TESLA_VIN` — Tesla touchscreen → Controls → Software → Additional Vehicle Info
- `GROQ_API_KEY` — from [console.groq.com](https://console.groq.com) (free, no credit card)
- `SIRI_SECRET` — any random string (acts as your password)
- `HOME_ADDRESS` and `WORK_ADDRESS` — full address with city and country
- `CONTACT_PRIYA=+44...` — rename to your contact, used for ETA SMS

### 3. Generate Tesla key pair

```bash
node generate-keys.mjs
```

Creates `tesla-public.pem` and `tesla-private.pem`. Keep both files safe — never commit them.

### 4. Get your Tesla tokens

```bash
node get-tesla-token.mjs
```

Open the URL it prints in your browser. Log in with your Tesla account and approve permissions. Tesla redirects to `http://localhost:5431/mcp?code=XXXX` — the page won't load, just copy the `code=` value from the URL bar.

```bash
node exchange-code.mjs PASTE_CODE_HERE
```

This writes `TESLA_REFRESH_TOKEN` to your `.env`. You will need this for Railway.

---

## Phone-only setup (no laptop, no Docker, no commands)

Every setup step runs in your phone browser via endpoints built into the Railway server. You need nothing installed locally.

### Phone Step 1 — Create a Tesla Developer app

On your phone, go to [developer.tesla.com](https://developer.tesla.com):

1. Sign in → **Create Application**
2. Fill in a name (e.g. "Tesla Siri"), select the scopes: `vehicle_device_data`, `vehicle_cmds`, `vehicle_charging_cmds`
3. Add an allowed redirect URI: `https://YOUR-APP.railway.app/oauth/callback`
4. Save — copy your **Client ID** and **Client Secret**

### Phone Step 2 — Deploy to Railway

1. Go to [railway.app](https://railway.app) → sign up with GitHub
2. **New Project** → **Deploy from GitHub repo** → select this repo
3. Railway detects `railway.toml` automatically and starts deploying
4. Go to **Variables** and add these (Railway redeploys automatically when you save):

| Variable | Where to get it |
|---|---|
| `TESLA_CLIENT_ID` | Tesla Developer Portal (step 1) |
| `TESLA_CLIENT_SECRET` | Tesla Developer Portal (step 1) |
| `TESLA_VIN` | Tesla app → Manage → About |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) (free, no card) |
| `SIRI_SECRET` | make up any password string |
| `TESLA_REDIRECT_URI` | `https://YOUR-APP.railway.app/oauth/callback` |
| `HOME_ADDRESS` | `123 Your Street, City, Country` |
| `WORK_ADDRESS` | optional |

Wait ~2 minutes for Railway to finish deploying. Your app URL is shown in the Railway dashboard.

### Phone Step 3 — Generate your Tesla keys (on the server)

Open in Safari — **no commands needed**:

```
https://YOUR-APP.railway.app/setup/keys?secret=YOUR_SIRI_SECRET
```

A page appears with your generated public and private keys. Copy each one and add to Railway Variables:

| Variable | Value |
|---|---|
| `TESLA_PUBLIC_KEY` | copy from `/setup/keys` page |
| `TESLA_PRIVATE_KEY` | copy from `/setup/keys` page (optional, for signed VCP) |

Railway redeploys automatically after you save.

### Phone Step 4 — Register your domain with Tesla (on the server)

Once redeployed, open:

```
https://YOUR-APP.railway.app/setup/register?secret=YOUR_SIRI_SECRET
```

This page automatically gets a partner token and registers your Railway domain with Tesla Fleet API. It also confirms your public key is reachable. If it shows a failure, wait a minute and refresh — the key endpoint needs the redeploy from step 3 to be live.

Also go to **developer.tesla.com** → your app → **Allowed Origins** → add `https://YOUR-APP.railway.app`.

### Phone Step 5 — Get your Tesla refresh token (on the server)

Open:

```
https://YOUR-APP.railway.app/oauth/start
```

This redirects you to Tesla's login page. Log in, approve permissions. Tesla sends you back to `/oauth/callback` on your server, which shows your `TESLA_REFRESH_TOKEN` with a copy button.

Copy it and add to Railway Variables:

| Variable | Value |
|---|---|
| `TESLA_REFRESH_TOKEN` | paste from the callback page |

Railway redeploys one final time.

### Phone Step 6 — VCP pairing

Tesla app → **Security & Privacy → Manage Third-Party Apps** → find your app → **Grant Access**.

### Phone Step 7 — Verify

Open `https://YOUR-APP.railway.app/health` — if `token_type` is `"user"`, you're fully live.

---

## Self-hosting with Docker

If you prefer Docker over Railway (or want to run it on a VPS, NAS, or home server):

```bash
docker build -t tesla-siri .

docker run -d \
  --name tesla-siri \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TESLA_CLIENT_ID=your-id \
  -e TESLA_CLIENT_SECRET=your-secret \
  -e TESLA_VIN=your-vin \
  -e TESLA_REFRESH_TOKEN=your-token \
  -e GROQ_API_KEY=your-key \
  -e SIRI_SECRET=your-password \
  -e TESLA_PUBLIC_KEY="$(cat tesla-public.pem)" \
  -e HOME_ADDRESS="123 Your Street, City, Country" \
  tesla-siri
```

Or use a `.env` file:

```bash
docker run -d --name tesla-siri --restart unless-stopped \
  -p 3000:3000 --env-file .env tesla-siri
```

The same `/setup/keys`, `/setup/register`, and `/oauth/start` endpoints work identically when self-hosting — just replace `railway.app` with your server's URL.

---

## Part 2 — Railway deployment (with laptop)

### 5. Push to GitHub

Make sure `.gitignore` excludes `.env` and `*.pem`, then push your repo.

### 6. Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your `tesla-siri` repository
3. Railway detects `railway.toml` and configures the build automatically

### 7. Set environment variables in Railway

Go to your project → **Variables** → add each one:

| Variable | Value |
|---|---|
| `TESLA_CLIENT_ID` | from developer.tesla.com |
| `TESLA_CLIENT_SECRET` | from developer.tesla.com |
| `TESLA_VIN` | your car's VIN |
| `TESLA_REFRESH_TOKEN` | from your `.env` after step 4 |
| `GROQ_API_KEY` | from console.groq.com |
| `SIRI_SECRET` | your chosen password string |
| `TESLA_PUBLIC_KEY` | paste the **entire contents** of `tesla-public.pem` |
| `HOME_ADDRESS` | `123 Your Street, City, Country` |
| `WORK_ADDRESS` | optional |
| `CONTACT_PRIYA` | phone number e.g. `+44791234567` |

> **`TESLA_PUBLIC_KEY`** — open `tesla-public.pem` in a text editor, select all (including `-----BEGIN PUBLIC KEY-----` header/footer lines), paste as the variable value.

Railway auto-deploys after you save variables. Your app URL is `https://your-app.railway.app`.

### 8. Register with Tesla

Run locally once (swap in your actual Railway domain):

```bash
node get-tesla-token.mjs your-app.railway.app
```

Then in the [Tesla Developer Portal](https://developer.tesla.com) → your app → **Allowed Origins**, add:
```
https://your-app.railway.app
```

### 9. VCP key pairing (for climate / charging / windows)

1. Open the **Tesla mobile app**
2. Go to **Security & Privacy → Manage Third-Party Apps**
3. Find your app → tap **Grant Access**

> Lock/unlock, horn, lights, flash, navigation, and status all work without VCP. Climate, charging, temperature, and windows require it.

---

## Part 3 — Siri Shortcut

Create a shortcut named **"Car"** so you say *"Hey Siri, Car, lock the doors"*.

| Step | Action | Settings |
|---|---|---|
| 1 | **Dictate Text** | Language: your language |
| 2 | **Get Contents of URL** | URL: `https://your-app.railway.app/chat?secret=SIRI_SECRET` · Method: POST · Body: JSON |
| | | Field `message` = Dictated Text |
| | | Field `session` = `siri-main` |
| 3 | **Get Dictionary Value** | Key: `reply` from Contents of URL |
| 4 | **Get Dictionary Value** | Key: `sms_to` from Contents of URL |
| 5 | **Get Dictionary Value** | Key: `sms_body` from Contents of URL |
| 6 | **If** `sms_to` has any value | → **Send Message** (body: `sms_body`, to: `sms_to`) → **End If** |
| 7 | **Speak** `reply` | |

---

## Part 4 — HomeKit via Homebridge

Homebridge runs on any always-on device (Raspberry Pi, Mac Mini, NAS). It reads your Railway server's `/homekit/*` endpoints and exposes your Tesla as native HomeKit accessories.

### Install Homebridge

```bash
# On Raspberry Pi or Mac
sudo npm install -g homebridge homebridge-http-switch
```

Then visit `http://your-homebridge-ip:8581` to open the Homebridge UI.

### Install required plugins

In the Homebridge UI → **Plugins**, search and install:
- `homebridge-http-switch` — for lock, climate, sentry, charging
- `homebridge-http-thermostat` — for temperature control

Or via CLI:
```bash
sudo npm install -g homebridge-http-switch homebridge-http-thermostat
```

### Homebridge `config.json`

Open Homebridge UI → **Config** and add this to the `accessories` array. Replace `YOUR_APP` and `YOUR_SECRET` with your values.

```json
{
  "accessories": [
    {
      "accessory": "HTTP-SWITCH",
      "name": "Tesla Lock",
      "switchType": "stateful",
      "statusUrl": "https://YOUR_APP.railway.app/homekit/lock?secret=YOUR_SECRET",
      "onUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/lock/lock?secret=YOUR_SECRET",
        "method": "POST"
      },
      "offUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/lock/unlock?secret=YOUR_SECRET",
        "method": "POST"
      },
      "statusPattern": "\"value\":1"
    },
    {
      "accessory": "HTTP-SWITCH",
      "name": "Tesla Climate",
      "switchType": "stateful",
      "statusUrl": "https://YOUR_APP.railway.app/homekit/climate?secret=YOUR_SECRET",
      "onUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/climate/on?secret=YOUR_SECRET",
        "method": "POST"
      },
      "offUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/climate/off?secret=YOUR_SECRET",
        "method": "POST"
      },
      "statusPattern": "\"value\":1"
    },
    {
      "accessory": "HTTP-SWITCH",
      "name": "Tesla Sentry",
      "switchType": "stateful",
      "statusUrl": "https://YOUR_APP.railway.app/homekit/sentry?secret=YOUR_SECRET",
      "onUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/sentry/on?secret=YOUR_SECRET",
        "method": "POST"
      },
      "offUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/sentry/off?secret=YOUR_SECRET",
        "method": "POST"
      },
      "statusPattern": "\"value\":1"
    },
    {
      "accessory": "HTTP-SWITCH",
      "name": "Tesla Charging",
      "switchType": "stateful",
      "statusUrl": "https://YOUR_APP.railway.app/homekit/charging?secret=YOUR_SECRET",
      "onUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/charging/on?secret=YOUR_SECRET",
        "method": "POST"
      },
      "offUrl": {
        "url": "https://YOUR_APP.railway.app/homekit/charging/off?secret=YOUR_SECRET",
        "method": "POST"
      },
      "statusPattern": "\"value\":1"
    },
    {
      "accessory": "HTTP-Thermostat",
      "name": "Tesla Temperature",
      "getCurrentTemperatureUrl": "https://YOUR_APP.railway.app/homekit/temperature?secret=YOUR_SECRET",
      "getCurrentTemperatureJsonPath": "current",
      "getTargetTemperatureUrl": "https://YOUR_APP.railway.app/homekit/temperature?secret=YOUR_SECRET",
      "getTargetTemperatureJsonPath": "target",
      "setTargetTemperatureUrl": "https://YOUR_APP.railway.app/homekit/temperature?secret=YOUR_SECRET",
      "setTargetTemperatureMethod": "POST",
      "setTargetTemperatureBody": "{\"value\": %s}",
      "minTemp": 15,
      "maxTemp": 30
    }
  ]
}
```

After saving, restart Homebridge. Your Tesla accessories appear in the Home app within a minute.

> **Tip:** Add your Tesla accessories to a **"Driving"** scene in the Home app: lock + sentry on + climate off — one tap before leaving.

---

## Part 5 — End-to-end tests

Run these in order after deploying. Replace `YOUR_APP` and `YOUR_SECRET` throughout.

### Test 1 — Server health

```bash
curl https://YOUR_APP.railway.app/health
```

Expected:
```json
{"status":"ok","vin":"5YJ...","ai":"groq (llama-3.3-70b-versatile → fallback chain)","token_type":"user","token_status":"valid (expires in 480m)"}
```

`token_type` must be `"user"` — if it shows `"partner"`, your `TESLA_REFRESH_TOKEN` env var is missing or expired.

### Test 2 — Groq AI

```bash
curl https://YOUR_APP.railway.app/api/test-ai
```

Expected: `test_results` showing `status: 200` and a response from at least one Groq model.

### Test 3 — Vehicle data

```bash
curl "https://YOUR_APP.railway.app/api/status?secret=YOUR_SECRET"
```

Expected: JSON with `battery`, `range_mi`, `locked`, `climate_on`, etc.

### Test 4 — AI command via chat

```bash
curl -X POST "https://YOUR_APP.railway.app/chat?secret=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"what is my battery level","session":"test"}'
```

Expected: `{"reply":"🔋 80% · 240 mi range...","session":"test"}`

### Test 5 — Direct command

```bash
curl -X POST "https://YOUR_APP.railway.app/api/command?secret=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"lock my car"}'
```

Expected: `{"reply":"✅ Doors locked"}`

### Test 6 — HomeKit lock status

```bash
curl "https://YOUR_APP.railway.app/homekit/lock?secret=YOUR_SECRET"
```

Expected: `{"value":1}` (locked) or `{"value":0}` (unlocked)

### Test 7 — HomeKit climate toggle

```bash
# Turn climate on
curl -X POST "https://YOUR_APP.railway.app/homekit/climate/on?secret=YOUR_SECRET"
# Expected: {"value":1}

# Check status (wait a few seconds)
curl "https://YOUR_APP.railway.app/homekit/climate?secret=YOUR_SECRET"
# Expected: {"value":1}

# Turn it back off
curl -X POST "https://YOUR_APP.railway.app/homekit/climate/off?secret=YOUR_SECRET"
```

### Test 8 — Dashboard

Open in browser:
```
https://YOUR_APP.railway.app/?secret=YOUR_SECRET
```

Should show the live battery gauge, climate card, and quick controls.

### Test 9 — Siri Shortcut

On your iPhone, run the shortcut and say: **"what's my battery"**

Siri should speak something like: *"Battery: 80%, 240 miles range."*

### Test 10 — HomeKit in Home app

1. Open the **Home** app on iPhone
2. Find **Tesla Climate** tile
3. Tap to toggle on → check Tesla app that climate started
4. Tap again to turn off

### Test 11 — Macro (no AI)

```bash
curl -X POST "https://YOUR_APP.railway.app/chat?secret=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"warm up the car","session":"test"}'
```

Expected: `{"reply":"Climate on and temperature set to 22°."}` — this fires instantly without calling Groq.

---

## Part 6 — Claude & AI Agents (MCP)

The Railway server is a full [Model Context Protocol](https://modelcontextprotocol.io) server. Any MCP-compatible client (Claude Desktop, Claude.ai, Cursor, Windsurf, custom agents) can connect to it and use all 19 Tesla tools.

### MCP endpoints

| Endpoint | Protocol | Notes |
|---|---|---|
| `POST /mcp` | Streamable HTTP | Recommended — modern, stateful sessions |
| `GET /mcp` | Streamable HTTP | SSE stream for existing session |
| `DELETE /mcp` | Streamable HTTP | Close session |
| `GET /sse` | SSE (legacy) | For older Claude Desktop builds |
| `POST /messages` | SSE (legacy) | Paired with `/sse` |

All MCP endpoints require the `x-siri-secret` header or `?secret=` query param.

---

### Option A — Claude Desktop (remote via Streamable HTTP)

This is the simplest option. Claude Desktop connects directly to your Railway server — no local Node.js needed.

1. Open Claude Desktop → **Settings** → **Developer** → **Edit Config**
2. Paste this into `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tesla": {
      "type": "streamable-http",
      "url": "https://YOUR-APP.railway.app/mcp",
      "headers": {
        "x-siri-secret": "YOUR_SIRI_SECRET"
      }
    }
  }
}
```

3. Restart Claude Desktop — a hammer icon appears in the chat toolbar
4. Say: *"What's my car's battery level?"* — Claude calls the `get_battery` tool and replies

> **Config file locations**
> - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
> - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

---

### Option B — Claude Desktop (SSE legacy)

Use this if Option A doesn't work with your Claude Desktop version.

```json
{
  "mcpServers": {
    "tesla": {
      "type": "sse",
      "url": "https://YOUR-APP.railway.app/sse",
      "headers": {
        "x-siri-secret": "YOUR_SIRI_SECRET"
      }
    }
  }
}
```

---

### Option C — Claude Desktop (local stdio, no Railway needed)

If you want Claude Desktop to call the car directly without going through Railway — run the MCP server locally:

1. Clone this repo and run `npm install && npm run build`
2. Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tesla": {
      "command": "node",
      "args": ["/absolute/path/to/tesla-siri/dist/index.js"],
      "env": {
        "TESLA_CLIENT_ID":     "YOUR_CLIENT_ID",
        "TESLA_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "TESLA_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN",
        "TESLA_VIN":           "YOUR_VIN",
        "MCP_MODE":            "stdio"
      }
    }
  }
}
```

3. Restart Claude Desktop

> See `claude-mcp-config.json` in the repo root for all three options side by side.

---

### Option D — Claude.ai (remote MCP, no desktop app needed)

Claude.ai supports remote MCP servers directly in the browser.

1. Go to [claude.ai](https://claude.ai) → **Settings** → **Integrations**
2. Click **Add Integration**
3. Enter:
   - **Name:** Tesla
   - **URL:** `https://YOUR-APP.railway.app/mcp`
   - **Header:** `x-siri-secret: YOUR_SIRI_SECRET`
4. Click **Save** — Tesla tools appear immediately in new conversations

Now you can chat with Claude on any device (phone, tablet, browser) and control your car.

---

### Option E — Custom AI agents (any MCP client)

Any app that speaks MCP can connect. The server endpoint is:

```
POST https://YOUR-APP.railway.app/mcp
Header: x-siri-secret: YOUR_SIRI_SECRET
```

Standard MCP initialization handshake, then `tools/call`. Available tools:

```
get_vehicle_status  get_battery         wake_vehicle
lock_doors          unlock_doors        open_trunk
set_sentry_mode     honk_horn           flash_lights
start_climate       stop_climate        set_temperature
start_charging      stop_charging       set_charge_limit
open_charge_port    vent_windows        list_vehicles
plan_route
```

Full schema at `https://YOUR-APP.railway.app/commands`.

---

### Test 12 — MCP connectivity

```bash
# Send a minimal MCP initialize request
curl -X POST "https://YOUR-APP.railway.app/mcp?secret=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0" }
    }
  }'
```

Expected: a JSON response with `protocolVersion`, `capabilities`, and `serverInfo.name: "tesla"`.

---



Edit the `MACROS` object in `src/siri-server.ts` to add instant multi-action phrases:

```typescript
"saturday drive": {
  steps: [
    { tool: 'start_climate',   params: {} },
    { tool: 'set_temperature', params: { tempC: 20 } },
  ],
  reply: "Car is warming up for your Saturday drive.",
},
```

Push to GitHub → Railway redeploys automatically.

---

## API reference

### System

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | none | Server + token status |
| `/commands` | GET | none | List all tools and aliases |
| `/api/test-ai` | GET | none | Test Groq model connectivity |

### Setup (one-time)

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/setup/keys` | GET | secret | Generate EC key pair on server |
| `/setup/register` | GET | secret | Register Railway domain with Tesla |
| `/oauth/start` | GET | none | Begin Tesla OAuth (redirects to Tesla login) |
| `/oauth/callback` | GET | none | Receives redirect, shows refresh token |

### Siri & dashboard

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | secret | Live dashboard |
| `/chat` | POST | secret | AI + macro dispatch (Siri shortcut target) |
| `/siri` | GET/POST | secret | Single-shot command (`?cmd=lock`) |
| `/api/status` | GET | secret | Raw vehicle JSON |
| `/api/command` | POST | secret | Run a command by name |

### MCP (Claude & AI agents)

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/mcp` | POST | secret | Streamable HTTP — initialize or call tools |
| `/mcp` | GET | secret | Streamable HTTP — SSE stream for active session |
| `/mcp` | DELETE | secret | Streamable HTTP — close session |
| `/sse` | GET | secret | Legacy SSE transport — open session |
| `/messages` | POST | secret | Legacy SSE transport — send message |

### HomeKit

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/homekit/lock` | GET | secret | Lock status `{"value":0/1}` |
| `/homekit/lock/lock` | POST | secret | Lock doors |
| `/homekit/lock/unlock` | POST | secret | Unlock doors |
| `/homekit/climate` | GET | secret | Climate status |
| `/homekit/climate/on` | POST | secret | Start climate |
| `/homekit/climate/off` | POST | secret | Stop climate |
| `/homekit/sentry` | GET | secret | Sentry status |
| `/homekit/sentry/on` | POST | secret | Enable sentry |
| `/homekit/sentry/off` | POST | secret | Disable sentry |
| `/homekit/charging` | GET | secret | Charging status |
| `/homekit/charging/on` | POST | secret | Start charging |
| `/homekit/charging/off` | POST | secret | Stop charging |
| `/homekit/temperature` | GET | secret | `{"current":21.5,"target":22}` |
| `/homekit/temperature` | POST | secret | Set temp — body `{"value":22}` |
| `/homekit/battery` | GET | secret | Battery % `{"value":80}` |

**Auth:** pass `?secret=SIRI_SECRET` as query param, or header `x-siri-secret: SIRI_SECRET`.

---

## Troubleshooting

**`token_type` is `"partner"` not `"user"`**
`TESLA_REFRESH_TOKEN` is missing or expired. Re-run steps 3–4 locally to get a fresh token (or use `/oauth/start` from the phone-only flow), then update the Railway env var and redeploy.

**AI not responding**
Check `GROQ_API_KEY` is set in Railway Variables. Hit `/api/test-ai` to see which models respond.

**403 Vehicle Command Protocol required**
Complete VCP key pairing (Part 1 step 9). Navigation, lock, horn, and lights work without it.

**HomeKit accessories show "No Response"**
Check the Homebridge logs. Make sure the Railway URL and `SIRI_SECRET` in your Homebridge config match exactly.

**Public key 404 on Tesla registration**
`TESLA_PUBLIC_KEY` env var not set in Railway, or server hasn't deployed yet. Check Railway logs.

**"Could not find location"**
`HOME_ADDRESS` or `WORK_ADDRESS` needs to be a full address: `123 Street, City, Country`.

**Claude Desktop shows no Tesla tools / hammer icon missing**
Verify your `claude_desktop_config.json` is valid JSON (use a JSON validator). Restart Claude Desktop fully (Quit from menu bar, not just close window). Check the Claude Desktop logs for MCP connection errors.

**MCP initialize request returns 401**
The `x-siri-secret` header value doesn't match `SIRI_SECRET` in Railway. Double-check for typos or trailing spaces.

**MCP initialize request returns 400 "Bad session ID"**
You're sending an `mcp-session-id` header without first initializing. Remove the header — the server generates a session ID on the first `initialize` request.

**Claude.ai integration not appearing**
Remote MCP integrations require a Pro or Team plan on Claude.ai. If you're on Free, use Claude Desktop (Option A or B above).

---

## Project structure

```
tesla-siri/
├── src/
│   ├── siri-server.ts      Main server — Siri, MCP (Streamable HTTP + SSE),
│   │                       HomeKit endpoints, Groq AI, macros, dashboard
│   ├── index.ts            Standalone MCP server (stdio for local Claude Desktop)
│   ├── tools/index.ts      19 Tesla tool definitions
│   └── utils/
│       ├── tesla-client.ts Tesla Fleet API HTTP client, auto-wake, 401-retry
│       └── token-manager.ts OAuth token lifecycle, 6h auto-refresh
├── get-tesla-token.mjs     One-time: partner token + Tesla registration
├── exchange-code.mjs       One-time: auth code → user tokens
├── generate-keys.mjs       One-time: EC key pair for VCP
├── claude-mcp-config.json  Claude Desktop config snippets (all three options)
├── railway.toml            Railway build + start config
├── Dockerfile              Multi-stage Docker build for self-hosting
├── CLAUDE.md               Project memory for Claude Code
└── .env.example            Environment variable template
```

---

## License

MIT — use freely, contribute back if you build something cool.
