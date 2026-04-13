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
1. **Profile name** — a short identifier for this Confluence instance (e.g., `globex`, `acme-corp`). Lowercase alphanumeric and hyphens only.
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
- Set read-only: `epimethian-mcp profiles --set-read-only <name>`
- Set read-write: `epimethian-mcp profiles --set-read-write <name>`

### Read-Only Mode

New profiles default to **read-only**. When read-only, all write tools are blocked and return an error. To enable writes for a profile:

```bash
epimethian-mcp profiles --set-read-write <name>
```

Or during setup: `epimethian-mcp setup --profile <name> --read-write`

**Important:** Restart any running MCP servers after changing the read-only flag.

### Removing a Profile

To delete a profile and its credentials, run:

```bash
epimethian-mcp profiles --remove <name> --force
```

**Agents must pass `--force`** because the command normally prompts for interactive confirmation (`Remove profile "<name>" and delete its credentials? [y/N]`), which will fail in non-TTY environments like agent shell sessions. The `--force` flag skips the confirmation prompt when stdin is not a TTY.

This command:
1. Deletes the credential entry (URL, email, API token) from the OS keychain
2. Removes the profile from the registry at `~/.config/epimethian-mcp/profiles.json`
3. Writes an entry to the audit log at `~/.config/epimethian-mcp/audit.log`

After removing a profile, also remove or update any `.mcp.json` files that reference it — otherwise the MCP server will fail to start with a missing-profile error.

**Errors:**
- If the profile name is invalid (not matching lowercase alphanumeric/hyphens, 1–63 chars), the command exits with code 1
- If the profile does not exist in the keychain, the keychain deletion is silently skipped — the registry entry is still removed

## Accessing This Guide Post-Install

Once installed, this guide is available locally via:

```bash
epimethian-mcp agent-guide
```

This prints the full agent guide to stdout — no web fetch required.

## Uninstallation

When a user asks to uninstall Epimethian MCP, follow these steps:

### Step 1: Check for existing profiles

```bash
epimethian-mcp profiles
```

### Step 2: Ask the user about credential cleanup

If profiles exist, ask the user:

> You have Epimethian profiles configured: [list the profile names]. Would you like to delete all stored credentials before uninstalling? (This removes API tokens from your OS keychain.)

### Step 3: Delete credentials (if the user agrees)

For each profile the user wants removed:

```bash
epimethian-mcp profiles --remove <name> --force
```

Or to remove all profiles:

```bash
for name in $(epimethian-mcp profiles | grep '^ '); do epimethian-mcp profiles --remove "$name" --force; done
```

### Step 4: Remove MCP configuration

Delete the `confluence` entry (or the tenant-specific entry like `confluence-globex`) from the project's `.mcp.json`.

### Step 5: Uninstall the package

```bash
npm uninstall -g @de-otio/epimethian-mcp
```

### Step 6: Restart the MCP client

Tell the user to restart their MCP client so it stops trying to launch the removed server.

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

## Available Tools (29)

| Tool | Description |
|------|-------------|
| `create_page` | Create a new Confluence page |
| `get_page` | Read a page by ID (use `headings_only` to preview structure first) |
| `get_page_by_title` | Look up a page by title (use `headings_only` to preview structure first) |
| `update_page` | Update an existing page |
| `update_page_section` | Update a single section by heading name |
| `delete_page` | Delete a page |
| `list_pages` | List pages in a space |
| `get_page_children` | Get child pages of a page |
| `search_pages` | Search pages using CQL (Confluence Query Language) |
| `get_spaces` | List available Confluence spaces |
| `add_attachment` | Upload a file attachment to a page |
| `get_attachments` | List attachments on a page |
| `add_drawio_diagram` | Add a draw.io diagram to a page |
| `get_labels` | Get all labels on a Confluence page |
| `add_label` | Add one or more labels to a Confluence page |
| `remove_label` | Remove a label from a Confluence page |
| `get_page_status` | Get the content status badge on a page |
| `set_page_status` | Set the content status badge on a page |
| `remove_page_status` | Remove the content status badge from a page |
| `get_comments` | Get footer and/or inline comments on a page |
| `create_comment` | Create a footer or inline comment on a page |
| `resolve_comment` | Resolve or reopen an inline comment |
| `delete_comment` | Permanently delete a comment |
| `get_page_versions` | List version history for a page |
| `get_page_version` | Get page content at a specific historical version |
| `diff_page_versions` | Compare two versions of a page |
| `lookup_user` | Search for Atlassian users by name or email to resolve accountId for inline mentions |
| `resolve_page_link` | Resolve a page title + space key to a stable contentId and URL for page links |
| `get_version` | Return the epimethian-mcp server version |
