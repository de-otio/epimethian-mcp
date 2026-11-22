# Installing and Configuring the Epimethian MCP Server

The Epimethian MCP server runs locally on your machine and connects your AI coding assistant (Claude Code, Claude Desktop, Cursor, etc.) to Confluence Cloud. All changes you make through the AI are attributed to your Confluence user.

## Prerequisites

- Node.js 18 or later

## Option A: Agent-Assisted Install (Recommended)

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

The agent will handle the installation and configuration for you.

## Option B: Manual Install

### Step 1: Install

```bash
npm install -g @de-otio/epimethian-mcp
```

### Step 2: Set Up Credentials

Run the interactive setup command with a profile name:

```bash
epimethian-mcp setup --profile <name>
```

Choose a short, descriptive profile name (e.g., `globex`, `acme-corp`). If you only work with one Confluence instance, any name works (e.g., `main`).

This will prompt for:
1. Your Confluence URL (e.g., `https://yourcompany.atlassian.net`)
2. Your email address
3. Whether the token is a scoped API token (answer `N` for an ordinary token; see [Gateway mode](#gateway-mode-scoped-api-tokens))
4. Your API token (masked input)

It tests the connection and stores all credentials securely in your OS keychain under the named profile.

To generate an API token:
1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g., "Epimethian MCP") and click **Create**
4. Copy the token -- it is only shown once

No admin access is required. Any Confluence user can generate their own token.

### Step 3: Configure Your AI Client

Find the absolute path of the command you just installed:

```bash
which epimethian-mcp
```

Add it to your MCP client configuration (`.mcp.json` or equivalent) as the `command`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "/opt/homebrew/bin/epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "<profile name from Step 2>"
      }
    }
  }
}
```

Use the absolute path rather than a bare `epimethian-mcp`. Your MCP client and your terminal may see different PATHs: on macOS an IDE started from the Dock does not get your login shell's PATH. With a bare name, the client can start a different installed copy from the one your terminal runs and upgrades. `epimethian-mcp setup` already writes the absolute path into the configs it generates.

**Important:** Only `CONFLUENCE_PROFILE` goes in the config file. URL, email, and API token are read from the OS keychain at startup.

### Client-Specific Config Locations

| Client | Config File |
|--------|------------|
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (global) | `~/.claude/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |

## Multi-Tenant Setup

If you work with multiple Confluence instances (e.g., as a consultant), create a profile for each:

```bash
epimethian-mcp setup --profile globex
epimethian-mcp setup --profile acme-corp
```

Each project's `.mcp.json` specifies which profile to use. Profiles are fully isolated — different keychain entries, different Confluence instances.

## Gateway Mode (Scoped API Tokens)

Atlassian can issue **scoped API tokens**: tokens limited to named permissions (scopes) on one site. A scoped token does not work against your site URL. It works only through the Atlassian API gateway, `https://api.atlassian.com/ex/confluence/{cloudId}`, and only against the Confluence v2 REST API. Epimethian supports this as an optional **gateway mode**. Ordinary (unscoped) tokens and every existing profile keep working exactly as before.

### Why use it

A scoped token can only do what its scopes allow, so a read-only token cannot write even if the agent or the profile is misconfigured. It also expires on a date you choose.

### Set up a gateway profile

1. Create the token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) with **Create API token with scopes**, pick **Confluence**, and select the scopes below.
2. Run `epimethian-mcp setup --profile <name>` and answer `y` to "Is this a scoped API token?". Gateway mode needs a named profile.
3. Setup shows the tenant behind the URL (name and cloud ID) and asks you to confirm it **before** any credential is used. It then tests the token through the gateway, asks for the token's expiry date (optional, `YYYY-MM-DD`, as shown when you created the token), asks for the access mode, and prints the scope list.
4. For a read-only profile, setup also checks that the token **cannot** write (a harmless write attempt against a page that does not exist must be refused with 403). If it is not refused, setup warns that the token is broader than the read-only mode.

The mode, the tenant's cloud ID and the expiry are stored together in the OS keychain record. Gateway mode is only ever stored together with the cloud ID: it cannot be switched on for a profile without a tenant seal.

### Scopes

These scopes are **to be confirmed by the live probe**. The list is the starting point and will be corrected against a live scoped token before it is final.

Read-only mode:

| Scope |
|-------|
| `read:page:confluence` |
| `read:blogpost:confluence` |
| `read:space:confluence` |
| `read:attachment:confluence` |
| `read:label:confluence` |
| `read:comment:confluence` |
| `read:hierarchical-content:confluence` |
| `read:folder:confluence` |
| `read:task:confluence` |
| `read:content.property:confluence` |
| `read:user:confluence` |
| `read:space.permission:confluence` |

Read-write mode adds:

| Scope |
|-------|
| `write:page:confluence` |
| `write:blogpost:confluence` |
| `delete:page:confluence` |
| `write:comment:confluence` |
| `delete:comment:confluence` |
| `delete:attachment:confluence` |

### What is not available in gateway mode

The gateway serves only the v2 API. Tools that need the v1 API are **not registered**: the agent does not see them, and the server's instructions name them. Nothing half-works. For example, `add_drawio_diagram` uploads over v1 and then edits the page, so it is absent altogether rather than leaving an uploaded file behind.

| Tool or behaviour | Site mode | Gateway mode |
|-------------------|-----------|--------------|
| Read, create, update, delete pages and blog posts; children; comments; spaces | yes | yes |
| `get_page_by_title`, `list_pages`, `get_page_children` | yes | yes |
| `get_page_versions`, `get_page_version`, `diff_page_versions`, `revert_page` | yes | yes |
| `get_attachments`, `get_labels` | yes | yes |
| `add_attachment`, `add_drawio_diagram`, `update_drawio_diagram` | yes | **not available** |
| `download_attachment` | yes | **not available** (until a gateway download path is confirmed) |
| `add_label`, `remove_label` | yes | **not available** |
| `get_page_status`, `set_page_status`, `remove_page_status` | yes | **not available** |
| `search_pages`, `resolve_page_link`, `get_recent_changes` (CQL search) | yes | **not available** |
| `lookup_user` | yes | **not available** |
| `epimethian-edited` attribution label on written pages | yes | skipped, silently |
| "AI-edited" status badge on written pages | yes | skipped, silently |
| Version comment naming Epimethian and its version | yes | yes |

Because the label and the badge are skipped without a warning, pages written in gateway mode carry the Epimethian note in their version comment only. Tools that read labels, attachments and versions rely on the v2 API in this release; where the live probe finds a gap, the table above changes.

### How the tenant is protected

A request or credential reaching the wrong Atlassian site is the failure that matters most when you work across several tenants, so gateway mode is pinned several ways:

- The gateway address is built **only** from the cloud ID sealed at setup, never from a URL you type or a value a response contains.
- At every start, the server asks the site URL for its cloud ID (without sending any credential) and refuses to start if it differs from the sealed one or cannot be read.
- It then confirms the token works through the gateway (`GET /spaces?limit=1`). The v1 identity check by email cannot run on the gateway, so the sealed cloud ID, the pinned gateway address and a token scoped to one site take its place.
- The credential is sent only to `https://api.atlassian.com/ex/confluence/{sealed cloudId}/`. Pagination links and download redirects that point anywhere else are refused or followed without the credential.

### Token expiry

Atlassian does not expose a token's expiry through its API, so Epimethian stores the date you enter at setup. `epimethian-mcp status` shows the days left, the server prints a warning on its stderr banner when 14 days or fewer remain, and an expired date stops the server at start with a message naming the date and the setup command. Create a new token and run setup again to renew it.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CONFLUENCE_PROFILE` | **Recommended.** Name of the credential profile in the OS keychain. |
| `CONFLUENCE_URL` | Atlassian instance URL (CI/CD only — requires all three env vars) |
| `CONFLUENCE_EMAIL` | Atlassian account email (CI/CD only) |
| `CONFLUENCE_API_TOKEN` | API token (CI/CD only — use OS keychain for interactive use) |

For CI/headless environments where the OS keychain is not available, set all three `CONFLUENCE_*` env vars. Partial combinations are rejected.

## Verifying the Setup

After configuring, restart your AI client and ask:

> "List my Confluence spaces"

If configured correctly, your AI assistant will use the `get_spaces` tool and return your Confluence spaces.

You can also test from the terminal:

```bash
CONFLUENCE_PROFILE=<name> epimethian-mcp status
```

## Troubleshooting

**Server fails to start**
- Run `epimethian-mcp status` (with `CONFLUENCE_PROFILE` set) to verify credentials.
- Ensure `CONFLUENCE_PROFILE` is set in your `.mcp.json`.

**Authentication errors (401)**
- Run `epimethian-mcp setup --profile <name>` to re-enter your API token.
- Verify your token has not been revoked at id.atlassian.com.

**Forbidden errors (403)**
- Your account may not have permission to access the requested space or page.

**Pages or spaces not found (404)**
- Double-check the space key, page ID, or page title.
- Use the `get_spaces` tool to discover valid space keys.

**Upgraded, but `get_version` still shows the old version**
- You probably have two installed copies, for example one under Homebrew's npm and one under nvm's. An upgrade (the `upgrade` tool, `epimethian-mcp upgrade`, or `npm install -g`) replaces only one copy, and your MCP client keeps starting the other.
- Run `epimethian-mcp status` to list every installed copy. `get_version` lists them too, and the server prints them to stderr at startup.
- Keep the copy your MCP config's `command` starts, and remove the other with the command the listing prints:

  ```bash
  npm uninstall -g --prefix <prefix> @de-otio/epimethian-mcp
  ```

  `--prefix` makes the command remove that copy whichever `npm` runs it.
- Then set `command` to the absolute path of the copy you kept (see Step 3) and restart your MCP client.
