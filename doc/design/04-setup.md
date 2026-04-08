# Setup

## For Users

### Via AI Agent (Recommended)

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

The agent will read `install-agent.md` from the repository and handle the installation and configuration.

### Manual Installation

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup
```

The `setup` command prompts for:
1. Confluence URL (e.g., `https://yoursite.atlassian.net`)
2. Email address
3. API token (masked input)

It tests the connection and stores credentials in the OS keychain.

Then add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_URL": "https://yoursite.atlassian.net",
        "CONFLUENCE_EMAIL": "user@example.com"
      }
    }
  }
}
```

## Generate an API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a label (e.g., "Epimethian MCP") and click **Create**
4. Copy the token (shown only once)
5. Paste it into the `epimethian-mcp setup` prompt

No admin access required. Any Confluence user can generate their own token.

## How Credentials Are Stored

| Setting | Storage | Location |
|---------|---------|----------|
| Confluence URL | MCP config (`.mcp.json`) | env var, not secret |
| Email | MCP config (`.mcp.json`) | env var, not secret |
| API token | OS keychain | macOS Keychain / Linux libsecret |

The API token never appears in plaintext config files. It is encrypted at rest by the OS credential store.

## For Developers (Building from Source)

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm test
```
