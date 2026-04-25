# Tesla MCP Server — Setup Guide

## Prerequisites
- Node.js 18+ installed
- Your Tesla account credentials (for the OAuth flow)

---

## Step 1 — Install dependencies & build

```bash
cd "C:\Users\satya\OneDrive\Documents\Prabhay AI\tesla-mcp"
npm install
npm run build
```

---

## Step 2 — Get your Tesla access token

```bash
node get-tesla-token.mjs
```

This will:
- Exchange your Client ID/Secret for a **partner token** and test it against the Fleet API
- Print an **auth URL** — open it in your browser to log in with your Tesla account
- After login, Tesla redirects to `https://localhost/callback?code=XXXX` — copy that code

Then run:

```bash
node exchange-code.mjs <PASTE_CODE_HERE>
```

This gives you a **user access token** (can control your car) and lists your vehicles with their VINs. The `.env` file is updated automatically.

---

## Step 3 — Configure Claude Desktop

Open your Claude Desktop config file:

| Platform | Path |
|----------|------|
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **macOS**   | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Merge in the contents of `claude-mcp-config.json`, replacing the placeholder values:

```json
"mcpServers": {
  "tesla": {
    "command": "node",
    "args": ["C:\\Users\\satya\\OneDrive\\Documents\\Prabhay AI\\tesla-mcp\\dist\\index.js"],
    "env": {
      "TESLA_ACCESS_TOKEN": "<token from step 2>",
      "TESLA_VIN":          "<VIN from step 2>",
      "MCP_MODE":           "stdio"
    }
  }
}
```

**Restart Claude Desktop** after saving.

---

## Step 4 — Try it out

Once Claude Desktop restarts, you should see the Tesla tools available. Try asking Claude:

- *"What's the battery level on my Tesla?"*
- *"Lock my car"*
- *"Start climate control"*
- *"Where is my car right now?"*

---

## Troubleshooting

### ngrok access

- If the ngrok URL works locally but not from outside, start with `.\start-tesla.ps1`, then test the printed `https://.../health` URL from mobile data or another network. The launcher forwards with `--host-header=rewrite` and the server binds to `0.0.0.0` by default.
- If ngrok shows a browser warning page, add request header `ngrok-skip-browser-warning` with value `true` in iOS Shortcuts. API callers such as Tesla usually do not need this because they are not normal browsers.
- If Tesla registration stops working after restart, your free ngrok URL likely changed. Use a reserved ngrok domain, set `NGROK_DOMAIN=your-domain.ngrok-free.app` in `.env`, and add `https://your-domain.ngrok-free.app` to Tesla Allowed Origins.

- **403 on token request** — double-check your Client ID/Secret
- **Token works but vehicle commands fail** — make sure you used the user token (from `exchange-code.mjs`), not the partner token
- **`dist/index.js` not found** — run `npm run build` first
- **MCP tools don't appear in Claude** — restart Claude Desktop and check the config path is correct
