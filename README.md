# Tesla Siri Server

Control your Tesla with **Siri voice commands** and **HomeKit** — powered by Groq (free Llama 3.3 AI) and deployed on Railway. No always-on computer, no ngrok.

Say **"Hey Siri, Car — warm up the car"** and your Tesla starts climate and sets temperature. Say **"Hey Siri, Car — let's go home"** and it navigates home, sets temp, and texts your ETA.

---

## What it does

- **Siri voice commands** — natural language via Groq AI (free)
- **HomeKit accessories** — lock, climate, sentry, charging, temperature as native Home app tiles
- **Smart macros** — instant multi-step phrases that fire without any AI roundtrip
- **Auto ETA SMS** — calculates real drive time and texts your contact
- **Live dashboard** — browser UI with battery arc, quick controls, and AI chat
- **MCP server** — Claude Desktop plugin for AI-assisted car control
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
Siri Shortcut (iPhone)
       │  POST /chat
       ▼
Railway Server  ─────────────────────────────────────┐
       │                                             │
       ├── Macro match? ──► run steps instantly      │
       ├── Groq Llama 3.3 ──► parse intent           │
       └── Tesla Fleet API ──► vehicle commands      │
               └── OSRM ──► real drive-time ETA      │
                                                     │
Homebridge (Raspberry Pi / Mac) ─────────────────────┘
       │  polls /homekit/* endpoints
       ▼
Home app / Hey Siri (native HomeKit)
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

## Phone-only setup (no laptop needed)

You can do the entire setup from an iPhone using **GitHub Codespaces** (free, runs in Safari) for the key generation step, and a built-in OAuth flow on your Railway server for the token step.

### Phone Step 1 — Fork the repo on GitHub

On your iPhone, go to the GitHub repo page and tap **Fork**. This gives you your own copy to link to Railway.

### Phone Step 2 — Create a GitHub Codespace (for key generation only)

1. On your fork page, tap **Code** → **Codespaces** → **Create codespace on main**
2. Wait ~60 seconds for it to load (it's a full VS Code in your browser)
3. In the terminal at the bottom, run:

```bash
node generate-keys.mjs
```

4. Run this to display the public key:

```bash
cat tesla-public.pem
```

5. Select all the output (including the `-----BEGIN PUBLIC KEY-----` lines) and copy it
6. Keep this tab open — you'll set it as `TESLA_PUBLIC_KEY` in Railway shortly

> GitHub gives you 60 free Codespace hours per month. You only need it for about 5 minutes.

### Phone Step 3 — Set up Railway

1. Go to [railway.app](https://railway.app) on your phone and sign up with GitHub
2. **New Project** → **Deploy from GitHub repo** → select your fork
3. Railway detects `railway.toml` automatically
4. Go to **Variables** and add:

| Variable | Value |
|---|---|
| `TESLA_CLIENT_ID` | from developer.tesla.com |
| `TESLA_CLIENT_SECRET` | from developer.tesla.com |
| `TESLA_VIN` | your VIN (Tesla app → About) |
| `GROQ_API_KEY` | from console.groq.com |
| `SIRI_SECRET` | any password string |
| `TESLA_PUBLIC_KEY` | paste what you copied from the Codespace |
| `TESLA_REDIRECT_URI` | `https://YOUR-APP.railway.app/oauth/callback` |
| `HOME_ADDRESS` | `123 Your Street, City, Country` |
| `WORK_ADDRESS` | optional |

5. Also go to **developer.tesla.com** → your app → **Allowed Redirect URIs** → add `https://YOUR-APP.railway.app/oauth/callback`

6. Railway auto-deploys once variables are saved. Wait ~2 minutes.

### Phone Step 4 — Get your Tesla refresh token (from the phone)

1. Once deployed, open in Safari: `https://YOUR-APP.railway.app/oauth/start`
2. This redirects you to Tesla's login page
3. Log in with your Tesla account and approve permissions
4. Tesla redirects back to your Railway app at `/oauth/callback`
5. **A page appears showing your `TESLA_REFRESH_TOKEN`** — copy it

6. Go back to Railway → Variables → add:

| Variable | Value |
|---|---|
| `TESLA_REFRESH_TOKEN` | paste the token from step 5 |

7. In Railway, trigger a redeploy (push a commit, or click **Redeploy**)

### Phone Step 5 — Register with Tesla

In [developer.tesla.com](https://developer.tesla.com) → your app → **Allowed Origins** → add `https://YOUR-APP.railway.app`.

Then run the partner registration. Since you have no laptop, use the Codespace terminal again:

```bash
node get-tesla-token.mjs YOUR-APP.railway.app
```

### Phone Step 6 — VCP pairing

Tesla app → **Security & Privacy → Manage Third-Party Apps** → find your app → **Grant Access**.

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

## Custom macros

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

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | none | Server + token status |
| `/commands` | GET | none | List all tools and aliases |
| `/api/test-ai` | GET | none | Test Groq model connectivity |
| `/oauth/start` | GET | none | Begin Tesla OAuth (phone-friendly setup) |
| `/oauth/callback` | GET | none | Receives Tesla redirect, shows refresh token |
| `/` | GET | secret | Live dashboard |
| `/chat` | POST | secret | AI + macro dispatch (Siri shortcut target) |
| `/siri` | GET/POST | secret | Single-shot command (`?cmd=lock`) |
| `/api/status` | GET | secret | Raw vehicle JSON |
| `/api/command` | POST | secret | Run a command |
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
`TESLA_REFRESH_TOKEN` is missing or expired. Re-run steps 3–4 locally to get a fresh token, then update the Railway env var and redeploy.

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

---

## Project structure

```
tesla-siri/
├── src/
│   ├── siri-server.ts      Main server — Groq AI, macros, /chat, /homekit, dashboard
│   ├── index.ts            MCP server (Claude Desktop integration)
│   ├── tools/index.ts      19 Tesla tool definitions
│   └── utils/
│       ├── tesla-client.ts Tesla Fleet API HTTP client
│       └── token-manager.ts OAuth token lifecycle
├── get-tesla-token.mjs     One-time: partner token + Tesla registration
├── exchange-code.mjs       One-time: auth code → user tokens
├── generate-keys.mjs       One-time: EC key pair for VCP
├── railway.toml            Railway build + start config
├── CLAUDE.md               Project memory for Claude Code
└── .env.example            Environment variable template
```

---

## License

MIT — use freely, contribute back if you build something cool.
