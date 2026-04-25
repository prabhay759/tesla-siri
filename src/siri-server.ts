/**
 * Tesla Siri Server — AI-powered via Google Gemini
 *
 * Siri Shortcut sends natural language to /siri
 * Gemini parses intent → correct Tesla tool → runs it → spoken reply
 *
 * Fallback: keyword aliases when GEMINI_API_KEY is not set.
 *
 * Setup: add GEMINI_API_KEY to .env (free key at https://aistudio.google.com/apikey)
 */

import 'dotenv/config'
import express from 'express'
import { readFileSync, existsSync } from 'fs'
import { TeslaClient } from './utils/tesla-client.js'
import { tools } from './tools/index.js'
import { forceRefresh, getTokenType, tokenExpiresInMs } from './utils/token-manager.js'

// ── Env validation ────────────────────────────────────────────────────────────

const REQUIRED = ['TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TESLA_VIN']
const missing  = REQUIRED.filter(k => !process.env[k])
if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const VIN          = process.env.TESLA_VIN!
const PORT         = parseInt(process.env.PORT ?? '3000', 10)
const SIRI_SECRET  = process.env.SIRI_SECRET ?? null
const GEMINI_KEY   = process.env.GEMINI_API_KEY ?? null
const HOME_ADDRESS = process.env.HOME_ADDRESS ?? null
const WORK_ADDRESS = process.env.WORK_ADDRESS ?? null

const tesla = new TeslaClient(VIN)

// ── Tool lookup ───────────────────────────────────────────────────────────────

const toolMap: Record<string, typeof tools[number]> = {}
for (const t of tools) toolMap[t.name] = t

// ── AI dispatcher (Gemini) ────────────────────────────────────────────────────

const TOOL_LIST = Object.keys(toolMap).join(', ')

const SYSTEM_PROMPT = `You are a Tesla car voice assistant. Your job is to parse the user's natural language command and return a JSON object.

RETURN ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "tool": "<tool_name>",
  "params": {},
  "reply": "<short friendly spoken reply (1 sentence, present tense)>"
}

Available tools:
- get_vehicle_status    → params: {}
- get_battery           → params: {}
- wake_vehicle          → params: {}
- lock_doors            → params: {}
- unlock_doors          → params: {}
- open_trunk            → params: { "which": "front" | "rear" }  (default: "rear")
- honk_horn             → params: {}
- flash_lights          → params: {}
- start_climate         → params: {}
- stop_climate          → params: {}
- start_charging        → params: {}
- stop_charging         → params: {}
- open_charge_port      → params: { "open": true | false }
- set_sentry_mode       → params: { "on": true | false }
- set_temperature       → params: { "tempC": <number> }
- set_charge_limit      → params: { "percent": <number> }
- list_vehicles         → params: {}
- vent_windows          → params: {}
- plan_route            → params: { "waypoints": ["<place1>", "<place2>", ...] }
  Use for ANY navigation, route, or directions request. Extract ALL stops in order.
  Minimum 2 waypoints (origin + destination). Add intermediate stops as extra items.
  For "home" or "work" use those words literally — they will be substituted automatically.

If the command is ambiguous or unknown, use get_vehicle_status.

Examples:
User: "lock the car"
→ {"tool":"lock_doors","params":{},"reply":"Locking your Tesla now."}

User: "what's my battery"
→ {"tool":"get_battery","params":{},"reply":"Checking your battery level."}

User: "navigate to Tesco"
→ {"tool":"plan_route","params":{"waypoints":["current location","Tesco"]},"reply":"Planning your route to Tesco."}

User: "plan a route from home to IKEA then Manchester city centre"
→ {"tool":"plan_route","params":{"waypoints":["home","IKEA","Manchester city centre"]},"reply":"Planning your multi-stop route now."}

User: "directions to work via Costa Coffee Sheffield"
→ {"tool":"plan_route","params":{"waypoints":["current location","Costa Coffee Sheffield","work"]},"reply":"Routing you via Costa Coffee to work."}

User: "set temperature to 22"
→ {"tool":"set_temperature","params":{"tempC":22},"reply":"Setting the temperature to 22 degrees."}

User: "charge to 80 percent"
→ {"tool":"set_charge_limit","params":{"percent":80},"reply":"Setting charge limit to 80 percent."}

User: "turn on sentry"
→ {"tool":"set_sentry_mode","params":{"on":true},"reply":"Enabling sentry mode."}
`

interface AIResult {
  tool:   string
  params: Record<string, any>
  reply:  string
}

// Models to try in order — falls back if one is rate-limited (429)
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash-001',
]

async function callGemini(model: string, cmd: string): Promise<{ ok: boolean; text?: string; status?: number }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: cmd }] }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
      }),
    }
  )
  const rawBody = await res.text()
  if (!res.ok) {
    console.error(`[gemini/${model}] HTTP ${res.status}: ${rawBody.slice(0, 200)}`)
    return { ok: false, status: res.status }
  }
  let data: any
  try { data = JSON.parse(rawBody) } catch {
    return { ok: false }
  }
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    console.error(`[gemini/${model}] Empty candidates:`, JSON.stringify(data).slice(0, 200))
    return { ok: false }
  }
  return { ok: true, text }
}

async function parseWithGemini(cmd: string): Promise<AIResult | null> {
  if (!GEMINI_KEY) return null
  for (const model of GEMINI_MODELS) {
    try {
      const result = await callGemini(model, cmd)
      if (!result.ok) {
        if (result.status === 429) { console.warn(`[gemini] ${model} rate-limited, trying next...`); continue }
        return null
      }
      const text = result.text!
      console.log(`[gemini/${model}] Response: ${text.slice(0, 150)}`)
      // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      const jsonStr   = jsonMatch ? jsonMatch[1].trim() : text.trim()
      return JSON.parse(jsonStr) as AIResult
    } catch (err) {
      console.error(`[gemini/${model}] Error:`, err)
    }
  }
  console.error('[gemini] All models failed or rate-limited')
  return null
}

// ── Keyword fallback ──────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  'status':           'get_vehicle_status',
  'where is my car':  'get_vehicle_status',
  'battery':          'get_battery',
  'battery level':    'get_battery',
  'range':            'get_battery',
  'wake':             'wake_vehicle',
  'wake up':          'wake_vehicle',
  'lock':             'lock_doors',
  'lock my car':      'lock_doors',
  'unlock':           'unlock_doors',
  'unlock my car':    'unlock_doors',
  'help':             '__help__',
  'what can you do':  '__help__',
  'commands':         '__help__',
  'open trunk':       'open_trunk|rear',
  'open boot':        'open_trunk|rear',
  'open frunk':       'open_trunk|front',
  'honk':             'honk_horn',
  'beep':             'honk_horn',
  'flash':            'flash_lights',
  'flash lights':     'flash_lights',
  'find my car':      'flash_lights',
  'start climate':    'start_climate',
  'heat the car':     'start_climate',
  'cool the car':     'start_climate',
  'stop climate':     'stop_climate',
  'climate off':      'stop_climate',
  'start charging':   'start_charging',
  'stop charging':    'stop_charging',
  'open charge port': 'open_charge_port|open',
  'sentry on':        'set_sentry_mode|on',
  'sentry off':       'set_sentry_mode|off',
  'vent windows':     'vent_windows',
  'open windows':     'vent_windows',
}

function parseWithAliases(cmd: string): { toolName: string; input: Record<string, any> } | null {
  const norm = cmd.toLowerCase().trim().replace(/[?.!]/g, '')

  for (const [alias, target] of Object.entries(ALIASES)) {
    if (norm === alias || norm.includes(alias)) {
      const [toolName, extra] = target.split('|')
      let input: Record<string, any> = {}
      if (extra) {
        if (toolName === 'open_trunk')      input = { which: extra }
        if (toolName === 'set_sentry_mode') input = { on: extra === 'on' }
        if (toolName === 'open_charge_port')input = { open: extra === 'open' }
      }
      return { toolName, input }
    }
  }

  const tempMatch = norm.match(/(\d{1,2})\s*(degrees?|°|celsius)/)
  if (tempMatch) return { toolName: 'set_temperature', input: { tempC: parseFloat(tempMatch[1]) } }

  const chargeMatch = norm.match(/charge\s+(?:limit\s+)?(?:to\s+)?(\d{2,3})\s*%?/)
  if (chargeMatch) return { toolName: 'set_charge_limit', input: { percent: parseInt(chargeMatch[1], 10) } }

  return null
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

// ── ETA calculation (OSRM free routing, no API key needed) ───────────────────

async function getETAMinutes(fromLat: number, fromLon: number, toAddress: string): Promise<number | null> {
  try {
    // Geocode destination via Nominatim
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(toAddress)}&format=json&limit=1`
    const geoRes  = await fetch(geoUrl, { headers: { 'User-Agent': 'TeslaSiriServer/1.0' } })
    const geoData = await geoRes.json() as any[]
    if (!geoData?.[0]) { console.warn('[eta] Geocode failed for:', toAddress); return null }
    const toLat = parseFloat(geoData[0].lat)
    const toLon = parseFloat(geoData[0].lon)

    // OSRM driving route (lon,lat order!)
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false`
    const osrmRes  = await fetch(osrmUrl)
    const osrmData = await osrmRes.json() as any
    const secs     = osrmData?.routes?.[0]?.duration
    if (!secs) { console.warn('[eta] OSRM no duration'); return null }
    const mins = Math.round(secs / 60)
    console.log(`[eta] ${toAddress} → ${mins} min`)
    return mins
  } catch (err) {
    console.error('[eta] Error:', err)
    return null
  }
}

function formatETA(mins: number | null): string {
  if (mins === null) return ''
  if (mins < 2)  return 'less than a minute'
  if (mins < 60) return `about ${mins} minutes`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} hour${h > 1 ? 's' : ''}` : `${h}h ${m}min`
}

// ── Macros — instant multi-action phrases, no AI needed ──────────────────────

interface MacroStep { tool: string; params: Record<string, any> }
interface Macro {
  steps:       MacroStep[]
  sms?:        { contact: string; body: string }
  eta_dest?:   string        // if set, fetch real drive time and append to SMS
  reply:       string
}

const MACROS: Record<string, Macro> = {
  // Driving home
  "let's go home":    { steps: [{ tool:'plan_route', params:{ waypoints:['current location','home'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], sms:{ contact:'PRIYA', body:'ETA_PLACEHOLDER' }, eta_dest: HOME_ADDRESS ?? 'home', reply:"Navigating home, climate set to 22°, and Priya notified." },
  "lets go home":     { steps: [{ tool:'plan_route', params:{ waypoints:['current location','home'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], sms:{ contact:'PRIYA', body:'ETA_PLACEHOLDER' }, eta_dest: HOME_ADDRESS ?? 'home', reply:"Navigating home, climate set to 22°, and Priya notified." },
  "drive home":       { steps: [{ tool:'plan_route', params:{ waypoints:['current location','home'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], sms:{ contact:'PRIYA', body:'ETA_PLACEHOLDER' }, eta_dest: HOME_ADDRESS ?? 'home', reply:"Navigating home, climate set to 22°, and Priya notified." },
  "heading home":     { steps: [{ tool:'plan_route', params:{ waypoints:['current location','home'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], sms:{ contact:'PRIYA', body:'ETA_PLACEHOLDER' }, eta_dest: HOME_ADDRESS ?? 'home', reply:"Navigating home, climate set to 22°, and Priya notified." },
  // Driving to work
  "let's go to work": { steps: [{ tool:'plan_route', params:{ waypoints:['current location','work'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], reply:"Navigating to work and climate set to 22°." },
  "lets go to work":  { steps: [{ tool:'plan_route', params:{ waypoints:['current location','work'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], reply:"Navigating to work and climate set to 22°." },
  "drive to work":    { steps: [{ tool:'plan_route', params:{ waypoints:['current location','work'] } }, { tool:'set_temperature', params:{ tempC:22 } }, { tool:'start_climate', params:{} }], reply:"Navigating to work and climate set to 22°." },
  // Leaving car
  "i'm leaving":      { steps: [{ tool:'lock_doors', params:{} }, { tool:'set_sentry_mode', params:{ on:true } }], reply:"Doors locked and sentry mode on." },
  "im leaving":       { steps: [{ tool:'lock_doors', params:{} }, { tool:'set_sentry_mode', params:{ on:true } }], reply:"Doors locked and sentry mode on." },
  // Warm up
  "warm up the car":  { steps: [{ tool:'start_climate', params:{} }, { tool:'set_temperature', params:{ tempC:22 } }], reply:"Climate on and temperature set to 22°." },
  "preheat the car":  { steps: [{ tool:'start_climate', params:{} }, { tool:'set_temperature', params:{ tempC:22 } }], reply:"Climate on and temperature set to 22°." },
}

async function runMacro(macro: Macro, teslaClient: TeslaClient): Promise<{ reply: string; sms_to: string | null; sms_body: string | null }> {
  // Run all Tesla steps in sequence
  for (const step of macro.steps) {
    try {
      const tool = toolMap[step.tool]
      if (!tool) continue
      const params = step.tool === 'plan_route' ? substituteAddresses(step.params) : step.params
      await tool.handler(params, teslaClient)
      console.log(`[macro] ${step.tool} OK`)
    } catch (err: any) {
      console.error(`[macro] ${step.tool} failed:`, err.message)
    }
  }

  let smsTo:   string | null = null
  let smsBody: string | null = null

  if (macro.sms) {
    const key = macro.sms.contact.toLowerCase()
    smsTo = CONTACTS[key] ?? macro.sms.contact

    // Build SMS body — include real ETA if destination is configured
    if (macro.eta_dest) {
      let etaMins: number | null = null
      try {
        // Get vehicle's current GPS from Tesla
        const raw = await teslaClient.getVehicleData()
        const ds  = raw?.body?.response?.drive_state
        if (ds?.latitude && ds?.longitude) {
          etaMins = await getETAMinutes(ds.latitude, ds.longitude, macro.eta_dest)
        }
      } catch { /* non-fatal */ }

      const etaStr = formatETA(etaMins)
      smsBody = etaStr
        ? `On my way home! ETA: ${etaStr} 🚗`
        : `On my way home! 🚗`
      console.log(`[macro/sms] body="${smsBody}"`)
    } else {
      smsBody = macro.sms.body
    }
  }

  return { reply: macro.reply, sms_to: smsTo, sms_body: smsBody }
}

// Substitute "home" / "work" literals in plan_route waypoints
function substituteAddresses(params: Record<string, any>): Record<string, any> {
  if (!Array.isArray(params?.waypoints)) return params
  const wps = params.waypoints.map((w: string) => {
    const lower = w.toLowerCase().trim()
    if ((lower === 'home' || lower === 'my home') && HOME_ADDRESS) return HOME_ADDRESS
    if ((lower === 'work' || lower === 'my work' || lower === 'office') && WORK_ADDRESS) return WORK_ADDRESS
    return w
  })
  return { ...params, waypoints: wps }
}

const HELP_TEXT = `I can control your Tesla! Try:
🔒 Lock / Unlock
🔋 Battery / Range / Charge to 80%
🌡️ Set temp to 22 / Start climate / Stop climate
🔊 Honk / Flash lights
👁️ Sentry on / off
🚗 Open trunk / Open frunk / Vent windows
⚡ Start charging / Stop charging / Open charge port
🗺️ Navigate to Work / Plan route home via Starbucks
📍 What's my status?`

async function dispatch(cmd: string): Promise<string> {
  // 0 — Macro check (instant, no AI needed)
  const normCmd = cmd.toLowerCase().trim().replace(/[?.!']/g, '')
  const macro   = MACROS[normCmd]
  if (macro) {
    console.log(`[dispatch/macro] matched: "${normCmd}"`)
    const { reply } = await runMacro(macro, tesla)
    return reply
  }

  // 1 — Try Gemini AI
  const ai = await parseWithGemini(cmd)
  if (ai) {
    // Special help tool
    if (ai.tool === '__help__' || ai.tool === 'help') return HELP_TEXT
    const tool = toolMap[ai.tool]
    if (tool) {
      const params = ai.tool === 'plan_route' ? substituteAddresses(ai.params ?? {}) : (ai.params ?? {})
      console.log(`[siri/ai]  → ${ai.tool}`, params)
      try {
        const result = await tool.handler(params, tesla)
        return ai.reply ? `${ai.reply}\n${result}`.trim() : result
      } catch (err: any) {
        return `Error running ${ai.tool}: ${err.message}`
      }
    }
  }

  // 2 — Keyword fallback
  const kw = parseWithAliases(cmd)
  if (kw) {
    if (kw.toolName === '__help__') return HELP_TEXT
    const tool = toolMap[kw.toolName]
    if (tool) {
      console.log(`[siri/kw]  → ${kw.toolName}`, kw.input)
      try {
        return await tool.handler(kw.input, tesla)
      } catch (err: any) {
        return `Error: ${err.message}`
      }
    }
  }

  // 3 — Last resort: try get_vehicle_status for anything vaguely status-like
  const norm = cmd.toLowerCase()
  if (norm.includes('status') || norm.includes('where') || norm.includes('info') || norm.includes('what')) {
    console.log(`[siri/fallback] Routing to get_vehicle_status for: "${cmd}"`)
    try {
      return await toolMap['get_vehicle_status']?.handler({}, tesla) ?? HELP_TEXT
    } catch { /* fall through */ }
  }

  console.warn(`[siri] No handler matched for: "${cmd}" — Gemini returned: ${ai ? JSON.stringify(ai) : 'null'}`)
  return HELP_TEXT
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Bypass ngrok browser-warning for all responses (needed for Tesla public-key fetch)
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true')
  next()
})

// Tesla partner public key — NO AUTH
app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  const keyPath = process.env.TESLA_PUBLIC_KEY_FILE ?? 'tesla-public.pem'
  if (!existsSync(keyPath)) {
    console.warn(`[well-known] Public key not found at "${keyPath}" — run: node generate-keys.mjs`)
    res.status(404).send('Public key not found. Run: node generate-keys.mjs')
    return
  }
  console.log('[well-known] Serving public key to:', req.ip)
  res.type('application/x-pem-file').send(readFileSync(keyPath, 'utf8'))
})

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!SIRI_SECRET) return next()
  if (req.headers['x-siri-secret'] === SIRI_SECRET) return next()
  if (req.query.secret === SIRI_SECRET) return next()
  const authHeader = req.headers['authorization'] ?? ''
  if (authHeader.startsWith('Basic ')) {
    const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const password = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded
    if (password === SIRI_SECRET) return next()
  }
  res.status(401).set('WWW-Authenticate', 'Basic realm="Tesla Siri"').send('Unauthorized')
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/siri', requireAuth, async (req, res) => {
  const cmd = (req.query.cmd as string ?? '').trim()
  if (!cmd) { res.status(400).send('Missing ?cmd= parameter'); return }
  console.log(`[siri] GET  cmd="${cmd}"`)
  const reply = await dispatch(cmd)
  res.type('text/plain').send(reply)
})

app.post('/siri', requireAuth, async (req, res) => {
  const cmd = (req.body?.cmd ?? req.body?.command ?? '').toString().trim()
  if (!cmd) { res.status(400).json({ error: 'Missing cmd field' }); return }
  console.log(`[siri] POST cmd="${cmd}"`)
  const reply = await dispatch(cmd)
  res.json({ reply })
})

app.get('/health', (_req, res) => {
  const expiresMs  = tokenExpiresInMs()
  const expiresMin = Math.round(expiresMs / 60000)
  res.json({
    status:       'ok',
    vin:          VIN,
    ai:           GEMINI_KEY ? `gemini (${GEMINI_MODELS[0]} → fallback chain)` : 'keyword-fallback',
    commands:     Object.keys(ALIASES).length,
    token_type:   getTokenType(),
    token_status: expiresMs > 0 ? `valid (expires in ${expiresMin}m)` : 'expired — will refresh on next call',
  })
})

app.get('/commands', (_req, res) => {
  res.json({ tools: Object.keys(toolMap).sort(), aliases: Object.keys(ALIASES).sort() })
})

// ── /api/test-gemini — lists available models + tests the first working one ───
app.get('/api/test-gemini', async (_req, res) => {
  if (!GEMINI_KEY) { res.json({ error: 'GEMINI_API_KEY not set in .env' }); return }
  try {
    // Step 1: list models that support generateContent
    const listResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}&pageSize=50`
    )
    const listRaw  = await listResp.text()
    let availableModels: string[] = []
    try {
      const listData = JSON.parse(listRaw)
      availableModels = (listData.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => (m.name as string).replace('models/', ''))
    } catch { /* ignore */ }

    // Step 2: try each model from our preferred list + whatever came back
    const toTry = [...new Set([...GEMINI_MODELS, ...availableModels])]
    const results: Record<string, any> = {}
    for (const model of toTry.slice(0, 6)) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Say hi in one word' }] }],
              generationConfig: { maxOutputTokens: 16, temperature: 0 },
            }),
          }
        )
        const body = await r.text()
        const parsed = JSON.parse(body)
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
        results[model] = { status: r.status, text }
      } catch (e: any) {
        results[model] = { error: e.message }
      }
    }

    res.json({ available_models: availableModels, test_results: results })
  } catch (err: any) {
    res.json({ error: err.message })
  }
})

// ── /api/status — raw vehicle data as JSON ────────────────────────────────────

app.get('/api/status', requireAuth, async (_req, res) => {
  const raw = await tesla.getVehicleData()
  if (raw.status >= 400) {
    res.status(raw.status).json(raw.body)
    return
  }
  const d  = raw.body?.response ?? {}
  const cs = d.charge_state  ?? {}
  const cl = d.climate_state ?? {}
  const vs = d.vehicle_state ?? {}
  const ds = d.drive_state   ?? {}
  res.json({
    name:          d.display_name  ?? 'Tesla',
    state:         d.state         ?? 'unknown',
    battery:       cs.battery_level,
    range_mi:      cs.battery_range,
    charging:      cs.charging_state,
    charge_limit:  cs.charge_limit_soc,
    inside_temp:   cl.inside_temp,
    outside_temp:  cl.outside_temp,
    climate_on:    cl.is_climate_on,
    set_temp:      cl.driver_temp_setting,
    locked:        vs.locked,
    sentry:        vs.sentry_mode,
    lat:           ds.latitude,
    lon:           ds.longitude,
    speed:         ds.speed ?? 0,
    odometer:      vs.odometer,
    timestamp:     Date.now(),
  })
})

// ── /api/command — run a Siri/AI command from the dashboard ──────────────────

app.post('/api/command', requireAuth, async (req, res) => {
  const cmd = (req.body?.cmd ?? '').toString().trim()
  if (!cmd) { res.status(400).json({ error: 'Missing cmd' }); return }
  const reply = await dispatch(cmd)
  res.json({ reply })
})

// ── Conversational chat session store ────────────────────────────────────────

interface ChatMessage { role: 'user' | 'model'; parts: [{ text: string }] }
interface ChatSession { history: ChatMessage[]; lastActivity: number }

const chatSessions = new Map<string, ChatSession>()

// Expire sessions after 10 minutes of inactivity
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [id, s] of chatSessions) { if (s.lastActivity < cutoff) chatSessions.delete(id) }
}, 5 * 60 * 1000)

// Load contacts from env: CONTACT_PRIYA=+41791234567  CONTACT_MOM=+41791234568
const CONTACTS: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('CONTACT_') && v) CONTACTS[k.slice(8).toLowerCase()] = v
}
const CONTACT_LIST = Object.keys(CONTACTS).length
  ? 'Known contacts: ' + Object.keys(CONTACTS).map(n => n).join(', ')
  : 'No contacts configured (add CONTACT_NAME=+phonenumber to .env)'

const CHAT_SYSTEM_PROMPT = `You are a friendly Tesla voice assistant. You have two modes:

CONVERSATION MODE — ask one short question when you need more info.
ACTION MODE — when you have everything needed, fire one of the action types below.

Always reply with ONLY valid JSON — no markdown, no prose outside the JSON.

── Shapes ──────────────────────────────────────────────────────────────────────

1. Conversation (need more info):
{"type":"chat","reply":"<1-2 sentence spoken reply>"}

2. Single Tesla action:
{"type":"action","tool":"<tool>","params":<params>,"reply":"<spoken confirmation>"}

3. Multiple Tesla actions at once (e.g. navigate + climate):
{"type":"multi_action","actions":[{"tool":"<tool>","params":<params>},...],
 "sms":{"contact":"<name>","body":"<message text>"},"reply":"<spoken summary>"}
 (the "sms" field is OPTIONAL — only include if user explicitly asked to send a message)

── Available Tesla tools ────────────────────────────────────────────────────────
get_vehicle_status {}, get_battery {}, wake_vehicle {}, lock_doors {}, unlock_doors {},
open_trunk {"which":"front"|"rear"}, honk_horn {}, flash_lights {}, vent_windows {},
start_climate {}, stop_climate {}, set_temperature {"tempC":<n>},
start_charging {}, stop_charging {}, open_charge_port {"open":true|false},
set_sentry_mode {"on":true|false}, set_charge_limit {"percent":<n>},
plan_route {"waypoints":["<place1>","<place2>",...]}
  → Use "home" and "work" literally. Min 2 waypoints.

── Messaging ────────────────────────────────────────────────────────────────────
${CONTACT_LIST}
When asked to message someone, include the optional "sms" field in multi_action.
Craft a natural, friendly message body on the user's behalf.
If the contact is not in the known list, still include their name — the phone will look them up.

── Rules ────────────────────────────────────────────────────────────────────────
- ALL replies are spoken aloud — keep them SHORT (1-2 sentences).
- Prefer multi_action when user asks for 2+ things in one command.
- "Drive home" = plan_route home + start_climate + set_temperature 22.
- "Cancel" / "never mind" → {"type":"chat","reply":"No problem, cancelled."}
- Always prefer ACTION over asking more questions if you have enough info.

── Examples ─────────────────────────────────────────────────────────────────────
"Drive home, make it warm, tell Priya I'm on my way":
{"type":"multi_action","actions":[{"tool":"plan_route","params":{"waypoints":["current location","home"]}},{"tool":"set_temperature","params":{"tempC":22}},{"tool":"start_climate","params":{}}],"sms":{"contact":"Priya","body":"On my way home! 🚗"},"reply":"Navigating home, climate set to 22°, and messaging Priya."}

"Set charge to 80 and lock the car":
{"type":"multi_action","actions":[{"tool":"set_charge_limit","params":{"percent":80}},{"tool":"lock_doors","params":{}}],"reply":"Charge limit set to 80% and doors locked."}`

interface GeminiAction { tool: string; params: Record<string, any> }
interface GeminiResult {
  type:     string
  reply:    string
  tool?:    string
  params?:  Record<string, any>
  actions?: GeminiAction[]
  sms?:     { contact: string; body: string }
}

async function chatWithGemini(history: ChatMessage[]): Promise<GeminiResult> {
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
            contents: history,
            generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
          }),
        }
      )
      const raw = await res.text()
      if (!res.ok) {
        if (res.status === 429) { console.warn(`[chat/${model}] rate-limited, trying next...`); continue }
        console.error(`[chat/${model}] HTTP ${res.status}`)
        continue
      }
      const data    = JSON.parse(raw)
      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      console.log(`[chat/${model}] raw text: ${text.slice(0, 300)}`)
      // Extract JSON — strip markdown fences if present, then find first {...} block
      let jsonStr = (text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [])[1]?.trim()
                 ?? text.trim()
      // If still not valid, try to grab from first { to last }
      if (!jsonStr.startsWith('{')) {
        const start = jsonStr.indexOf('{')
        const end   = jsonStr.lastIndexOf('}')
        if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1)
      }
      const parsed  = JSON.parse(jsonStr)
      console.log(`[chat/${model}] type=${parsed.type} tool=${parsed.tool ?? '-'}`)
      return parsed
    } catch (err) {
      console.error(`[chat/${model}] error:`, err)
    }
  }
  return { type: 'chat', reply: "Sorry, I'm having trouble connecting to AI right now. Try a direct command like 'battery' or 'lock'." }
}

// ── /chat — multi-turn conversational endpoint (used by Siri shortcut) ────────

app.post('/chat', requireAuth, async (req, res) => {
  const sessionId = (req.body?.session ?? 'siri-default').toString().slice(0, 64)
  const message   = (req.body?.message ?? req.body?.cmd ?? '').toString().trim()
  if (!message) { res.status(400).json({ error: 'Missing message' }); return }

  console.log(`[chat] session=${sessionId} message="${message}"`)

  // ── Macro check (instant, no AI) ──────────────────────────────────────────
  const norm = message.toLowerCase().trim().replace(/[?.!']/g, '')
  const macro = MACROS[norm]
  if (macro) {
    console.log(`[chat/macro] matched: "${norm}"`)
    const { reply, sms_to, sms_body } = await runMacro(macro, tesla)
    res.json({ reply, sms_to, sms_body, session: sessionId })
    return
  }

  if (!GEMINI_KEY) {
    // No Gemini — fall back to single-shot dispatch
    const reply = await dispatch(message)
    res.json({ reply, session: sessionId })
    return
  }

  // Get or create session
  let session = chatSessions.get(sessionId)
  if (!session) session = { history: [], lastActivity: Date.now() }
  session.lastActivity = Date.now()

  // Append user turn
  session.history.push({ role: 'user', parts: [{ text: message }] })
  chatSessions.set(sessionId, session)

  const result = await chatWithGemini(session.history)

  // Helper: run a single Tesla tool safely
  async function runTool(toolName: string, params: Record<string, any>): Promise<string> {
    const t = toolMap[toolName]
    if (!t) return `Unknown tool: ${toolName}`
    const p = toolName === 'plan_route' ? substituteAddresses(params) : params
    return t.handler(p, tesla)
  }

  // ── Single action ──────────────────────────────────────────────────────────
  if (result.type === 'action' && result.tool) {
    try {
      const toolResult = await runTool(result.tool, result.params ?? {})
      const spoken     = result.reply ? `${result.reply} ${toolResult}`.trim() : toolResult
      session.history.push({ role: 'model', parts: [{ text: result.reply ?? toolResult }] })
      session.history = []
      res.json({ reply: spoken, action: result.tool, session: sessionId })
    } catch (err: any) {
      session.history.pop()
      res.json({ reply: `I understood, but the command failed: ${err.message}`, session: sessionId })
    }
    return
  }

  // ── Multi-action ───────────────────────────────────────────────────────────
  if (result.type === 'multi_action' && Array.isArray(result.actions)) {
    const results: string[] = []
    for (const action of result.actions) {
      try {
        const r = await runTool(action.tool, action.params ?? {})
        results.push(r)
        console.log(`[chat/multi] ${action.tool} → ${r.slice(0, 80)}`)
      } catch (err: any) {
        console.error(`[chat/multi] ${action.tool} failed:`, err.message)
        results.push(`${action.tool} failed: ${err.message}`)
      }
    }

    // Resolve SMS contact → phone number if we have it stored
    let smsTo:   string | null = null
    let smsBody: string | null = null
    if (result.sms) {
      const contactKey = result.sms.contact.toLowerCase().trim()
      smsTo   = CONTACTS[contactKey] ?? result.sms.contact  // fall back to name if no number
      smsBody = result.sms.body
      console.log(`[chat/sms] to=${smsTo} body="${smsBody}"`)
    }

    session.history.push({ role: 'model', parts: [{ text: result.reply ?? 'Done.' }] })
    session.history = []
    res.json({
      reply:    result.reply ?? 'Done.',
      actions:  result.actions.map(a => a.tool),
      sms_to:   smsTo,
      sms_body: smsBody,
      session:  sessionId,
    })
    return
  }

  // ── Conversation reply — keep history for follow-up ────────────────────────
  const spoken = result.reply ?? "I didn't catch that, could you say that again?"
  session.history.push({ role: 'model', parts: [{ text: spoken }] })
  res.json({ reply: spoken, session: sessionId })
})

// ── / — Tesla Live Dashboard ─────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Tesla Dashboard</title>
<style>
  :root {
    --red:#E8001A; --red2:#ff3b5c;
    --bg:#0a0a0c; --bg2:#111115; --bg3:#1a1a20;
    --card:#16161c; --border:#2a2a35;
    --text:#f0f0f5; --muted:#888899; --green:#30d158; --amber:#ffd60a; --blue:#0a84ff;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding-bottom:env(safe-area-inset-bottom)}
  header{background:var(--bg2);border-bottom:1px solid var(--border);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  .logo{font-size:22px;font-weight:700;letter-spacing:4px;color:var(--text)}
  .logo span{color:var(--red)}
  .status-badge{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
  .dot.online{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.asleep{background:var(--amber)}
  .refresh-ring{width:20px;height:20px;cursor:pointer;opacity:.7;transition:opacity .2s}
  .refresh-ring:hover{opacity:1}
  .main{padding:16px;display:grid;gap:14px;max-width:480px;margin:0 auto}

  /* Hero battery card */
  .hero{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:24px;text-align:center;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(232,0,26,.08),transparent 60%)}
  .car-name{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px}
  .battery-arc-wrap{position:relative;width:200px;height:120px;margin:0 auto 8px}
  .battery-arc-wrap svg{overflow:visible}
  .arc-bg{stroke:var(--border);stroke-width:16;fill:none;stroke-linecap:round}
  .arc-fill{stroke:var(--green);stroke-width:16;fill:none;stroke-linecap:round;transition:stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1),stroke .5s}
  .arc-fill.mid{stroke:var(--amber)}
  .arc-fill.low{stroke:var(--red)}
  .batt-pct{position:absolute;bottom:4px;left:50%;transform:translateX(-50%);font-size:42px;font-weight:700;letter-spacing:-2px}
  .batt-pct sup{font-size:18px;font-weight:400;color:var(--muted);vertical-align:super}
  .range-text{font-size:15px;color:var(--muted);margin-bottom:16px}
  .charging-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(48,209,88,.12);color:var(--green);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;margin-bottom:12px}
  .charging-pill.idle{background:rgba(136,136,153,.1);color:var(--muted)}
  .hero-stats{display:flex;justify-content:center;gap:28px}
  .hstat{text-align:center}
  .hstat-val{font-size:17px;font-weight:600}
  .hstat-lbl{font-size:11px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:1px}

  /* Grid cards */
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px}
  .card-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px}
  .card-value{font-size:22px;font-weight:600;margin-bottom:4px}
  .card-sub{font-size:12px;color:var(--muted)}
  .temp-row{display:flex;justify-content:space-between;margin-bottom:12px}
  .temp-box{text-align:center}
  .temp-big{font-size:26px;font-weight:600}
  .temp-lbl{font-size:11px;color:var(--muted);text-transform:uppercase}

  /* Buttons */
  .btn{border:none;border-radius:12px;padding:12px 0;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;width:100%;outline:none}
  .btn-primary{background:var(--red);color:#fff}
  .btn-primary:active{background:var(--red2);transform:scale(.97)}
  .btn-secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border)}
  .btn-secondary:active{background:var(--border);transform:scale(.97)}
  .btn-green{background:rgba(48,209,88,.15);color:var(--green);border:1px solid rgba(48,209,88,.3)}
  .btn-green:active{background:rgba(48,209,88,.25);transform:scale(.97)}
  .btn-amber{background:rgba(255,214,10,.12);color:var(--amber);border:1px solid rgba(255,214,10,.3)}

  /* Action grid */
  .actions{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .action-btn{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 8px;text-align:center;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--text);font-size:12px;font-weight:500;-webkit-tap-highlight-color:transparent}
  .action-btn:active{transform:scale(.94);background:var(--bg3)}
  .action-btn .icon{font-size:22px;line-height:1}
  .action-btn.active{background:rgba(48,209,88,.1);border-color:rgba(48,209,88,.35);color:var(--green)}
  .action-btn.danger{background:rgba(232,0,26,.08);border-color:rgba(232,0,26,.3);color:var(--red)}

  /* Charge limit slider */
  .slider-wrap{margin-top:10px}
  input[type=range]{width:100%;accent-color:var(--green);height:4px;border-radius:2px;cursor:pointer}
  .slider-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px}

  /* AI Chat */
  .chat-card{background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden}
  .chat-header{padding:14px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
  .ai-dot{width:8px;height:8px;border-radius:50%;background:var(--blue);flex-shrink:0}
  .chat-messages{height:140px;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
  .msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4}
  .msg.user{align-self:flex-end;background:var(--red);border-bottom-right-radius:4px}
  .msg.bot{align-self:flex-start;background:var(--bg3);border:1px solid var(--border);border-bottom-left-radius:4px;color:var(--muted)}
  .msg.bot.loading{color:var(--muted);font-style:italic}
  .chat-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border)}
  .chat-input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--text);font-size:14px;outline:none}
  .chat-input:focus{border-color:var(--red)}
  .chat-send{background:var(--red);border:none;border-radius:10px;width:42px;flex-shrink:0;cursor:pointer;color:#fff;font-size:18px;font-weight:700;transition:transform .15s}
  .chat-send:active{transform:scale(.9)}

  /* Toast */
  .toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(80px);background:#1e1e28;border:1px solid var(--border);color:var(--text);padding:12px 20px;border-radius:14px;font-size:14px;font-weight:500;transition:transform .3s;z-index:999;text-align:center;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
  .toast.show{transform:translateX(-50%) translateY(0)}

  /* Skeleton */
  @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  .skel{background:linear-gradient(90deg,var(--border) 25%,var(--bg3) 50%,var(--border) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;height:1em;width:60%}

  /* Refresh countdown */
  .countdown{font-size:11px;color:var(--muted);text-align:center;padding:4px 0}
</style>
</head>
<body>
<header>
  <div class="logo">TES<span>LA</span></div>
  <div class="status-badge">
    <div class="dot" id="state-dot"></div>
    <span id="state-label">Loading…</span>
  </div>
  <svg class="refresh-ring" id="refresh-btn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" onclick="loadData(true)">
    <polyline points="23 4 23 10 17 10"></polyline>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
  </svg>
</header>

<div class="main">
  <!-- Battery Hero -->
  <div class="hero">
    <div class="car-name" id="car-name">—</div>
    <div class="battery-arc-wrap">
      <svg viewBox="0 0 200 120" width="200" height="120">
        <path class="arc-bg" d="M20,110 A90,90 0 0,1 180,110" />
        <path class="arc-fill" id="arc" d="M20,110 A90,90 0 0,1 180,110" />
      </svg>
      <div class="batt-pct" id="batt-pct">—<sup>%</sup></div>
    </div>
    <div class="range-text" id="range-text">— mi range</div>
    <div class="charging-pill idle" id="charge-pill">● Disconnected</div>
    <div class="hero-stats">
      <div class="hstat"><div class="hstat-val" id="h-odometer">—</div><div class="hstat-lbl">Odometer</div></div>
      <div class="hstat"><div class="hstat-val" id="h-limit">—%</div><div class="hstat-lbl">Limit</div></div>
      <div class="hstat"><div class="hstat-val" id="h-speed">— mph</div><div class="hstat-lbl">Speed</div></div>
    </div>
  </div>

  <!-- Climate + Charging -->
  <div class="cards">
    <div class="card">
      <div class="card-title">Climate</div>
      <div class="temp-row">
        <div class="temp-box"><div class="temp-big" id="cl-inside">—°</div><div class="temp-lbl">Inside</div></div>
        <div class="temp-box"><div class="temp-big" id="cl-outside">—°</div><div class="temp-lbl">Outside</div></div>
      </div>
      <button class="btn btn-secondary" id="climate-btn" onclick="toggleClimate()">— Climate</button>
    </div>
    <div class="card">
      <div class="card-title">Charging</div>
      <div class="card-value" id="ch-state">—</div>
      <div class="card-sub" id="ch-limit">Limit: —%</div>
      <div style="margin-top:12px">
        <div class="slider-wrap">
          <input type="range" id="limit-slider" min="50" max="100" value="80" oninput="updateSliderLabel(this.value)" onchange="setLimit(this.value)"/>
          <div class="slider-labels"><span>50%</span><span id="slider-lbl">80%</span><span>100%</span></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Action Grid -->
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">Quick Controls</div>
    <div class="actions">
      <div class="action-btn" id="btn-lock" onclick="cmd('lock my car','lock_doors')">
        <span class="icon">🔒</span><span>Lock</span>
      </div>
      <div class="action-btn" id="btn-unlock" onclick="cmd('unlock my car','unlock_doors')">
        <span class="icon">🔓</span><span>Unlock</span>
      </div>
      <div class="action-btn" id="btn-sentry" onclick="toggleSentry()">
        <span class="icon">👁</span><span id="sentry-lbl">Sentry</span>
      </div>
      <div class="action-btn" onclick="cmd('honk the horn','honk_horn')">
        <span class="icon">📯</span><span>Honk</span>
      </div>
      <div class="action-btn" onclick="cmd('flash lights','flash_lights')">
        <span class="icon">💡</span><span>Flash</span>
      </div>
      <div class="action-btn" onclick="cmd('vent windows','vent_windows')">
        <span class="icon">🌬</span><span>Vent</span>
      </div>
      <div class="action-btn" onclick="cmd('open rear trunk','open_trunk')">
        <span class="icon">🚗</span><span>Trunk</span>
      </div>
      <div class="action-btn" onclick="cmd('open frunk','open_trunk_front')">
        <span class="icon">🔧</span><span>Frunk</span>
      </div>
      <div class="action-btn" onclick="cmd('open charge port','open_charge_port')">
        <span class="icon">⚡</span><span>Charge Port</span>
      </div>
    </div>
  </div>

  <!-- AI Chat -->
  <div class="chat-card">
    <div class="chat-header"><div class="ai-dot"></div> AI Assistant (Gemini)</div>
    <div class="chat-messages" id="chat-msgs">
      <div class="msg bot">Hi! Tell me what to do — "set temp to 22", "lock the car", "what's my battery?" 🚗</div>
    </div>
    <div class="chat-input-row">
      <input class="chat-input" id="chat-in" type="text" placeholder="Ask anything…" onkeydown="if(event.key==='Enter')sendChat()"/>
      <button class="chat-send" onclick="sendChat()">↑</button>
    </div>
  </div>

  <div class="countdown" id="countdown">Refreshing in 30s</div>
</div>

<div class="toast" id="toast"></div>

<script>
let data = null;
let sentryOn = false;
let climateOn = false;
let countdownSec = 30;
let countdownTimer = null;

const ARC_LEN = 282.7; // circumference of the arc path

function setArc(pct) {
  const el = document.getElementById('arc');
  const filled = ARC_LEN * (pct / 100);
  el.style.strokeDasharray = ARC_LEN;
  el.style.strokeDashoffset = ARC_LEN - filled;
  el.className = 'arc-fill' + (pct <= 20 ? ' low' : pct <= 40 ? ' mid' : '');
}

function toast(msg, dur=3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

function updateSliderLabel(v) {
  document.getElementById('slider-lbl').textContent = v + '%';
}

async function loadData(manual=false) {
  if (manual) toast('Refreshing…', 1500);
  try {
    const r = await fetch('/api/status');
    if (!r.ok) { toast('⚠️ Could not load data'); return; }
    data = await r.json();
    render(data);
    resetCountdown();
  } catch(e) {
    toast('⚠️ Network error');
  }
}

function render(d) {
  document.getElementById('car-name').textContent = d.name || 'Tesla';
  const dot = document.getElementById('state-dot');
  const lbl = document.getElementById('state-label');
  dot.className = 'dot ' + (d.state === 'online' ? 'online' : 'asleep');
  lbl.textContent = d.state === 'online' ? 'Online' : (d.state || 'Unknown');

  // Battery arc
  const pct = d.battery ?? 0;
  setArc(pct);
  document.getElementById('batt-pct').innerHTML = pct + '<sup>%</sup>';
  document.getElementById('range-text').textContent = d.range_mi ? d.range_mi.toFixed(0) + ' mi range' : '— mi range';

  // Charging pill
  const pill = document.getElementById('charge-pill');
  const cs = (d.charging || '').toLowerCase();
  if (cs === 'charging') {
    pill.className = 'charging-pill';
    pill.textContent = '⚡ Charging';
  } else if (cs === 'complete') {
    pill.className = 'charging-pill';
    pill.style.background = 'rgba(48,209,88,.2)';
    pill.textContent = '✓ Charge Complete';
  } else if (cs === 'stopped') {
    pill.className = 'charging-pill idle';
    pill.textContent = '⏸ Plugged In';
  } else {
    pill.className = 'charging-pill idle';
    pill.textContent = '○ Unplugged';
  }

  document.getElementById('h-odometer').textContent = d.odometer ? Math.round(d.odometer).toLocaleString() + ' mi' : '—';
  document.getElementById('h-limit').textContent = (d.charge_limit ?? '—') + '%';
  document.getElementById('h-speed').textContent = (d.speed || 0) + ' mph';

  // Climate
  document.getElementById('cl-inside').textContent = d.inside_temp != null ? d.inside_temp.toFixed(1) + '°' : '—°';
  document.getElementById('cl-outside').textContent = d.outside_temp != null ? d.outside_temp.toFixed(1) + '°' : '—°';
  climateOn = !!d.climate_on;
  const cb = document.getElementById('climate-btn');
  cb.textContent = climateOn ? '❄️ Stop Climate' : '❄️ Start Climate';
  cb.className = climateOn ? 'btn btn-green' : 'btn btn-secondary';

  // Charging card
  document.getElementById('ch-state').textContent = d.charging || '—';
  document.getElementById('ch-limit').textContent = 'Limit: ' + (d.charge_limit ?? '—') + '%';
  if (d.charge_limit) {
    document.getElementById('limit-slider').value = d.charge_limit;
    updateSliderLabel(d.charge_limit);
  }

  // Sentry
  sentryOn = !!d.sentry;
  const sb = document.getElementById('btn-sentry');
  const sl = document.getElementById('sentry-lbl');
  if (sentryOn) { sb.className = 'action-btn active'; sl.textContent = 'Sentry ON'; }
  else { sb.className = 'action-btn'; sl.textContent = 'Sentry'; }

  // Lock
  const lockBtn = document.getElementById('btn-lock');
  const unlockBtn = document.getElementById('btn-unlock');
  if (d.locked) { lockBtn.className = 'action-btn active'; unlockBtn.className = 'action-btn'; }
  else { lockBtn.className = 'action-btn'; unlockBtn.className = 'action-btn danger'; }
}

async function cmd(text, hint) {
  toast('Sending: ' + text + '…', 2000);
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: text })
    });
    const j = await r.json();
    toast(j.reply || '✅ Done');
    setTimeout(() => loadData(), 2500);
  } catch(e) {
    toast('⚠️ Command failed');
  }
}

function toggleClimate() {
  cmd(climateOn ? 'stop climate' : 'start climate', climateOn ? 'stop_climate' : 'start_climate');
}

function toggleSentry() {
  cmd(sentryOn ? 'turn off sentry mode' : 'turn on sentry mode', 'set_sentry_mode');
}

function setLimit(val) {
  cmd('set charge limit to ' + val + ' percent', 'set_charge_limit');
}

async function sendChat() {
  const inp = document.getElementById('chat-in');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';

  const msgs = document.getElementById('chat-msgs');
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.textContent = text;
  msgs.appendChild(userMsg);

  const botMsg = document.createElement('div');
  botMsg.className = 'msg bot loading';
  botMsg.textContent = '...thinking';
  msgs.appendChild(botMsg);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: text })
    });
    const j = await r.json();
    botMsg.className = 'msg bot';
    botMsg.textContent = j.reply || 'Done';
    msgs.scrollTop = msgs.scrollHeight;
    setTimeout(() => loadData(), 2500);
  } catch(e) {
    botMsg.textContent = 'Network error';
  }
}

function resetCountdown() {
  countdownSec = 30;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdownSec--;
    document.getElementById('countdown').textContent = countdownSec > 0 ? 'Auto-refresh in ' + countdownSec + 's' : 'Refreshing...';
    if (countdownSec <= 0) { loadData(); }
  }, 1000);
}

// Kick off
loadData();
</script>
</body>
</html>`

app.get('/', requireAuth, (_req, res) => {
  res.type('text/html').send(DASHBOARD_HTML)
})

app.listen(PORT, async () => {
  console.log('[tesla-siri] Server running on http://localhost:' + PORT)
  console.log('[tesla-siri] AI mode: ' + (GEMINI_KEY ? 'Gemini (natural language)' : 'Keyword aliases'))
  console.log('[tesla-siri] Dashboard: http://localhost:' + PORT + '/')
  console.log('[tesla-siri] Endpoint:  http://localhost:' + PORT + '/siri?cmd=<your+command>')
  console.log('[tesla-siri] Health:    http://localhost:' + PORT + '/health')

  // Startup: force-refresh to get a clean user token immediately
  console.log('[token] Startup refresh...')
  await forceRefresh()

  // Background refresh every 6 hours — keeps the refresh token alive
  // (Tesla refresh tokens expire after ~45 days of no use)
  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
  setInterval(async () => {
    console.log('[token] Scheduled background refresh...')
    await forceRefresh()
  }, REFRESH_INTERVAL_MS)
})
