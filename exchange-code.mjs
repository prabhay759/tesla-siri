/**
 * Tesla Fleet API — Authorization Code → User Token
 *
 * Run with:  node exchange-code.mjs <AUTH_CODE>
 *
 * After logging in via the Tesla auth URL printed by get-tesla-token.mjs,
 * paste the `code` query param here to exchange it for a user access token
 * that can control your vehicle.
 */

import https from 'https'
import { URLSearchParams } from 'url'
import { writeFileSync, readFileSync, existsSync } from 'fs'

const CLIENT_ID     = 'e043473e-a97b-4cdd-bdf3-3d9f898ae1a1'
const CLIENT_SECRET = 'ta-secret.PQZ5BZxbCVopC-B7'
const REDIRECT_URI  = 'http://localhost:5431/mcp'   // must match what is registered in Tesla developer portal

const code = process.argv[2]
if (!code) {
  console.error('Usage: node exchange-code.mjs <AUTH_CODE>')
  process.exit(1)
}

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString()
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      }
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

console.log('\n🔄  Exchanging auth code for user token...\n')

const resp = await post('auth.tesla.com', '/oauth2/v3/token', {
  grant_type:    'authorization_code',
  client_id:     CLIENT_ID,
  client_secret: CLIENT_SECRET,
  code,
  redirect_uri:  REDIRECT_URI,
})

if (resp.status !== 200) {
  console.error('❌  Exchange failed:', resp.status, resp.body)
  process.exit(1)
}

const { access_token, refresh_token, expires_in } = resp.body

console.log('✅  User token received!')
console.log(`    Expires in   : ${expires_in}s (~${Math.round(expires_in/3600)}h)`)
console.log(`    Refresh token: ${refresh_token}\n`)
console.log(`    USER ACCESS TOKEN:\n\n    ${access_token}\n`)

// Merge tokens into existing .env without overwriting other keys
function updateEnv(updates) {
  let lines = existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(key + '='))
    if (idx >= 0) {
      lines[idx] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  writeFileSync('.env', lines.join('\n'))
}

updateEnv({
  TESLA_ACCESS_TOKEN:  access_token,
  TESLA_REFRESH_TOKEN: refresh_token,
})
console.log('📄  Updated TESLA_ACCESS_TOKEN and TESLA_REFRESH_TOKEN in .env (all other values preserved).\n')

// Quick vehicle list test
console.log('🚗  Fetching your vehicles...\n')
const vResp = await new Promise((resolve, reject) => {
  https.request({
    hostname: 'fleet-api.prd.eu.vn.cloud.tesla.com',
    path: '/api/1/vehicles',
    method: 'GET',
    headers: { Authorization: `Bearer ${access_token}` },
  }, res => {
    let raw = ''
    res.on('data', c => (raw += c))
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
      catch { resolve({ status: res.statusCode, body: raw }) }
    })
  }).on('error', reject).end()
})

console.log(`    /vehicles status: ${vResp.status}`)
if (vResp.body?.response) {
  vResp.body.response.forEach(v => {
    console.log(`    🚘  ${v.display_name} — VIN: ${v.vin} (${v.state})`)
  })
  console.log('\n    ✅  Copy your VIN above into the .env file as TESLA_VIN=\n')
} else {
  console.log('    Response:', JSON.stringify(vResp.body, null, 4))
}
