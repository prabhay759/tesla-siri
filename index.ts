import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express from 'express'
import { TeslaClient } from './utils/tesla-client.js'
import { tools } from './tools/index.js'

const TESLA_TOKEN = process.env.TESLA_ACCESS_TOKEN!
const TESLA_VIN = process.env.TESLA_VIN!
const MODE = process.env.MCP_MODE || 'stdio'   // 'stdio' or 'http'
const PORT = process.env.MCP_PORT || 3001

if (!TESLA_TOKEN || !TESLA_VIN) {
  console.error('Missing TESLA_ACCESS_TOKEN or TESLA_VIN')
  process.exit(1)
}

const tesla = new TeslaClient(TESLA_TOKEN, TESLA_VIN)

// ─── Register Tools (shared between both modes) ───────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'tesla-mcp', version: '1.0.0' })

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape ?? {},
      async (input: any) => {
        try {
          const result = await tool.handler(input, tesla)
          return { content: [{ type: 'text', text: result }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
        }
      }
    )
  }
  return server
}

// ─── Mode: stdio (Claude Desktop) ────────────────────────────────────────────

if (MODE === 'stdio') {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('✅ Tesla MCP running on stdio (Claude Desktop mode)')
  console.error(`Tools: ${tools.map(t => t.name).join(', ')}`)
}

// ─── Mode: http (Siri server / ngrok) ────────────────────────────────────────

if (MODE === 'http') {
  const app = express()

  // Each SSE connection gets its own MCP server instance
  const transports: Record<string, SSEServerTransport> = {}

  // SSE endpoint — Claude connects here
  app.get('/sse', async (req, res) => {
    const server = createServer()
    const transport = new SSEServerTransport('/messages', res)
    transports[transport.sessionId] = transport
    await server.connect(transport)
    console.log(`Client connected: ${transport.sessionId}`)

    req.on('close', () => {
      delete transports[transport.sessionId]
      console.log(`Client disconnected: ${transport.sessionId}`)
    })
  })

  // Messages endpoint — Claude sends tool calls here
  app.post('/messages', express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string
    const transport = transports[sessionId]
    if (!transport) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    await transport.handlePostMessage(req, res)
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', tools: tools.length, mode: 'http' })
  })

  app.listen(PORT, () => {
    console.log(`✅ Tesla MCP running on http://localhost:${PORT}`)
    console.log(`   SSE endpoint: http://localhost:${PORT}/sse`)
    console.log(`   Health:       http://localhost:${PORT}/health`)
  })
}
