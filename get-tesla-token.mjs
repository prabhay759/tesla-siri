/**
 * Tesla Fleet API — Partner Token + Registration
 *
 * Usage:
 *   node get-tesla-token.mjs                    # just get partner token
 *   node get-tesla-token.mjs abc.ngrok-free.dev  # also register with that domain
 *
 * The ngrok domain is required to complete partner registration.
 * Run start-tesla.ps1 first to get your current ngrok URL, then pass
 * just the hostname (no https://) as the argument.
 */

import https from 'https'
import { URLSearchParams } from 'url'
import { writeFileSync, readFileSync, existsSync } from 'fs'

// ── Credentials ──────────────────────────────────────────────────────────────
const CLIENT_ID     = 'e043473e-a97b-4cdd-bdf3-3d9f898ae1a1'
const CLIENT_SECRET = 'ta-secret.PQZ5BZxbCVopC-B7'
const AUDIENCE      = 'https://fleet-api.prd.eu.vn.cloud.tesla.com'
const SCOPES        = 'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds'

// ── Ngrok domain from args or .env ───────────────────────────────────────────
let NGROK_DOMAIN = process.argv[2] ?? null

// Strip protocol if accidentally included
if (NGROK_DOMAIN) {
  NGROK_DOMAIN = NGROK_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString()
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = ''
      res.on('data', c => (raw += c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, body: raw }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function postJson(hostname, path, token, jsonBody) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(jsonBody)
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = ''
      res.on('data', c => (raw += c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, body: raw }) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function get(hostname, path, token) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let raw = ''
      res.on('data', c => (raw += c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, body: raw }) }
      })
    }).on('error', reject).end()
  })
}

function updateEnv(updates) {
  let lines = existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(key + '='))
    if (idx >= 0) { lines[idx] = `${key}=${value}` } else { lines.push(`${key}=${value}`) }
  }
  writeFileSync('.env', lines.join('\n'))
}

// ── Step 1: Partner token ─────────────────────────────────────────────────────
console.log('\n🔑  Requesting partner token from Tesla...\n')

const resp = await post('auth.tesla.com', '/oauth2/v3/token', {
  grant_type:    'client_credentials',
  client_id:     CLIENT_ID,
  client_secret: CLIENT_SECRET,
  scope:         SCOPES,
  audience:      AUDIENCE,
})

if (resp.status !== 200) {
  console.error('❌  Token request failed:', resp.status, resp.body)
  process.exit(1)
}

const { access_token, expires_in, token_type } = resp.body

console.log('✅  Partner token received!')
console.log(`    Token type : ${token_type}`)
console.log(`    Expires in : ${expires_in}s (~${Math.round(expires_in/3600)}h)\n`)

updateEnv({ TESLA_ACCESS_TOKEN: access_token })
console.log('📄  Saved TESLA_ACCESS_TOKEN to .env\n')

// ── Step 2: Register with ngrok domain ────────────────────────────────────────
if (!NGROK_DOMAIN) {
  console.log('⚠️   No ngrok domain provided — skipping registration.')
  console.log('    Registration is required before vehicle commands will work.')
  console.log('    Steps:')
  console.log('      1. Run .\\start-tesla.ps1 to get your ngrok URL')
  console.log('      2. Run: node get-tesla-token.mjs <your-ngrok-domain>')
  console.log('         e.g.: node get-tesla-token.mjs abc.ngrok-free.dev\n')
} else {
  console.log(`📋  Registering partner account with domain: ${NGROK_DOMAIN}\n`)
  console.log(`    Tesla will verify: https://${NGROK_DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem`)
  console.log('    (Make sure start-tesla.ps1 is running and the Siri server is up)\n')

  const regResp = await postJson(
    'fleet-api.prd.eu.vn.cloud.tesla.com',
    '/api/1/partner_accounts',
    access_token,
    { domain: NGROK_DOMAIN }
  )

  console.log(`    /partner_accounts status: ${regResp.status}`)
  console.log('    Response:', JSON.stringify(regResp.body, null, 4), '\n')

  if (regResp.status === 200 || regResp.status === 204) {
    console.log('✅  Partner account registered successfully!\n')
    updateEnv({ TESLA_NGROK_DOMAIN: NGROK_DOMAIN })
  } else if (regResp.status === 422 && JSON.stringify(regResp.body).includes('already')) {
    console.log('✅  Already registered — no action needed.\n')
  } else {
    console.log('❌  Registration failed. Check that:')
    console.log(`    • start-tesla.ps1 is running (Siri server is up on port 3000)`)
    console.log(`    • ngrok is running and ${NGROK_DOMAIN} is the active tunnel`)
    console.log(`    • tesla-public.pem exists (run: node generate-keys.mjs)`)
    console.log(`    • ${NGROK_DOMAIN} is added to Allowed Origins in Tesla developer portal\n`)
  }

  // Verify public key is live
  console.log('🔍  Verifying public key is accessible...\n')
  const pkResp = await get(
    'fleet-api.prd.eu.vn.cloud.tesla.com',
    `/api/1/partner_accounts/public_key?domain=${NGROK_DOMAIN}`,
    access_token
  )
  console.log(`    /public_key status: ${pkResp.status}`)
  if (pkResp.status === 200) {
    console.log('    ✅  Public key is live and registered!\n')
  } else {
    console.log('    Response:', JSON.stringify(pkResp.body, null, 4), '\n')
  }
}

// ── Step 3: Print auth URL for user token ─────────────────────────────────────
const authUrl = new URL('https://auth.tesla.com/oauth2/v3/authorize')
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('client_id',     CLIENT_ID)
authUrl.searchParams.set('redirect_uri',  'http://localhost:5431/mcp')
authUrl.searchParams.set('scope',         SCOPES)
authUrl.searchParams.set('state',         'tesla-mcp-setup')

console.log('──────────────────────────────────────────────────────────────────')
console.log('🚗  To get a USER token (needed to control your actual vehicle):')
console.log('    1. Open this URL in your browser and log in with your Tesla account:')
console.log(`\n    ${authUrl.toString()}\n`)
console.log('    2. After approving, Tesla redirects to:')
console.log('       http://localhost:5431/mcp?code=AUTH_CODE&...')
console.log('       (the page won\'t load — just copy the code= param from the URL bar)')
console.log('    3. Run:')
console.log(`\n       node exchange-code.mjs <AUTH_CODE>\n`)
console.log('──────────────────────────────────────────────────────────────────\n')
