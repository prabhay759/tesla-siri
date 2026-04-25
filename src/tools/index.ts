/**
 * Tesla MCP Tools
 *
 * Each tool is exposed to Claude via the MCP server. Claude can call these
 * to inspect and control the vehicle. Tools auto-wake the car when needed.
 */

import { z } from 'zod'
import { TeslaClient } from '../utils/tesla-client.js'

export interface Tool {
  name:        string
  description: string
  inputSchema: z.ZodObject<any>
  handler:     (input: any, client: TeslaClient) => Promise<string>
}

// Helper: extract a human-readable result string from a Fleet API response
function result(res: { status: number; body: any }, successMsg?: string): string {
  if (res.status >= 400) {
    const err = res.body?.error ?? res.body?.message ?? JSON.stringify(res.body)
    return `❌ Error (${res.status}): ${err}`
  }
  const r = res.body?.response
  if (r?.result === false) return `❌ ${r.reason ?? 'Command rejected by vehicle'}`
  return successMsg ?? (typeof r === 'object' ? JSON.stringify(r, null, 2) : String(r))
}

// Helper: format battery/range info
function batteryLine(charge: any): string {
  if (!charge) return 'No charge data'
  return `🔋 ${charge.battery_level}% · ${charge.battery_range?.toFixed(1)} mi · ${charge.charging_state} · Limit: ${charge.charge_limit_soc}%`
}

export const tools: Tool[] = [
  // ── Status ────────────────────────────────────────────────────────────────

  {
    name: 'get_vehicle_status',
    description: 'Get a full snapshot of the vehicle: battery, range, climate, location, lock state, sentry mode.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      const res = await client.getVehicleData()
      if (res.status >= 400) return result(res)
      const d  = res.body?.response
      const cs = d?.charge_state
      const cl = d?.climate_state
      const vs = d?.vehicle_state
      const ds = d?.drive_state
      const lines = [
        `🚗  ${d?.display_name ?? 'Tesla'} — ${d?.state ?? 'unknown'}`,
        batteryLine(cs),
        `🌡️  Inside: ${cl?.inside_temp?.toFixed(1)}°C · Outside: ${cl?.outside_temp?.toFixed(1)}°C · Climate: ${cl?.is_climate_on ? 'ON' : 'off'}`,
        `🔒  Doors: ${vs?.locked ? 'Locked' : 'Unlocked'} · Sentry: ${vs?.sentry_mode ? 'ON' : 'off'}`,
        ds?.latitude ? `📍  ${ds.latitude.toFixed(5)}, ${ds.longitude.toFixed(5)} · Speed: ${ds.speed ?? 0} mph` : '📍  Location unavailable',
      ]
      return lines.join('\n')
    },
  },

  {
    name: 'get_battery',
    description: 'Quick check: battery percentage, estimated range, and charging state.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      const res = await client.getVehicleData()
      if (res.status >= 400) return result(res)
      return batteryLine(res.body?.response?.charge_state)
    },
  },

  // ── Wake ──────────────────────────────────────────────────────────────────

  {
    name: 'wake_vehicle',
    description: 'Wake the vehicle from sleep. Other commands will auto-wake, but you can call this explicitly.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      try {
        await client.wake()
        return '✅ Vehicle is now online'
      } catch (e: any) {
        return `❌ ${e.message}`
      }
    },
  },

  // ── Doors / Security ──────────────────────────────────────────────────────

  {
    name: 'lock_doors',
    description: 'Lock all doors.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.lock(), '✅ Doors locked')
    },
  },

  {
    name: 'unlock_doors',
    description: 'Unlock all doors.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.unlock(), '✅ Doors unlocked')
    },
  },

  {
    name: 'open_trunk',
    description: 'Open the trunk (rear or front/frunk).',
    inputSchema: z.object({
      which: z.enum(['rear', 'front']).optional().describe('rear (default) or front (frunk)'),
    }),
    async handler(input, client) {
      await client.wake()
      const which = (input.which ?? 'rear') as 'rear' | 'front'
      return result(await client.openTrunk(which), `✅ ${which === 'front' ? 'Frunk' : 'Trunk'} opened`)
    },
  },

  {
    name: 'set_sentry_mode',
    description: 'Enable or disable Sentry Mode.',
    inputSchema: z.object({
      on: z.boolean().describe('true to enable, false to disable'),
    }),
    async handler(input, client) {
      await client.wake()
      return result(await client.setSentryMode(input.on), `✅ Sentry mode ${input.on ? 'enabled' : 'disabled'}`)
    },
  },

  // ── Horn / Lights ─────────────────────────────────────────────────────────

  {
    name: 'honk_horn',
    description: 'Honk the horn once.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.honkHorn(), '✅ Honk!')
    },
  },

  {
    name: 'flash_lights',
    description: 'Flash the headlights to locate the car.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.flashLights(), '✅ Lights flashed')
    },
  },

  // ── Climate ───────────────────────────────────────────────────────────────

  {
    name: 'start_climate',
    description: 'Turn on climate control (uses last set temperature).',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.startClimate(), '✅ Climate started')
    },
  },

  {
    name: 'stop_climate',
    description: 'Turn off climate control.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.stopClimate(), '✅ Climate stopped')
    },
  },

  {
    name: 'set_temperature',
    description: 'Set the cabin temperature in Celsius.',
    inputSchema: z.object({
      tempC: z.number().min(15).max(30).describe('Target temperature in Celsius (15–30)'),
    }),
    async handler(input, client) {
      await client.wake()
      return result(await client.setTemperature(input.tempC), `✅ Temperature set to ${input.tempC}°C`)
    },
  },

  // ── Charging ──────────────────────────────────────────────────────────────

  {
    name: 'start_charging',
    description: 'Start charging (car must be plugged in).',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.startCharging(), '✅ Charging started')
    },
  },

  {
    name: 'stop_charging',
    description: 'Stop charging.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.stopCharging(), '✅ Charging stopped')
    },
  },

  {
    name: 'set_charge_limit',
    description: 'Set the charge limit percentage (50–100).',
    inputSchema: z.object({
      percent: z.number().min(50).max(100).describe('Charge limit percentage (50–100)'),
    }),
    async handler(input, client) {
      await client.wake()
      return result(await client.setChargeLimit(input.percent), `✅ Charge limit set to ${input.percent}%`)
    },
  },

  {
    name: 'open_charge_port',
    description: 'Open or close the charge port door.',
    inputSchema: z.object({
      open: z.boolean().describe('true to open, false to close'),
    }),
    async handler(input, client) {
      await client.wake()
      if (input.open) {
        return result(await client.openChargePort(), '✅ Charge port opened')
      } else {
        return result(await client.closeChargePort(), '✅ Charge port closed')
      }
    },
  },

  // ── Windows ───────────────────────────────────────────────────────────────

  {
    name: 'vent_windows',
    description: 'Vent all windows slightly open.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      await client.wake()
      return result(await client.ventWindows(), '✅ Windows vented')
    },
  },

  // ── List vehicles ─────────────────────────────────────────────────────────

  {
    name: 'list_vehicles',
    description: 'List all Tesla vehicles on this account with their VINs and states.',
    inputSchema: z.object({}),
    async handler(_input, client) {
      const res = await client.listVehicles()
      if (res.status >= 400) return result(res)
      const vehicles = res.body?.response ?? []
      if (!vehicles.length) return 'No vehicles found on this account.'
      return vehicles
        .map((v: any) => `🚘 ${v.display_name} · VIN: ${v.vin} · State: ${v.state}`)
        .join('\n')
    },
  },

  {
    name: 'plan_route',
    description: 'Plan a multi-stop route, geocode each waypoint, check battery range, and send the full Google Maps route to the car navigation.',
    inputSchema: z.object({
      waypoints: z.array(z.string()).min(2).describe('Ordered list of place names or addresses'),
    }),
    async handler(input, client) {
      const { waypoints } = input as { waypoints: string[] }

      // Keywords that mean "where the car is right now"
      const CURRENT_LOCATION_ALIASES = new Set([
        'current location', 'my location', 'here', 'current position',
        'my current location', 'where i am', 'start', 'origin',
      ])

      // Lazy-load car GPS — only called if a waypoint is "current location"
      let carCoords: { lat: number; lon: number } | null = null
      async function getCarCoords() {
        if (carCoords) return carCoords
        try {
          const data = await client.getVehicleData()
          const ds   = data?.body?.response?.drive_state
          if (ds?.latitude && ds?.longitude) {
            carCoords = { lat: ds.latitude, lon: ds.longitude }
            console.log('[plan_route] car GPS:', carCoords)
          }
        } catch { /* non-fatal */ }
        return carCoords
      }

      async function geocode(address: string) {
        // Handle "current location" — use car's GPS
        if (CURRENT_LOCATION_ALIASES.has(address.toLowerCase().trim())) {
          const pos = await getCarCoords()
          if (pos) return { lat: pos.lat, lon: pos.lon, name: 'Current Location' }
          // Fallback: return null and skip this waypoint — Tesla starts from car position anyway
          return null
        }
        const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(address) + '&format=json&limit=1'
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'TeslaSiriServer/1.0' } })
          const arr = (await res.json()) as any[]
          if (!arr?.length) return null
          const short = arr[0].display_name.split(',').slice(0, 2).join(',').trim()
          return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), name: short }
        } catch { return null }
      }

      function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
        const R = 3958.8
        const dLat = (lat2 - lat1) * (Math.PI / 180)
        const dLon = (lon2 - lon1) * (Math.PI / 180)
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2
        return R * 2 * Math.asin(Math.sqrt(a))
      }

      const allCoords = await Promise.all(waypoints.map(geocode))

      // Drop null "current location" entries if GPS unavailable (Tesla uses car position anyway)
      const coords  = allCoords.filter(Boolean) as { lat: number; lon: number; name: string }[]
      const failed  = waypoints.filter((w, i) => !allCoords[i] && !CURRENT_LOCATION_ALIASES.has(w.toLowerCase().trim()))
      if (failed.length) return 'Could not find location(s): ' + failed.join(', ')
      if (coords.length < 1) return 'No valid destinations found.'

      let totalMiles = 0
      const legLines: string[] = []
      for (let i = 0; i < coords.length - 1; i++) {
        const from = coords[i]!
        const to   = coords[i + 1]!
        const d    = haversineMiles(from.lat, from.lon, to.lat, to.lon)
        totalMiles += d
        legLines.push('  Leg ' + (i + 1) + ': ' + from.name + ' to ' + to.name + ' (~' + d.toFixed(0) + ' mi)')
      }

      let rangeNote = ''
      try {
        const data = await client.getVehicleData()
        const rangeMi = data.body?.response?.charge_state?.battery_range as number | undefined
        if (rangeMi != null) {
          rangeNote = rangeMi >= totalMiles
            ? 'Battery OK: ' + rangeMi.toFixed(0) + ' mi available covers the ' + totalMiles.toFixed(0) + ' mi route'
            : 'WARNING: only ' + rangeMi.toFixed(0) + ' mi battery for ' + totalMiles.toFixed(0) + ' mi route - plan a charging stop!'
        }
      } catch { /* non-critical */ }

      const mapsUrl = 'https://www.google.com/maps/dir/' + coords.map(c => c!.lat + ',' + c!.lon).join('/')
      await client.wake()
      const navRes = await client.navigateTo(mapsUrl)
      const navOk  = navRes.status < 400

      return [
        'Route: ' + waypoints.join(' -> '),
        ...legLines,
        'Total: ~' + totalMiles.toFixed(0) + ' miles',
        rangeNote,
        navOk ? 'Navigation sent to your Tesla - check your screen!' : 'Nav failed (' + navRes.status + ') - check car connection',
      ].filter(Boolean).join('\n')
    },
  },
]
