/**
 * Tesla MCP Server — Entry Point
 *
 * Supports two modes (set via MCP_MODE env var):
 *   stdio  — connects to Claude Desktop / Claude Code
 *   http   — SSE + POST endpoints (for remote Claude connections or testing)
 */

import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express from 'express'
import { TeslaClient } from './utils/tesla-client.js'
import { tools } from './tools/index.js'

// ── Validate env ──────────────────────────────────────────────────────────────

const REQUIRED = ['TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TESLA_VIN']
const missing  = REQUIRED.filter(k => !process.env[k])
if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(', ')}`)
  console.error('    Set them in .env — see .env.example')
  process.exit(1)
}

const VIN  = process.env.TESLA_VIN!
const MODE = process.env.MCP_MODE || 'stdio'
const PORT = parseInt(process.env.MCP_PORT ?? '3001', 10)
const HOST = process.env.MCP_HOST ?? process.env.HOST ?? '0.0.0.0'

const tesla = new TeslaClient(VIN)

// ── Server factory ────────────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: 'tesla-mcp', version: '1.0.0' })

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape ?? {},
      async (input: any) => {
        try {
          const text = await tool.handler(input, tesla)
          return { content: [{ type: 'text' as const, text }] }
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true }
        }
      }
    )
  }

  return server
}

// ── Mode: stdio ───────────────────────────────────────────────────────────────

if (MODE === 'stdio') {
  const server    = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`✅  Tesla MCP running on stdio`)
  console.error(`    VIN: ${VIN}`)
  console.error(`    Tools: ${tools.map(t => t.name).join(', ')}`)
}

// ── Mode: http (SSE) ──────────────────────────────────────────────────────────

if (MODE === 'http') {
  const app = express()
  const transports: Record<string, SSEServerTransport> = {}

  app.get('/sse', async (_req, res) => {
    const server    = createServer()
    const transport = new SSEServerTransport('/messages', res)
    transports[transport.sessionId] = transport
    await server.connect(transport)
    console.log(`[mcp] Client connected: ${transport.sessionId}`)
    _req.on('close', () => {
      delete transports[transport.sessionId]
      console.log(`[mcp] Client disconnected: ${transport.sessionId}`)
    })
  })

  app.post('/messages', express.json(), async (req, res) => {
    const transport = transports[req.query.sessionId as string]
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
    await transport.handlePostMessage(req, res)
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', tools: tools.length, mode: 'http', vin: VIN })
  })

  app.listen(PORT, HOST, () => {
    console.log(`✅  Tesla MCP (http) on http://${HOST}:${PORT}`)
    console.log(`    SSE:    http://localhost:${PORT}/sse`)
    console.log(`    Health: http://localhost:${PORT}/health`)
  })
}
