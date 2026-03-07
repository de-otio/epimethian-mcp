# Setup

## For Users (Local Extension Install)

1. Download the `.vsix` from the latest CI build (see [08-ci.md](08-ci.md)) or build from source (see "For Developers" below)
2. Install it: `code --install-extension epimethian-mcp-*.vsix`
3. Open VS Code
3. Open the configuration panel: Command Palette > **Confluence MCP: Configure**
4. Enter your Confluence URL, email, and API token
5. Click **Test Connection** to verify
6. Done -- the MCP server is now available to AI tools in VS Code

## Generate an API Token

1. Go to id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a label (e.g., "VS Code MCP") and click **Create**
4. Copy the token (shown only once)
5. Paste it into the extension's configuration webview

No admin access required. Any Confluence user can generate their own token.

## How Credentials Are Stored

| Setting | Storage | Location |
|---------|---------|----------|
| Confluence URL | VS Code settings | `settings.json` (not secret) |
| Email | VS Code settings | `settings.json` (not secret) |
| API token | VS Code SecretStorage | OS keychain (macOS Keychain, libsecret, Windows Credential Vault) |

The API token never appears in plaintext config files. It is encrypted at rest by the OS credential store.

## For Developers (Building from Source)

```bash
git clone https://github.com/rmyers/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build          # esbuild bundles extension + server
npm run package        # produces .vsix file
code --install-extension epimethian-mcp-*.vsix
```
