/**
 * Quick API diagnostic — run with:  node test-api.mjs
 */
import https from 'https'
import { readFileSync, existsSync } from 'fs'

// Load tokens from .env
function loadEnv() {
  if (!existsSync('.env')) return {}
  return Object.fromEntries(
    readFileSync('.env', 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.split('=')[0].trim(), l.slice(l.indexOf('=')+1).trim()])
  )
}

const env = loadEnv()
const token = env.TESLA_ACCESS_TOKEN
if (!token) { console.error('No TESLA_ACCESS_TOKEN in .env'); process.exit(1) }

function get(path) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'fleet-api.prd.eu.vn.cloud.tesla.com',
      path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, r => {
      let d = ''
      r.on('data', c => d += c)
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(d) }) }
        catch { resolve({ status: r.statusCode, body: d }) }
      })
    }).on('error', reject).end()
  })
}

console.log('\n🔍  Testing Tesla EU Fleet API...\n')

const me = await get('/api/1/users/me')
console.log(`/users/me        → HTTP ${me.status}`)
console.log(JSON.stringify(me.body, null, 2))

const v = await get('/api/1/vehicles')
console.log(`\n/vehicles        → HTTP ${v.status}`)
console.log(JSON.stringify(v.body, null, 2))

if (v.body?.response?.length) {
  const vin = v.body.response[0].vin
  const data = await get(`/api/1/vehicles/${vin}/vehicle_data`)
  console.log(`\n/vehicle_data    → HTTP ${data.status}`)
  console.log(JSON.stringify(data.body?.response?.charge_state ?? data.body, null, 2))
}
