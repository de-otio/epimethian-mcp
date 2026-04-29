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

Add the server to the user's MCP client config. The exact file and shape depend on the client:

**Claude Code, Claude Desktop, Cursor, Windsurf, Zed** — `.mcp.json` (or the
equivalent client-specific config). The standard `mcpServers` shape:

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

**OpenCode** — `opencode.json` at the project root or
`~/.config/opencode/opencode.json`. Different shape (`mcp` block, `type:
"local"`, `command` is an array, `environment` not `env`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence": {
      "type": "local",
      "command": ["<absolute path from Step 2>"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_PROFILE": "<profile name from Step 3>",
        "EPIMETHIAN_ALLOW_UNGATED_WRITES": "true"
      }
    }
  }
}
```

OpenCode does not support MCP elicitation (the in-protocol confirmation
prompts), so write tools that fire the elicitation gate fail unless
`EPIMETHIAN_ALLOW_UNGATED_WRITES=true` is set. See "MCP client
compatibility" below for the trade-off.

**IMPORTANT:** The only required env var is `CONFLUENCE_PROFILE`. The URL,
email, and API token are stored securely in the OS keychain — they should
NOT appear in config files.

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

## Write budget (safety cap on writes)

epimethian-mcp enforces two write-rate caps per server process:

- **Session cap** (default 250): total writes since the server started.
- **Rolling cap** (default 75 per 15-minute window): catches bursts.

These are local safety nets, not Confluence limits. They exist because an
autonomous agent in a retry loop or with a bad plan can issue hundreds of writes
very quickly, and most users would rather have a brief pause to confirm than
discover the result an hour later.

### What to do when you (the agent) hit `WRITE_BUDGET_EXCEEDED`

1. **Stop and check.** Was the in-progress work user-requested and going as
   planned? If unsure, ask the user before continuing.
2. **Explain to the user, in your own words:**
   - The safety budget has been hit (which scope, current vs. limit).
   - What the budget is for: a guard against runaway agents.
   - Whether the work-in-progress is legitimate (your judgement).
   - The two ways forward: wait for the rolling window to reopen, or raise the cap.
3. **If the user wants to raise the cap**, give them this snippet to add to the
   `env` block of the epimethian-mcp entry in their MCP config (`.mcp.json` or
   equivalent — see Step 4 above for the layout):

   ```json
   "EPIMETHIAN_WRITE_BUDGET_ROLLING": "200",
   "EPIMETHIAN_WRITE_BUDGET_SESSION": "1000"
   ```

   Set either value to `"0"` to disable that scope. **Confirm with the user
   before recommending a raise** — the budget exists precisely to create a
   pause-and-check moment. The user must restart the MCP server (re-open the
   MCP client) for changes to take effect.
4. **If the user gets a deprecation warning** about `EPIMETHIAN_WRITE_BUDGET_HOURLY`,
   tell them to rename it to `EPIMETHIAN_WRITE_BUDGET_ROLLING` in the same
   config file. The old name still works but will be removed in version 7.

### Operator-side defaults

- **`EPIMETHIAN_WRITE_BUDGET_SESSION`** — default 250; set to "0" to disable.
- **`EPIMETHIAN_WRITE_BUDGET_ROLLING`** — default 75 per 15-minute window; set to "0" to disable.
- **`EPIMETHIAN_WRITE_BUDGET_HOURLY`** — deprecated alias for `EPIMETHIAN_WRITE_BUDGET_ROLLING`; will be removed in version 7.

## MCP client compatibility

epimethian-mcp uses MCP **elicitation** (the in-protocol confirmation
prompt added to MCP in 2025) as the human-in-the-loop gate for destructive
operations. Different MCP clients support elicitation differently — some
fully, some not at all, and some advertise the capability without honouring
it. The compatibility matrix below tells you which env-var workaround to
recommend, if any.

| Client | Elicitation? | What to do |
|---|---|---|
| **Claude Code (CLI)** | Yes — full support | No special config needed. |
| **Claude Desktop** | Yes — full support | No special config needed. |
| **Claude Code VS Code extension ≤ 2.1.123** | Fakes it | Set `EPIMETHIAN_BYPASS_ELICITATION=true` (see below). |
| **Claude Code VS Code extension ≥ 2.1.124** | Likely fixed (verify) | If write tools fail with `NO_USER_RESPONSE`, fall back to `EPIMETHIAN_BYPASS_ELICITATION=true`. |
| **OpenCode** | No — capability not advertised | Set `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` or use only read tools / additive writes that don't trigger the gate. No tracking issue at sst/opencode yet (as of v6.4.1); a feature request would be needed for real elicitation support. |
| **Cursor / Windsurf / Zed / others** | Varies | If write tools fail with `ELICITATION_REQUIRED_BUT_UNAVAILABLE`, the client doesn't advertise the capability — use `EPIMETHIAN_ALLOW_UNGATED_WRITES=true`. If write tools fail with `NO_USER_RESPONSE` despite the client claiming support, the client fakes it — use `EPIMETHIAN_BYPASS_ELICITATION=true`. |

### Difference between the two bypass env vars

These are **not** interchangeable. Pick the one that matches the failure mode:

- **`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`** — for clients that *don't
  advertise* elicitation during the MCP handshake. The server detects the
  absence and (with this flag) lets writes proceed. OpenCode falls in this
  category.
- **`EPIMETHIAN_BYPASS_ELICITATION=true`** — for clients that *advertise*
  elicitation but never actually honour the request (the SDK transport
  silently returns `{action: "decline"}`). The Claude Code VS Code
  extension ≤ 2.1.123 falls in this category. This flag is unconditional —
  it bypasses elicitation even when the client claims to support it.

### Trade-off: what you give up by setting either flag

Both flags **disable the in-protocol confirmation gate**. Writes still go
through the harness's tool allow-list (so users can still block the tool
in their permission settings) and through every server-side guard
(provenance, source-policy, write-budget, byte-equivalence) — but the user
no longer gets a UI prompt before each destructive operation. Recommend
this only when:

1. The user is aware of and accepts the trade-off, AND
2. The user's MCP client provides some other interaction model where they
   can intervene (e.g. they review tool calls before approval), OR
3. The work is read-mostly and only occasional, additive writes happen.

**Do NOT set either flag silently.** If you (the agent) need to recommend
one, explain to the user what the gate is for, why their client can't
honour it, and what alternative protections remain.

## Other operator-side environment variables

These are off by default and only relevant in specific scenarios:

- **`EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS`** — opt-in (default OFF).
  When set to `true`, suppresses the `confirm_deletions` gate for token
  deletion+creation pairs that canonicalise to byte-equivalent XML
  (e.g. re-rendering the same `<ac:link>` macros with different attribute
  order, or regenerating an `<ac:structured-macro>` whose parameters and
  CDATA body are identical after sort). Genuine semantic deletions still
  fire the gate. Every suppressed pair is recorded in the mutation log
  for postmortem. Useful for spaces with lots of cross-link rewrites
  where the gate fires repeatedly on no-op churn.
- **`EPIMETHIAN_REQUIRE_SOURCE`** — opt-in (default OFF). When `true`,
  every write tool call must include a `source` parameter (one of
  `user_request` / `file_or_cli_input` / `chained_tool_output` /
  `elicitation_response`). Calls without an explicit source are rejected
  with `SOURCE_POLICY_BLOCKED`. Useful in audit-heavy environments where
  every write must declare provenance.
- **`EPIMETHIAN_AUTO_UPGRADE`** — opt-in (default OFF). When `true`, the
  server checks for and applies updates on startup. Useful for managed
  fleets; usually you want explicit `epimethian-mcp upgrade` runs instead.
- **`CONFLUENCE_READ_ONLY`** — opt-in (default OFF). When `true`, all
  write tools are disabled regardless of MCP client config. Useful for
  read-only profiles or sandbox environments.

## Available Tools (35)

| Tool | Description |
|------|-------------|
| `check_permissions` | Report the current profile's MCP access mode and the token's capabilities |
| `create_page` | Create a new Confluence page |
| `get_page` | Read a page by ID (use `headings_only` to preview structure first) |
| `get_page_by_title` | Look up a page by title (use `headings_only` to preview structure first) |
| `update_page` | Update an existing page |
| `update_page_section` | Update a single section by heading name (supports `body` replacement OR `find_replace` literal substitutions) |
| `update_page_sections` | Atomically update multiple sections in one version bump (all-or-nothing) |
| `prepend_to_page` | Insert content at the beginning of an existing page (additive, safe) |
| `append_to_page` | Insert content at the end of an existing page (additive, safe) |
| `delete_page` | Delete a page |
| `revert_page` | Revert a page to a previous version |
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
| `get_version` | Return the epimethian-mcp server version and report available updates |
| `upgrade` | Upgrade epimethian-mcp to the latest available version (restart required after) |
