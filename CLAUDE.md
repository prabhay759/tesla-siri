# Tesla Siri Server — Claude Memory

## What this project does
Node.js server that lets you control a Tesla via Siri voice commands and a web dashboard.
- Siri Shortcut → POST /chat → Groq/Llama AI parses intent → Tesla Fleet API
- Also exposes an MCP server so Claude Desktop can control the car

## Key tech
- **Runtime**: Node.js 18+ with TypeScript (compiled to `dist/`)
- **AI**: Groq (free) — `llama-3.3-70b-versatile` primary, fallback chain in `GROQ_MODELS`
- **Tesla API**: EU Fleet API (`fleet-api.prd.eu.vn.cloud.tesla.com`)
- **Auth**: Tesla OAuth2 with refresh token rotation; tokens cached in `tokens.json`
- **Deployment**: Railway (was ngrok + Windows Task Scheduler)

## File map
```
src/siri-server.ts      Main Express server (port 3000) — Groq AI, macros, /chat, dashboard
src/index.ts            MCP server (stdio or HTTP, port 3001)
src/tools/index.ts      19 Tesla tools (climate, charging, navigation, locks, etc.)
src/utils/tesla-client.ts  Fleet API HTTP wrapper, auto-wake, 401-retry
src/utils/token-manager.ts OAuth lifecycle — refresh every 6h, persist to tokens.json
get-tesla-token.mjs     One-time setup: partner token + partner account registration
exchange-code.mjs       One-time setup: auth code → user access + refresh tokens
generate-keys.mjs       One-time setup: EC key pair for Vehicle Command Protocol
railway.toml            Railway deployment config
```

## Environment variables (all in .env)
| Variable | Required | Notes |
|---|---|---|
| `TESLA_CLIENT_ID` | ✅ | From developer.tesla.com |
| `TESLA_CLIENT_SECRET` | ✅ | Starts with `ta-secret.` |
| `TESLA_VIN` | ✅ | Your car's VIN |
| `TESLA_REFRESH_TOKEN` | ✅ for Railway | Set as Railway env var; used to get access tokens on startup |
| `TESLA_PUBLIC_KEY` | ✅ for VCP | Full PEM content of public key; served at `/.well-known/` |
| `TESLA_PRIVATE_KEY` | ✅ for VCP | Full PEM content of private key; used by VCP signing proxy |
| `GROQ_API_KEY` | Recommended | Free at console.groq.com; enables natural language |
| `SIRI_SECRET` | Recommended | Auth header for all protected endpoints |
| `HOME_ADDRESS` | Optional | Enables "go home" voice command |
| `WORK_ADDRESS` | Optional | Enables "go to work" voice command |
| `CONTACT_<NAME>=<phone>` | Optional | e.g. `CONTACT_PRIYA=+41791234567` for SMS ETA |
| `PUBLIC_URL` | Optional | Your Railway URL; used after partner registration |
| `TESLA_REDIRECT_URI` | Optional | Default: `http://localhost:5431/mcp` |
| `PORT` | Optional | Default 3000 (Railway sets this automatically) |

## API endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /` | SIRI_SECRET | Live dashboard |
| `POST /chat` | SIRI_SECRET | Main Siri shortcut endpoint |
| `GET /siri?cmd=` | SIRI_SECRET | Single-shot command |
| `GET /api/status` | SIRI_SECRET | Raw vehicle JSON |
| `POST /api/command` | SIRI_SECRET | Dashboard command |
| `GET /api/test-ai` | none | Test Groq connectivity |
| `GET /health` | none | Server + token status |
| `GET /commands` | none | List tools + aliases |
| `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` | none | VCP public key |
| `GET /homekit/lock` | SIRI_SECRET | Lock status `{"value":0/1}` |
| `POST /homekit/lock/lock` | SIRI_SECRET | Lock doors |
| `POST /homekit/lock/unlock` | SIRI_SECRET | Unlock doors |
| `GET /homekit/climate` | SIRI_SECRET | Climate on/off status |
| `POST /homekit/climate/on` | SIRI_SECRET | Start climate |
| `POST /homekit/climate/off` | SIRI_SECRET | Stop climate |
| `GET /homekit/sentry` | SIRI_SECRET | Sentry status |
| `POST /homekit/sentry/on\|off` | SIRI_SECRET | Toggle sentry |
| `GET /homekit/charging` | SIRI_SECRET | Charging status |
| `POST /homekit/charging/on\|off` | SIRI_SECRET | Toggle charging |
| `GET /homekit/temperature` | SIRI_SECRET | `{"current":21.5,"target":22}` |
| `POST /homekit/temperature` | SIRI_SECRET | Set temp `{"value":22}` |
| `GET /homekit/battery` | SIRI_SECRET | Battery % `{"value":80}` |

## HomeKit notes
- Homebridge polls `/homekit/*` endpoints every ~3s; a 60s in-process cache prevents waking the sleeping car
- Cache is invalidated immediately after any command
- Use `homebridge-http-switch` for lock/climate/sentry/charging, `homebridge-http-thermostat` for temperature
- `statusPattern: "\"value\":1"` in homebridge-http-switch config matches the response format

## Token management
- `TESLA_REFRESH_TOKEN` in env → used on startup to get access token
- Refreshes automatically every 6h via `setInterval` in `siri-server.ts`
- Also refreshes on 401 from Fleet API (via `invalidateToken()` + retry)
- On Railway: `tokens.json` is ephemeral; server re-fetches from refresh token on each deploy
- **Important**: If the refresh token rotates and the deployment restarts, update `TESLA_REFRESH_TOKEN` in Railway env vars

## Adding a macro
Edit `MACROS` in `src/siri-server.ts`:
```typescript
"saturday drive": {
  steps: [
    { tool: 'start_climate',   params: {} },
    { tool: 'set_temperature', params: { tempC: 20 } },
  ],
  reply: "Car warming up for your drive.",
},
```
Rebuild and redeploy.

## Siri Shortcut (iPhone) setup
POST to `https://your-app.railway.app/chat` with:
```json
{ "message": "<dictated text>", "session": "siri-main" }
```
Add header `x-siri-secret: <SIRI_SECRET>` or append `?secret=<SIRI_SECRET>` to URL.
Response includes `reply` (speak), `sms_to` + `sms_body` (send message if set).

## Railway deployment checklist
1. Push to GitHub
2. Create Railway project → link GitHub repo
3. Set env vars (see table above; TESLA_REFRESH_TOKEN is critical)
4. Upload `tesla-public.pem` as a file or set its content as env var
5. Deploy — Railway builds with `npm run build`, starts with `npm run start:siri`
6. Register with Tesla: `node get-tesla-token.mjs your-app.railway.app`
7. Complete VCP key pairing in Tesla mobile app

## Common issues
- **403 Vehicle Command Protocol**: VCP key pairing not done yet (Tesla app → Security → Third-Party Apps)
- **Token expired**: Update `TESLA_REFRESH_TOKEN` in Railway env vars, redeploy
- **AI not working**: Check `GROQ_API_KEY` is set; hit `/api/test-ai` to debug
- **Public key 404**: `tesla-public.pem` not found — set `TESLA_PUBLIC_KEY_FILE` or check file exists
