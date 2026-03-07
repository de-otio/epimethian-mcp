# Architecture

```
  ┌───────────────────────────────────────────────────────────┐
  │  VS Code                                                  │
  │                                                           │
  │  ┌─────────────────┐         ┌──────────────────────┐    │
  │  │  Extension Host  │         │  Webview Panel       │    │
  │  │                  │ <────> │  (Configuration UI)  │    │
  │  │  - Activates     │  msg    │  - URL / email       │    │
  │  │  - Reads secrets │  pass   │  - API token         │    │
  │  │  - Registers MCP │         │  - Test connection   │    │
  │  │  - Spawns server │         │  - Status display    │    │
  │  └───────┬──────────┘         └──────────────────────┘    │
  │          │                                                 │
  │          │ stdio (JSON-RPC)                                │
  │          ▼                                                 │
  │  ┌──────────────────┐                                     │
  │  │  MCP Server       │                                     │
  │  │  (bundled child   │                                     │
  │  │   process)        │                                     │
  │  └───────┬──────────┘                                     │
  │          │                                                 │
  └──────────│─────────────────────────────────────────────────┘
             │ HTTPS
             │ Basic Auth
             ▼
     ┌────────────────┐
     │  Confluence    │
     │  Cloud API     │
     │  (v2 REST)     │
     └────────────────┘
```

## How It Works

1. User builds and installs the extension locally (`.vsix`)
2. On first activation, the extension opens the configuration webview
3. User enters Confluence URL, email, and API token in the webview
4. The extension stores URL and email in VS Code settings; the API token goes to SecretStorage (OS keychain)
5. The extension registers an MCP server that spawns the bundled server as a child process, passing credentials via environment variables
6. AI features in VS Code (Copilot Chat, etc.) discover the MCP server and can call Confluence tools
7. All Confluence API calls use Basic Auth with the user's personal token

## Project Structure

```
epimethian-mcp/
├── package.json                  # Extension manifest + MCP server deps
├── tsconfig.json
├── esbuild.config.mjs            # Bundles extension + server separately
├── src/
│   ├── extension/
│   │   ├── extension.ts          # activate / deactivate entry point
│   │   ├── config.ts             # SecretStorage + settings helpers
│   │   ├── webview.ts            # Webview panel provider
│   │   └── mcp-clients.ts       # Multi-client MCP config registration
│   ├── server/
│   │   ├── index.ts              # MCP server setup + tool registrations
│   │   └── confluence-client.ts  # HTTP helpers, Zod response schemas, formatting
│   └── shared/
│       └── types.ts              # Message types shared between extension & webview
├── doc/
│   └── design/
├── prompts/
└── .vscodeignore
```

The extension and server are bundled into two separate files (`dist/extension.js` and `dist/server.js`) by esbuild. The server bundle is self-contained and launched as a child process.
