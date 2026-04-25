/**
 * Tesla Fleet API — EC Key Pair Generator
 *
 * Generates a secp256r1 (prime256v1) EC key pair required for Tesla partner registration.
 *
 * Run once:  node generate-keys.mjs
 *
 * Output files:
 *   tesla-private.pem  — keep private, used to sign vehicle commands
 *   tesla-public.pem   — must be hosted at:
 *                        https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
 */

import { generateKeyPairSync } from 'crypto'
import { writeFileSync, readFileSync, existsSync } from 'fs'

if (existsSync('tesla-private.pem') || existsSync('tesla-public.pem')) {
  console.log('⚠️   Key files already exist (tesla-private.pem / tesla-public.pem).')
  console.log('     Delete them first if you want to regenerate.')
  process.exit(0)
}

console.log('\n🔑  Generating EC key pair (secp256r1 / prime256v1)...\n')

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

writeFileSync('tesla-private.pem', privateKey, { mode: 0o600 })
writeFileSync('tesla-public.pem',  publicKey)

console.log('✅  tesla-private.pem  — KEEP THIS SECRET')
console.log('✅  tesla-public.pem   — will be served at /.well-known/appspecific/com.tesla.3p.public-key.pem')
console.log()

// Update .env
function updateEnv(updates) {
  let lines = existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(key + '='))
    if (idx >= 0) { lines[idx] = `${key}=${value}` } else { lines.push(`${key}=${value}`) }
  }
  writeFileSync('.env', lines.join('\n'))
}

updateEnv({ TESLA_PUBLIC_KEY_FILE: 'tesla-public.pem' })
console.log('📄  Updated TESLA_PUBLIC_KEY_FILE in .env\n')

console.log('Next steps:')
console.log('  1. Start the Siri server so it serves the public key:  .\\start-tesla.ps1')
console.log('  2. Verify the key is live: https://<ngrok-url>/.well-known/appspecific/com.tesla.3p.public-key.pem')
console.log('  3. In Tesla developer portal, add the ngrok URL to Allowed Origins')
console.log('  4. Register: node get-tesla-token.mjs <ngrok-domain>')
console.log('     e.g.    : node get-tesla-token.mjs abc.ngrok-free.dev\n')
