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

Run `epimethian-mcp setup --profile <name> --client <client-id>` after Step 5 (credential setup) — it prints the exact config snippet for your MCP host. Supported clients: `claude-code`, `claude-desktop`, `claude-code-vscode`, `cursor`, `windsurf`, `zed`, `opencode`. Keep the fallback hand-typed examples below for cases where the CLI is unavailable.

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

## Soft confirmation (clients without working elicitation)

Some MCP clients (OpenCode, the Claude Code VS Code extension, and
others) don't implement the in-protocol confirmation prompt — either
they don't advertise the capability, or they advertise it and never
honour the request (the SDK transport silently returns
`{action: "decline"}` without showing the user a UI). Starting in
v6.6.0, epimethian-mcp routes those confirmations through your
agent's normal chat surface instead.

The implementation evolved across v6.6.0 → v6.6.3:

- **v6.6.0** introduced soft elicitation for clients that don't
  *advertise* the capability — token-bound, single-use, diff-bound.
- **v6.6.1** added **fast-decline auto-detection**: if the client
  advertises elicitation but the decline arrives in <50 ms (well below
  human reaction time), the session is flagged as fake and the call
  is re-routed through the soft-confirm path automatically. Threshold
  is overridable via `EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=<10..5000>`.
  No env-var configuration needed for the Claude Code VS Code
  extension's "fakes elicitation" bug — it Just Works.
- **v6.6.2** declared `outputSchema` on every mutating tool so
  spec-compliant clients are obliged to forward `structuredContent`
  (where the token lives) to the agent. Added an opt-in
  `EPIMETHIAN_TOKEN_IN_TEXT=true` fallback that appends the full
  token to `content[0].text` for clients that drop `content` blocks
  on `isError: true` results (Claude Code issues #15412 / #9962 /
  #39976).
- **v6.6.3** swapped the `outputSchema` from `z.discriminatedUnion`
  to `z.object` so the MCP SDK's `normalizeObjectSchema` (which only
  accepts schemas with `.shape`) can route the structured payload
  through `validateToolOutput` without throwing `_zod` undefined
  after the write commits. Hotfix; data-integrity-critical.

### What you (the agent) see

When a destructive write is requested against a client without working
elicitation, the tool returns an error with a confirmation token:

```
isError: true
structuredContent:
  {
    "kind": "confirmation_required",
    "confirm_token": "<opaque token>",
    "audit_id": "<UUID for correlation>",
    "expires_at": "<ISO timestamp>",
    "page_id": "<pageId>",
    "human_summary": "<one-line description for the user>",
    "deletion_summary": { ... numeric counts only ... }   // optional
  }
content[0].text:
  ⚠️  Confirmation required (SOFT_CONFIRMATION_REQUIRED)

  {human_summary}

  Please ask the user before retrying. If approved, re-call with the
  same parameters plus "confirm_token" from structuredContent.

  Token tail: ...<last 8 chars>    Expires: <timestamp>    Audit ID: <uuid>

  [FALLBACK] Full token (EPIMETHIAN_TOKEN_IN_TEXT=true): <full token>
  ← only present when EPIMETHIAN_TOKEN_IN_TEXT=true is set
```

The `kind` discriminator distinguishes this `"confirmation_required"`
arm from the success arm (`"written"` or `"deleted"`) on the same
tool. Successful writes return:

```
structuredContent:
  { "kind": "written", "page_id": "...", "new_version": 12, ... }
```

…or `"kind": "deleted"` for `delete_page`.

### What to do

1. STOP. Don't retry blindly.
2. Show the user, in their language, what's about to happen — use the
   `human_summary` field from `structuredContent`, or the
   human-readable text in `content[0].text` if your client doesn't
   forward `structuredContent`. **Never echo the token bytes to the
   user** — the token is meant to flow agent → server, not user → eye.
3. Ask the user explicitly. Wait for their answer.
4. If approved: re-call the tool with the SAME parameters plus
   `confirm_token`. Read the token from `structuredContent.confirm_token`
   when available; if your client doesn't surface that, the token's
   full bytes are in the `[FALLBACK] Full token: …` line of
   `content[0].text` whenever `EPIMETHIAN_TOKEN_IN_TEXT=true` is set
   on the server. The 8-character "Token tail: …" line in the prose
   is for human inspection only — it is **not** the token.
5. If denied: tell the user the operation has been cancelled.

### Token semantics

- Single-use: a successful retry consumes the token. Replays fail.
- 5-minute TTL by default.
- Invalidated by any competing write to the same page (stale).
- Bound to the specific diff and tenant: changing the body, page version, or
  tenant invalidates the token.

### Operator opt-outs

These environment variables control soft confirmation behavior:

- **`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`** — bypasses soft confirmation
  entirely (no prompt; useful for headless / CI). Removes the
  human-in-the-loop gate; the harness's tool allow-list still applies.
- **`EPIMETHIAN_DISABLE_SOFT_CONFIRM=true`** — keeps the legacy
  `ELICITATION_REQUIRED_BUT_UNAVAILABLE` failure mode for clients without
  elicitation support.
- **`EPIMETHIAN_SOFT_CONFIRM_TTL_MS=300000`** — override the default 5-minute
  TTL (clamped to 60 seconds minimum, 15 minutes maximum).
- **`EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT=100`** — override the per-15-minute
  mint cap (default 100; "0" disables the cap entirely).

#### v6.6.1+ fast-decline auto-detection (Claude Code VS Code et al.)

- **`EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true`** — deterministic
  counterpart to fast-decline auto-detection. Use when your client is
  known to advertise elicitation but never honour it (e.g. the Claude
  Code VS Code extension ≤ 2.1.123) and you want to skip the timing
  probe on the first call. Distinct from `EPIMETHIAN_BYPASS_ELICITATION`:
  this routes through the soft-confirmation gate; bypass removes the
  gate entirely.
- **`EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=<10..5000>`** — override the
  fast-decline threshold (default 50 ms). Raise this if a slow MCP
  transport is mis-classifying real declines as fake.
- **`EPIMETHIAN_DISABLE_FAST_DECLINE_DETECTION=true`** — total
  off-switch for the auto-detection; restores exactly v6.6.0 behaviour.

#### v6.6.2+ structured-content fallback

- **`EPIMETHIAN_TOKEN_IN_TEXT=true`** — opt-in fallback for clients that
  drop `content` blocks on `isError: true` results, or that ignore the
  `outputSchema` declaration and never surface `structuredContent`
  to the agent. When set, the soft-confirm result text appends a
  `[FALLBACK] Full token (EPIMETHIAN_TOKEN_IN_TEXT=true): <token>`
  line so the agent can still extract the token. The structured
  payload is unchanged. Trade-off: the token is visible in the agent
  transcript (the security choice v6.6.0 explicitly avoided), so use
  only when needed. Today this is required for Claude Code (the VS
  Code extension and possibly the CLI) — see the per-client matrix
  below.

### Multi-process deployments

Tokens are process-local in-memory. If you're running multiple MCP server
processes for one tenant (e.g. a load-balanced fleet or separate processes
per IDE window), a soft confirmation minted by process P1 will fail validation
in process P2 (the load balancer routes the retry to a different process).
This is not a bug — it's the safe failure mode — but it means the user needs
to mint a new token if the retry lands on a different process.

**Recommendation:** Pin a single MCP server process per agent or IDE window.
Pre-seal profiles upgraded from versions before v5.5.0 must run `epimethian-mcp
setup` once to acquire a sealed cloudId before soft confirmation is available.

## MCP client compatibility

epimethian-mcp uses MCP **elicitation** (the in-protocol confirmation
prompt added to MCP in 2025) as the human-in-the-loop gate for destructive
operations. Different MCP clients support elicitation differently — some
fully, some not at all, and some advertise the capability without honouring
it. The compatibility matrix below tells you which env-var workaround to
recommend, if any.

| Client | Elicitation? | What to do (v6.6.3+) |
|---|---|---|
| **Claude Code (CLI)** | Yes — full support | No special config needed. |
| **Claude Desktop** | Yes — full support | No special config needed. |
| **Claude Code VS Code extension** (all versions tested through 2.1.x) | Fakes it (advertises capability, never honours) | v6.6.1's fast-decline auto-detection routes the call through soft-confirm automatically. **Plus** set `EPIMETHIAN_TOKEN_IN_TEXT=true` in the server's env so the agent can read the full token from `content[0].text` — Claude Code does not currently surface `structuredContent` on `isError: true` responses (issue #15412). No `EPIMETHIAN_BYPASS_ELICITATION` needed; the gate works through the soft-confirm token flow. |
| **OpenCode** | No — capability not advertised | v6.6.0+ soft-confirmation token flow is automatic when the client lacks elicitation. The Vercel AI SDK forwards `structuredContent` to the model when `outputSchema` is declared (which v6.6.2 added) — the agent should be able to read `confirm_token` directly. If your build of OpenCode/AI-SDK doesn't honour `outputSchema`, set `EPIMETHIAN_TOKEN_IN_TEXT=true` as a fallback. `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` remains an escape hatch for headless / CI runs where no human is in the loop. |
| **Cursor / Windsurf / Zed / others** | Varies | If write tools fail with `ELICITATION_REQUIRED_BUT_UNAVAILABLE`, the client doesn't advertise the capability — soft-confirm should kick in automatically; use `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` only if no human is in the loop. If write tools succeed at the gate but the agent can't see the token in the response, set `EPIMETHIAN_TOKEN_IN_TEXT=true`. If the client *advertises* elicitation but always fails fast (decline arrives in <50 ms), v6.6.1's auto-detection re-routes through soft-confirm. Set `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true` to skip the timing probe on the first call when the client is known to fake it. |

### Three configuration paths — pick the one that matches your client

These flags are **not interchangeable**. The newer (v6.6.x) flags
preserve the human-in-the-loop gate; the older bypass flags remove it.
Default to preserving the gate.

- **(Recommended) Soft-confirm token flow.** No env-var bypass needed.
  v6.6.0 + v6.6.1 + v6.6.3 give you a working soft-confirm round-trip
  for any client whose host can put a "do you approve?" prompt in front
  of the user (chat surface, tool-result UI, etc.). For clients with
  rendering quirks, layer on `EPIMETHIAN_TOKEN_IN_TEXT=true`
  (additive — keeps the gate, just exposes the token in
  `content[0].text` too).
- **`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`** — for clients that *don't
  advertise* elicitation AND have no other way to surface a
  confirmation prompt (e.g. headless / CI runs). Removes the gate
  entirely; only the harness allow-list and server-side guards remain.
  Pre-v6.6.0 escape hatch; rarely needed today.
- **`EPIMETHIAN_BYPASS_ELICITATION=true`** — unconditional bypass,
  regardless of whether the client advertises elicitation. Original
  v6.4.1 escape hatch for Claude Code VS Code's "fakes elicitation"
  bug. **In v6.6.1+ this is no longer needed** for that bug — the
  fast-decline detector routes around it. Use only if you specifically
  want to remove the gate.

### Trade-off: what you give up by setting `ALLOW_UNGATED_WRITES` or `BYPASS_ELICITATION`

These two flags **disable the human-in-the-loop confirmation gate
entirely**. Writes still go through the harness's tool allow-list (so
users can still block the tool in their permission settings) and
through every server-side guard (provenance, source-policy,
write-budget, byte-equivalence) — but the user no longer gets a
prompt before each destructive operation. Recommend this only when:

1. The user is aware of and accepts the trade-off, AND
2. The user's MCP client provides some other interaction model where they
   can intervene (e.g. they review tool calls before approval), OR
3. The work is read-mostly and only occasional, additive writes happen.

**Do NOT set either flag silently.** If you (the agent) need to recommend
one, explain to the user what the gate is for, why their client can't
honour it, and what alternative protections remain.

`EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED` and
`EPIMETHIAN_TOKEN_IN_TEXT` (v6.6.1+ / v6.6.2+) are different — they
**preserve** the gate by routing through the soft-confirm token flow.
They affect how the prompt reaches the user, not whether one happens.
Prefer these to the bypass flags whenever the client supports any
form of agent ↔ user dialogue.

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
