/**
 * Tesla Token Manager
 *
 * Handles the full token lifecycle:
 *  1. Loads tokens from tokens.json (created after first auth)
 *  2. On every request, checks if the access token is near expiry
 *  3. If so, refreshes using the refresh_token (user-level token)
 *  4. If refresh fails (expired/revoked), falls back to client_credentials
 *     (partner-level token — vehicle commands won't work, but at least the
 *     server stays alive and logs a clear error)
 *  5. Persists updated tokens back to tokens.json
 */

import https from 'https'
import { URLSearchParams } from 'url'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKENS_FILE = path.resolve(__dirname, '../../tokens.json')

const CLIENT_ID     = process.env.TESLA_CLIENT_ID!
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET!
const AUDIENCE      = 'https://fleet-api.prd.eu.vn.cloud.tesla.com'
const SCOPES        = 'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds'

// Refresh when less than 5 minutes remain
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

export interface Tokens {
  access_token:  string
  refresh_token?: string
  expires_at:    number   // Unix ms
  token_type:    'user' | 'partner'
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────

/** Decode the exp claim from a JWT without verifying the signature. */
function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    )
    if (payload.exp) return payload.exp * 1000   // convert seconds → ms
  } catch { /* ignore */ }
  return Date.now() + 8 * 60 * 60 * 1000        // fallback: 8 h
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadTokens(): Tokens | null {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8')
    return JSON.parse(raw) as Tokens
  } catch {
    return null
  }
}

function saveTokens(t: Tokens): void {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2))
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function postForm(hostname: string, path: string, body: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString()
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(data) } },
      res => {
        let raw = ''
        res.on('data', c => (raw += c))
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ─── Refresh strategies ───────────────────────────────────────────────────────

async function refreshWithRefreshToken(refreshToken: string): Promise<Tokens> {
  console.error('[token] Refreshing via refresh_token...')
  const res = await postForm('auth.tesla.com', '/oauth2/v3/token', {
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  })
  if (res.status !== 200) throw new Error(`Refresh failed: ${JSON.stringify(res.body)}`)
  const { access_token, refresh_token, expires_in } = res.body
  return {
    access_token,
    refresh_token: refresh_token ?? refreshToken,
    expires_at:    Date.now() + expires_in * 1000,
    token_type:    'user',
  }
}

async function refreshWithClientCredentials(): Promise<Tokens> {
  console.error('[token] Falling back to client_credentials (partner token)...')
  const res = await postForm('auth.tesla.com', '/oauth2/v3/token', {
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         SCOPES,
    audience:      AUDIENCE,
  })
  if (res.status !== 200) throw new Error(`client_credentials failed: ${JSON.stringify(res.body)}`)
  const { access_token, expires_in } = res.body
  return {
    access_token,
    expires_at: Date.now() + expires_in * 1000,
    token_type: 'partner',
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

let _tokens: Tokens | null = null

/** Returns a valid access token, refreshing if necessary. */
export async function getAccessToken(): Promise<string> {
  // Bootstrap: load from env or tokens.json
  if (!_tokens) {
    const fromEnv    = process.env.TESLA_ACCESS_TOKEN
    const refreshEnv = process.env.TESLA_REFRESH_TOKEN
    if (fromEnv) {
      _tokens = {
        access_token:  fromEnv,
        refresh_token: refreshEnv,
        expires_at:    jwtExpiry(fromEnv),   // read real expiry from JWT
        token_type:    refreshEnv ? 'user' : 'partner',
      }
    } else if (refreshEnv) {
      // No access token but we have a refresh token — force immediate refresh
      console.error('[token] No access token in env; will refresh via refresh_token...')
      _tokens = {
        access_token:  '',
        refresh_token: refreshEnv,
        expires_at:    0,   // expired → triggers refresh on next check
        token_type:    'user',
      }
    } else {
      _tokens = loadTokens()
    }
  }

  // No tokens at all → try client_credentials as last resort
  if (!_tokens) {
    _tokens = await refreshWithClientCredentials()
    saveTokens(_tokens)
    return _tokens.access_token
  }

  // Token still valid
  if (_tokens.expires_at - Date.now() > EXPIRY_BUFFER_MS) {
    return _tokens.access_token
  }

  // Token near/past expiry → refresh
  console.error('[token] Access token expiring, refreshing...')
  try {
    if (_tokens.refresh_token) {
      _tokens = await refreshWithRefreshToken(_tokens.refresh_token)
    } else {
      _tokens = await refreshWithClientCredentials()
    }
    saveTokens(_tokens)
    console.error(`[token] Refreshed OK (type=${_tokens.token_type}, expires in ${Math.round((_tokens.expires_at - Date.now()) / 60000)}m)`)
  } catch (err) {
    console.error('[token] Refresh failed, retrying with client_credentials:', err)
    _tokens = await refreshWithClientCredentials()
    saveTokens(_tokens)
  }

  return _tokens.access_token
}

/** Force-invalidate cached token (call after 401 to trigger a refresh on next request). */
export function invalidateToken(): void {
  if (_tokens) {
    _tokens.expires_at = 0
  }
}

/**
 * Proactively refresh the token regardless of expiry.
 * Safe to call from a background timer.
 */
export async function forceRefresh(): Promise<void> {
  if (!_tokens) {
    await getAccessToken()   // bootstraps and refreshes
    return
  }
  try {
    if (_tokens.refresh_token) {
      _tokens = await refreshWithRefreshToken(_tokens.refresh_token)
    } else {
      _tokens = await refreshWithClientCredentials()
    }
    saveTokens(_tokens)
    const mins = Math.round((_tokens.expires_at - Date.now()) / 60000)
    console.error('[token] Proactive refresh OK — type=' + _tokens.token_type + ', expires in ' + mins + 'm')
  } catch (err) {
    console.error('[token] Proactive refresh failed:', err)
  }
}

/** Returns the current token type so callers can warn if vehicle commands won't work. */
export function getTokenType(): 'user' | 'partner' | null {
  return _tokens?.token_type ?? null
}

/** Returns ms until the current token expires (negative = already expired). */
export function tokenExpiresInMs(): number {
  return (_tokens?.expires_at ?? 0) - Date.now()
}

/** Bootstrap tokens.json from initial values (called once after OAuth flow). */
export function bootstrapTokens(tokens: Tokens): void {
  _tokens = tokens
  saveTokens(tokens)
  console.error('[token] Bootstrapped tokens.json')
}
