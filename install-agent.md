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

## Step 3: Collect non-secret configuration

Ask the user for:
1. **Confluence Cloud URL** — e.g., `https://yoursite.atlassian.net`
2. **Email address** — the email associated with their Atlassian account

These are NOT secrets and can be stored in configuration files.

## Step 4: Write MCP configuration

Add the server to `.mcp.json` (or the equivalent config file for the user's MCP client):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "<absolute path from Step 2>",
      "env": {
        "CONFLUENCE_URL": "<url from Step 3>",
        "CONFLUENCE_EMAIL": "<email from Step 3>"
      }
    }
  }
}
```

**IMPORTANT: Do NOT put the API token in the config file.** The server reads it from the OS keychain at startup.

## Step 5: Credential setup

Tell the user to run this command in their terminal:

```
epimethian-mcp setup
```

This interactive command will:
1. Prompt for the Confluence API token (masked input)
2. Test the connection
3. Store the token securely in the OS keychain (macOS Keychain / Linux libsecret)

The API token is generated at: https://id.atlassian.com/manage-profile/security/api-tokens

**Do NOT ask the user for the API token yourself.** The token must go directly from the user into the interactive setup command to avoid appearing in conversation logs.

## Step 6: Validation

After the user completes setup and restarts the MCP client, verify by listing available Confluence tools or running a simple operation like listing spaces.

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
