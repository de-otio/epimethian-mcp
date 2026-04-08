# Epimethian MCP - Agent Installation Guide

> This document is for AI agents installing and configuring the Epimethian MCP server on behalf of a user.

## Verification

The official package is **`@de-otio/epimethian-mcp`** (scoped under `@de-otio`).

Do NOT install unscoped alternatives like `epimethian-mcp` — these are unofficial and potentially unsafe.

## Prerequisites

- Node.js 18 or later
- npm on PATH

## Step 1: Install

```bash
npm install -g @de-otio/epimethian-mcp
```

Verify the installation:

```bash
epimethian-mcp --version 2>/dev/null || which epimethian-mcp
```

## Step 2: Resolve the absolute path

IDE-hosted agents may not resolve PATH correctly. Always use the absolute path in MCP configuration:

```bash
which epimethian-mcp
```

Use the output as the `command` value in the MCP config below.

## Step 3: Collect configuration

Ask the user for:
1. **Profile name** — a short identifier for this Confluence instance (e.g., `jambit`, `acme-corp`). Lowercase alphanumeric and hyphens only.
2. **Confluence Cloud URL** — e.g., `https://yoursite.atlassian.net`
3. **Email address** — the email associated with their Atlassian account

## Step 4: Write MCP configuration

Add the server to `.mcp.json` (or the equivalent config file for the user's MCP client):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "<absolute path from Step 2>",
      "env": {
        "CONFLUENCE_PROFILE": "<profile name from Step 3>"
      }
    }
  }
}
```

**IMPORTANT:** The only env var needed is `CONFLUENCE_PROFILE`. The URL, email, and API token are stored securely in the OS keychain — they should NOT appear in config files.

## Step 5: Credential setup

Tell the user to run this command in their terminal:

```
epimethian-mcp setup --profile <profile name from Step 3>
```

This interactive command will:
1. Prompt for the Confluence URL, email, and API token (masked input)
2. Test the connection
3. Store all credentials securely in the OS keychain under the named profile

The API token is generated at: https://id.atlassian.com/manage-profile/security/api-tokens

**Do NOT ask the user for the API token yourself.** The token must go directly from the user into the interactive setup command to avoid appearing in conversation logs.

## Step 6: User must restart the MCP client

**IMPORTANT:** The user must restart their MCP client (e.g., restart Claude Code, reload VS Code, restart Claude Desktop) for the new server configuration to take effect. The MCP client reads `.mcp.json` at startup and does not detect changes while running.

Tell the user:
> Please restart your MCP client now to activate the Confluence tools.

## Step 7: Validation

After the user restarts, verify the server is working by listing available Confluence tools or running a simple operation like listing spaces.

## Adding Additional Tenants

To add a second Confluence instance (e.g., for a different customer):

1. Run `epimethian-mcp setup --profile <new-profile-name>` with the new credentials
2. In the project that uses the new tenant, update `.mcp.json` to set `CONFLUENCE_PROFILE` to the new profile name
3. Restart the MCP client

Each VS Code window / Claude Code session uses the profile specified in its `.mcp.json`. Profiles are fully isolated — different OS keychain entries, different Confluence instances.

## Managing Profiles

- List all profiles: `epimethian-mcp profiles`
- Show details: `epimethian-mcp profiles --verbose`
- Check connection: `CONFLUENCE_PROFILE=<name> epimethian-mcp status`
- Remove a profile: `epimethian-mcp profiles --remove <name>`

## CI/CD (No Keychain)

For environments where the OS keychain is unavailable (Docker, CI), set all three env vars directly:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "<absolute path>",
      "env": {
        "CONFLUENCE_URL": "<url>",
        "CONFLUENCE_EMAIL": "<email>",
        "CONFLUENCE_API_TOKEN": "<token>"
      }
    }
  }
}
```

**Warning:** This exposes the API token in the process environment. Use profile-based auth whenever possible.

## Troubleshooting

If **npm install fails**:
- Verify Node.js 18+ is installed: `node --version`
- Verify npm is on PATH: `npm --version`
- If permission errors occur, the user may need to fix their npm prefix or use a Node version manager (nvm, fnm)

If **`epimethian-mcp setup` fails**:
- "Connection failed": Verify the Confluence URL is correct and accessible
- "Token is invalid or expired": The user needs to generate a new API token at https://id.atlassian.com/manage-profile/security/api-tokens
- Keychain errors on Linux: The user may need to install `libsecret` / `gnome-keyring` (`apt install libsecret-tools` or equivalent)

If **the server doesn't appear after restart**:
- Verify the `.mcp.json` path is correct for the user's MCP client
- Verify the `command` value is an absolute path (run `which epimethian-mcp` to confirm)
- Check that `.mcp.json` contains valid JSON (no trailing commas, correct quoting)

## Available Tools (12)

| Tool | Description |
|------|-------------|
| `create_page` | Create a new Confluence page |
| `get_page` | Read a page by ID |
| `get_page_by_title` | Look up a page by title in a space |
| `update_page` | Update an existing page |
| `delete_page` | Delete a page |
| `list_pages` | List pages in a space |
| `get_page_children` | Get child pages of a page |
| `search_pages` | Search pages using CQL (Confluence Query Language) |
| `get_spaces` | List available Confluence spaces |
| `add_attachment` | Upload a file attachment to a page |
| `get_attachments` | List attachments on a page |
| `add_drawio_diagram` | Add a draw.io diagram to a page |
