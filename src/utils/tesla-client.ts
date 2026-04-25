/**
 * Tesla Fleet API Client
 *
 * Wraps all Tesla Fleet API calls. Automatically:
 *  - Injects the current access token
 *  - Retries once on 401 (after invalidating + refreshing the token)
 *  - Wakes the vehicle when required before commands
 */

import https from 'https'
import { getAccessToken, invalidateToken } from './token-manager.js'

const FLEET_HOST = 'fleet-api.prd.eu.vn.cloud.tesla.com'
const MAX_WAKE_RETRIES = 10
const WAKE_POLL_MS = 3000

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface ApiResponse<T = any> {
  status: number
  body:   T
}

async function request<T>(
  method:  string,
  path:    string,
  payload: object | null = null,
  retry   = true
): Promise<ApiResponse<T>> {
  const token = await getAccessToken()
  const data  = payload ? JSON.stringify(payload) : null

  const res = await new Promise<ApiResponse<T>>((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: FLEET_HOST,
      path,
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }
    const req = https.request(opts, r => {
      let raw = ''
      r.on('data', c => (raw += c))
      r.on('end', () => {
        try { resolve({ status: r.statusCode!, body: JSON.parse(raw) }) }
        catch { resolve({ status: r.statusCode!, body: raw as any }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

  // 401 → refresh token and retry once
  if (res.status === 401 && retry) {
    console.error('[tesla] Got 401, invalidating token and retrying...')
    invalidateToken()
    return request(method, path, payload, false)
  }

  return res
}

function get<T>(path: string) { return request<T>('GET', path) }
function post<T>(path: string, body?: object) { return request<T>('POST', path, body ?? {}) }

// ─── Wake helper ──────────────────────────────────────────────────────────────

export async function wakeVehicle(vin: string): Promise<void> {
  console.error(`[tesla] Waking vehicle ${vin}...`)
  await post(`/api/1/vehicles/${vin}/wake_up`)

  for (let i = 0; i < MAX_WAKE_RETRIES; i++) {
    await sleep(WAKE_POLL_MS)
    const res = await get<any>(`/api/1/vehicles/${vin}`)
    const state = res.body?.response?.state
    if (state === 'online') {
      console.error('[tesla] Vehicle is online')
      return
    }
    console.error(`[tesla] Vehicle state: ${state} (retry ${i + 1}/${MAX_WAKE_RETRIES})`)
  }
  throw new Error('Vehicle did not wake up in time')
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Public API methods ───────────────────────────────────────────────────────

export class TeslaClient {
  constructor(private vin: string) {}

  // ── Vehicle state ──
  async getVehicle() {
    return get<any>(`/api/1/vehicles/${this.vin}`)
  }

  async getVehicleData() {
    const res = await get<any>(`/api/1/vehicles/${this.vin}/vehicle_data?endpoints=charge_state%3Bclimate_state%3Bdrive_state%3Bgui_settings%3Bvehicle_state`)
    return res
  }

  async wake() {
    await wakeVehicle(this.vin)
    return { ok: true }
  }

  // ── Doors / security ──
  async lock() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/door_lock`)
  }

  async unlock() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/door_unlock`)
  }

  async openTrunk(which: 'rear' | 'front' = 'rear') {
    return post<any>(`/api/1/vehicles/${this.vin}/command/actuate_trunk`, { which_trunk: which })
  }

  // ── Horn / lights ──
  async honkHorn() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/honk_horn`)
  }

  async flashLights() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/flash_lights`)
  }

  // ── Climate ──
  async startClimate() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/auto_conditioning_start`)
  }

  async stopClimate() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/auto_conditioning_stop`)
  }

  async setTemperature(driverTempC: number, passengerTempC?: number) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/set_temps`, {
      driver_temp: driverTempC,
      passenger_temp: passengerTempC ?? driverTempC,
    })
  }

  async setPreconditioning(on: boolean) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/set_preconditioning_max`, { on })
  }

  // ── Charging ──
  async startCharging() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/charge_start`)
  }

  async stopCharging() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/charge_stop`)
  }

  async setChargeLimit(percent: number) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/set_charge_limit`, { percent })
  }

  async openChargePort() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/charge_port_door_open`)
  }

  async closeChargePort() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/charge_port_door_close`)
  }

  // ── Windows ──
  async ventWindows() {
    return post<any>(`/api/1/vehicles/${this.vin}/command/window_control`, {
      command: 'vent', lat: 0, lon: 0,
    })
  }

  async closeWindows(lat: number, lon: number) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/window_control`, {
      command: 'close', lat, lon,
    })
  }

  // ── Sentry ──
  async setSentryMode(on: boolean) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/set_sentry_mode`, { on })
  }

  // ── Navigation ──
  async navigateTo(destination: string) {
    return post<any>(`/api/1/vehicles/${this.vin}/command/navigation_request`, {
      type:         'share_ext_content_raw',
      value:        { 'android.intent.extra.TEXT': destination },
      locale:       'en-US',
      timestamp_ms: Date.now().toString(),
    })
  }

  // ── User & fleet ──
  async getMe() {
    return get<any>('/api/1/users/me')
  }

  async listVehicles() {
    return get<any>('/api/1/vehicles')
  }
}
