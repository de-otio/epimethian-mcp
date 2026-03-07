# VS Code Extension

## Extension Manifest (`package.json`)

Key `contributes` fields:

```jsonc
{
  "contributes": {
    "commands": [
      {
        "command": "epimethian-mcp.configure",
        "title": "Epimethian MCP: Configure"
      },
      {
        "command": "epimethian-mcp.testConnection",
        "title": "Epimethian MCP: Test Connection"
      }
    ],
    "mcpServers": {
      "confluence": {
        "command": "node",
        "args": ["${extensionPath}/dist/server.js"],
        "env": {}
      }
    }
  },
  "activationEvents": [
    "onStartupFinished"
  ]
}
```

The `mcpServers` contribution registers the bundled MCP server with VS Code. The extension injects credentials into the server's environment at launch time by reading them from settings and SecretStorage.

## Extension Host

### Activation (`extension.ts`)

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // Register the configuration webview command
  context.subscriptions.push(
    vscode.commands.registerCommand('epimethian-mcp.configure', () => {
      ConfigPanel.createOrShow(context);
    })
  );

  // Register MCP server environment provider
  // Injects credentials from SecretStorage + settings into the server process
  context.subscriptions.push(
    vscode.lm.registerMCPServerEnvironmentProvider('confluence', {
      async resolveEnvironment(env) {
        const config = vscode.workspace.getConfiguration('epimethian-mcp');
        const token = await context.secrets.get('epimethian-mcp.apiToken');
        return {
          ...env,
          CONFLUENCE_URL: config.get<string>('url') ?? '',
          CONFLUENCE_EMAIL: config.get<string>('email') ?? '',
          CONFLUENCE_API_TOKEN: token ?? '',
        };
      }
    })
  );
}
```

### Configuration Helpers (`config.ts`)

```typescript
export async function saveCredentials(
  context: vscode.ExtensionContext,
  url: string,
  email: string,
  apiToken: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('epimethian-mcp');
  await config.update('url', url, vscode.ConfigurationTarget.Global);
  await config.update('email', email, vscode.ConfigurationTarget.Global);
  await context.secrets.store('epimethian-mcp.apiToken', apiToken);
}

export async function testConnection(
  url: string,
  email: string,
  apiToken: string
): Promise<{ ok: boolean; message: string }> {
  // Makes a lightweight GET /wiki/api/v2/spaces?limit=1 call
  // Returns success with user display name, or error details
}
```

## Webview

### Layout

The configuration webview is a single panel with:

1. **Confluence URL** -- text input, placeholder: `https://yourcompany.atlassian.net`
2. **Email** -- text input, placeholder: `you@company.com`
3. **API Token** -- password input (masked), with a link to the Atlassian token generation page
4. **Test Connection** button -- calls the Confluence API to verify credentials
5. **Save** button -- stores credentials via the extension host
6. **Status area** -- shows connection test results:
   - Last verified: timestamp of the most recent successful test
   - Status: "Connected as [display name]" or error message
7. **AI Clients** section -- lists supported AI tools with Register/Remove buttons for each

### Multi-Client MCP Registration

The extension can register the Epimethian MCP server with multiple AI clients, not just VS Code. Each client stores its MCP config in a different file:

| Client | Config Path |
|--------|------------|
| Claude Code | `~/.claude/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| ChatGPT | `~/.chatgpt/mcp.json` |
| Continue | `~/.continue/mcp.json` |
| Kilo Code | `~/.kilo/mcp.json` |

Registration **merges** into the existing config file — it never overwrites. Only the `mcpServers.confluence` entry is added or updated; all other servers and top-level keys are preserved. Unregistration removes only the `confluence` entry.

This logic lives in `src/extension/mcp-clients.ts`.

### Message Protocol

The webview and extension host communicate via `postMessage`:

```typescript
// Webview -> Extension
type WebviewMessage =
  | { type: 'save'; url: string; email: string; apiToken: string }
  | { type: 'testConnection'; url: string; email: string; apiToken: string }
  | { type: 'requestConfig' }
  | { type: 'registerClient'; clientId: string }
  | { type: 'unregisterClient'; clientId: string };

// Extension -> Webview
type ExtensionMessage =
  | { type: 'configLoaded'; url: string; email: string; hasToken: boolean; clients: ClientStatus[] }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'saved' }
  | { type: 'clientUpdated'; clients: ClientStatus[] };

interface ClientStatus {
  id: string;
  name: string;
  pathDescription: string;
  registered: boolean;
}
```

### API Token Expiry

Atlassian API tokens are opaque strings -- there is no API to query their expiration date. Tokens last until revoked (or until an org admin's expiration policy takes effect). The webview handles this by:

- Displaying a **"Test Connection"** button that verifies the token works right now
- Showing **"Last verified: [timestamp]"** after a successful test (persisted in global state)
- If the test fails with 401, displaying **"Token is invalid or expired. Generate a new one."** with a link to the Atlassian token page

This gives the user confidence their token is working without relying on expiry metadata that doesn't exist.

## Bundling

esbuild produces two bundles:

| Bundle | Entry | Output | Target |
|--------|-------|--------|--------|
| Extension | `src/extension/extension.ts` | `dist/extension.js` | `node` (VS Code extension host) |
| Server | `src/server/index.ts` | `dist/server.js` | `node` (child process) |

Both are CommonJS bundles with external `vscode` module (extension only). The server bundle has no dependency on the `vscode` module -- it is a standalone Node.js process.

```javascript
// esbuild.config.mjs
import { build } from 'esbuild';

const shared = { bundle: true, platform: 'node', format: 'cjs', sourcemap: true };

await Promise.all([
  build({ ...shared, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  build({ ...shared, entryPoints: ['src/server/index.ts'], outfile: 'dist/server.js' }),
]);
```

## Security Considerations

- The API token is stored in SecretStorage, backed by the OS keychain. It is never written to `settings.json`, `.env`, or any file on disk.
- The token is passed to the server process via environment variables at spawn time. Environment variables are process-scoped and not visible to other users on the system.
- The webview uses a Content Security Policy that restricts scripts to the extension's own resources.
- The webview password input masks the token by default.
