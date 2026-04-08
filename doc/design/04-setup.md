# Setup

## For Users

### Via AI Agent (Recommended)

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

The agent will read `install-agent.md` from the repository and handle the installation and configuration.

### Manual Installation

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup --profile <name>
```

The `setup --profile` command prompts for:
1. Confluence URL (e.g., `https://yoursite.atlassian.net`)
2. Email address
3. API token (masked input)

It tests the connection and stores all three credentials in the OS keychain under the named profile.

Then add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "<profile-name>"
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
5. Paste it into the `epimethian-mcp setup --profile <name>` prompt

No admin access required. Any Confluence user can generate their own token.

## How Credentials Are Stored

| Setting | Storage | Location |
|---------|---------|----------|
| Profile name | MCP config (`.mcp.json`) | `CONFLUENCE_PROFILE` env var, not secret |
| Confluence URL | OS keychain | Stored per-profile, never in config files |
| Email | OS keychain | Stored per-profile, never in config files |
| API token | OS keychain | Stored per-profile, never in config files |

All credentials are stored as an atomic unit per profile. The API token never appears in plaintext config files. Credentials are encrypted at rest by the OS credential store.

For CI/CD environments without a keychain, all three env vars (`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`) can be set directly. Partial combinations are rejected.

## For Developers (Building from Source)

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm test
```
