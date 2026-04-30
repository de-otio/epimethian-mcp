<p align="center">
  <img src="doc/logo/logo.svg?v=2" alt="Epimethian MCP logo" width="64" height="64">
</p>

# Epimethian MCP

A security-focused [MCP](https://modelcontextprotocol.io/) server that gives AI agents safe, multi-tenant access to Confluence Cloud. It provides some features not available in the official MCP server, like support for draw.io diagrams, macros, etc.

**What's new (v6.6.3):** Soft-confirmation token round-trip for MCP clients without (or with broken) elicitation. v6.6.0 introduced single-use, diff-bound tokens; v6.6.1 added fast-decline auto-detection (the Claude Code "fakes elicitation" bug now Just Works without `EPIMETHIAN_BYPASS_ELICITATION`) plus `versionField` coercion for string-encoded ints; v6.6.2 declared `outputSchema` so spec-compliant clients forward the structured payload to the agent, plus an `EPIMETHIAN_TOKEN_IN_TEXT=true` fallback for clients that drop content blocks; v6.6.3 hotfixed an SDK incompatibility with `z.discriminatedUnion` outputSchemas. v6.5 added per-client setup CLI snippets (`epimethian-mcp setup --client …`). v6.4.1 added atomic multi-section updates and find-replace mode. See [CHANGELOG.md](CHANGELOG.md) for full details.

## Why use this?

The official [Atlassian MCP server](https://github.com/atlassian/atlassian-mcp-server) covers basic Confluence and Jira access. Epimethian targets gaps that matter for consultants, power users, and teams with strict security requirements:

- **OS keychain credential storage** — API tokens are stored in macOS Keychain or Linux libsecret, never in plaintext config files. Setup uses masked input so tokens don't leak into terminal scrollback.
- **Multi-tenant profile isolation** — Each Atlassian tenant gets its own named profile with fully separate credentials and keychain entries. No risk of cross-tenant writes when switching between clients.
- **Tenant-aware write safety** — Write operations echo the target tenant so the AI agent (and you) always see where changes are going.
- **draw.io diagram support** — Create and embed draw.io diagrams directly in Confluence pages (assuming the tenant has draw.io installed), something the official server doesn't expose.
- **Attribution tracking** — Edited pages are labelled `epimethian-edited` for easy discovery. Confluence version messages include the MCP client name (e.g. "Updated by Claude Code (via Epimethian v5.2.0)") so you can trace which AI-assisted edits touched which content.

If you don't need any of the above, the official Atlassian server is a fine choice.

## How it works

Epimethian runs as a local MCP server that your AI agent (Claude Code, Cursor, etc.) talks to over stdio. On startup it reads a profile name from the environment, pulls the matching credentials from your OS keychain, validates the connection against Confluence Cloud, and then exposes a set of tools the agent can call. All Confluence API calls go directly from your machine to Atlassian — there is no intermediate service.

## Quick Start

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

For a detailed agent-facing guide (installation, configuration, profile management, uninstallation), see [install-agent.md](install-agent.md) or run `epimethian-mcp agent-guide` after installation.

Or install manually:

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup --profile <name>
```

The `setup` command prompts for your Confluence URL, email, and API token (masked input), tests the connection, and stores all credentials securely in your OS keychain under the named profile.

## MCP Configuration

Add to your `.mcp.json` (or equivalent MCP client config):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "my-profile"
      }
    }
  }
}
```

All credentials (URL, email, token) are read from the OS keychain at startup. **Only the profile name goes in config files.**

For IDE-hosted agents, use the absolute path from `which epimethian-mcp` as the `command` value.

## Multi-Tenant Support

Consultants and developers working across multiple Atlassian tenants can create a profile per tenant:

```bash
epimethian-mcp setup --profile globex
epimethian-mcp setup --profile acme-corp
```

Each project's `.mcp.json` specifies which profile to use. Profiles are fully isolated — separate keychain entries, separate Confluence instances, separate MCP server names (`confluence-globex`, `confluence-acme-corp`).

Manage profiles:

```bash
epimethian-mcp profiles              # list all (shows read-only status)
epimethian-mcp profiles --verbose    # show URLs, emails, and read-only status
CONFLUENCE_PROFILE=globex epimethian-mcp status   # test connection
epimethian-mcp profiles --remove <name>           # delete profile and credentials
```

The `--remove` command deletes the profile's keychain entry and registry record after interactive confirmation. For non-interactive environments (CI, agent shell sessions), pass `--force` to skip the prompt.

### Per-Profile Read-Only Mode

Protect client tenants from accidental writes:

```bash
epimethian-mcp profiles --set-read-only acme-corp
epimethian-mcp profiles --set-read-write globex
```

New profiles default to **read-only**. The `setup` command prompts "Enable writes for this profile? [y/N]" or accepts `--read-write` for non-interactive use.

When a profile is read-only, write tools are **not registered** at all — the agent's tool list is truthful and contains only read tools plus `check_permissions`. The posture is resolved at server startup — restart running servers after changing it.

## Read-Only Mode

**Read-only is the recommended posture for most users.** It provides defense-in-depth: even if the underlying API token has write access, the MCP will not expose write tools to the agent. This protects against prompt-injection attacks, accidental mutations during exploratory sessions, and misconfigured agents.

### Configuring posture

Set `posture` in the profile settings (preferred):

```jsonc
// ~/.config/epimethian-mcp/profiles.json
{
  "profiles": {
    "my-profile": {
      "posture": "read-only"
    }
  }
}
```

Or use the legacy environment variable (still supported):

```bash
CONFLUENCE_READ_ONLY=true
```

The `posture` setting is a tri-state:

| Value | Behavior |
|---|---|
| `"read-only"` | Write tools are never registered, regardless of what the token can do. |
| `"read-write"` | Write tools are always registered. Writes that fail at the API level return remediation messages. |
| `"detect"` (default) | A startup probe infers the effective posture from the token's actual permissions. |

The legacy `readOnly: boolean` profile key remains supported as an alias and is resolved to `posture: "read-only"` / `"read-write"`. Users should migrate to `posture` directly.

### MCP posture is independent of token capability

You can pin the MCP to read-only even when the API token has full write access. This is the "belt and suspenders" case: the Confluence permission boundary enforces one layer, and the MCP profile enforces another. The `check_permissions` tool makes the distinction visible — it reports both the configured posture and what the probe determined the token can actually do.

### Startup probe (posture: "detect")

When posture is `"detect"`, Epimethian runs a lightweight probe at startup to determine whether the token can write. The probe queries the Confluence permissions endpoint for the first available space and, if that is unavailable, falls back to a dry-run write attempt. The result is logged as a startup banner and drives which tools are registered for the session.

Probe outcomes:

- Token can write → effective posture is `read-write`; all tools registered.
- Token is read-only → effective posture is `read-only`; write tools not registered.
- Probe inconclusive → effective posture defaults to `read-write` with a visible warning.

### Checking permissions

The `check_permissions` tool is always registered, in every posture. Call it from the agent to inspect the configured posture, effective posture, probe result, and token capability. For operator diagnostics from the CLI:

```bash
CONFLUENCE_PROFILE=my-profile epimethian-mcp permissions my-profile
```

For the full posture resolution matrix and error remediation design, see [doc/design/14-api-permission-handling.md](doc/design/14-api-permission-handling.md).

## Provenance: AI-Edited Badge

Any page **created or modified** by this MCP is automatically tagged with a yellow "AI-edited" content-status badge. The badge appears as a colored pill in the Confluence page view and space index, signaling that the page has been touched by an AI agent and has not yet been reviewed by a human. A human can clear it in one click after review.

The badge is re-applied on every body-modifying tool call (idempotent: skipped when the page already carries an equivalent badge in any supported locale, to avoid version spam). If a subsequent AI edit is made after the human clears the badge, it reappears.

### Default badge

- Label: `"AI-edited"` (English default)
- Color: `#FFC400` (yellow — reads as *attention needed*)

### Configuration

| Setting | Default | Purpose |
|---|---|---|
| `unverifiedStatus` | `true` | Master toggle. Set to `false` to disable the badge entirely. |
| `unverifiedStatusLocale` | Confluence site default → `en` | Language for the badge label. |
| `unverifiedStatusName` | *(unset)* | Full label override (bypasses locale lookup). Must be ≤20 chars. |
| `unverifiedStatusColor` | `#FFC400` | Color override. One of five Confluence-allowed values: `#FFC400`, `#2684FF`, `#57D9A3`, `#FF7452`, `#8777D9`. |

Environment variable equivalents: `CONFLUENCE_UNVERIFIED_STATUS=false`, `CONFLUENCE_UNVERIFIED_STATUS_LOCALE=fr`.

Disable the badge for a profile:

```jsonc
{ "posture": "read-write", "unverifiedStatus": false }
```

Custom label (e.g., for compliance workflows):

```jsonc
{ "unverifiedStatusName": "Needs legal review", "unverifiedStatusColor": "#FF7452" }
```

### Supported locales

| Locale | Label |
|---|---|
| `en` (default) | AI-edited |
| `fr` | Modifié par IA |
| `de` | KI-bearbeitet |
| `es` | Editado por IA |
| `pt` | Editado por IA |
| `it` | Modificato da IA |
| `nl` | AI-bewerkt |
| `ja` | AI編集済み |
| `zh` | AI已编辑 |
| `ko` | AI 편집됨 |

The locale is resolved from (in order): `unverifiedStatusLocale` profile setting → `CONFLUENCE_UNVERIFIED_STATUS_LOCALE` env var → Confluence site default language (probed once per tenant via `GET /wiki/rest/api/settings/systemInfo`) → `"en"`. The MCP process's own OS locale is intentionally NOT consulted — the badge is a server-stored string shown to every viewer of the page, so it must follow the tenant, not whoever happens to run the agent.

When the badge cannot be applied (e.g., the token lacks content-state permission), the tool call still succeeds and a warning is surfaced in the tool response instead of failing silently.

For the full design — idempotency behavior, version-bump math, lifecycle diagram, and security considerations — see [doc/design/13-unverified-status.md](doc/design/13-unverified-status.md).

## Token Efficiency

Confluence pages are verbose — storage format HTML with macro markup can easily reach 50,000+ tokens. Epimethian reduces token usage through several strategies, all lossless with respect to Confluence data:

- **Drill-down pattern** — Use `headings_only` to get a page outline (~500 tokens), then `section` to read just the part you need in storage format. No need to fetch the full page body.
- **Section-level editing** — `update_page_section` replaces content under a single heading. The rest of the page is never touched, eliminating the need to send the full body on updates.
- **Multi-section atomic updates** — `update_page_sections` (v6.4.0+) updates multiple sections in one version bump, eliminating version conflicts and intermediate reads during tree-building workflows.
- **Find-replace mode** — `update_page_section` and `update_page_sections` accept optional `find_replace: [{find, replace}, ...]` (v6.4.0+) for literal-string substitutions without resending section bodies. Macro-safe: substitutions cannot match inside macro boundaries.
- **Skip-read shortcut** — `update_page`, `update_page_section`, and `update_page_sections` accept `version: "current"` to skip the read of the latest version when the next operation will be an update (v6.3.0+).
- **Page cache** — An in-memory, version-keyed cache eliminates redundant API calls during iterative editing. After updating a page, subsequent reads serve from cache (~90% fewer tokens on repeated reads).
- **Search excerpts** — Search results include content previews so the agent can triage results without calling `get_page` on each one.
- **Markdown view** — `format: "markdown"` returns a compact read-only rendering where macros become `[macro: name]` placeholders. The server rejects any attempt to write markdown back — storage format is the only accepted write format.
- **Truncation** — `max_length` cuts the body at an element boundary with a `[truncated at N of M characters]` marker.

## Tools

| Tool                  | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `create_page`         | Create a new page                                                      |
| `get_page`            | Read a page by ID (`headings_only`, `section`, `max_length`, `format`) |
| `get_page_by_title`   | Look up a page by title (same options as `get_page`)                   |
| `update_page`         | Update an existing page                                                |
| `update_page_section` | Update a single section by heading name                                |
| `update_page_sections` | Update multiple sections atomically in one version bump                |
| `delete_page`         | Delete a page                                                          |
| `list_pages`          | List pages in a space                                                  |
| `get_page_children`   | Get child pages                                                        |
| `search_pages`        | Search via CQL (includes content excerpts)                             |
| `get_spaces`          | List available spaces                                                  |
| `add_attachment`      | Upload a file attachment                                               |
| `get_attachments`     | List attachments on a page                                             |
| `add_drawio_diagram`  | Add a draw.io diagram                                                  |
| `get_labels`          | Get all labels on a page                                               |
| `add_label`           | Add one or more labels to a page                                       |
| `remove_label`        | Remove a label from a page                                             |
| `get_comments`        | Read page comments (footer and inline)                                 |
| `create_comment`      | Add a comment to a page                                                |
| `resolve_comment`     | Resolve or reopen an inline comment                                    |
| `delete_comment`      | Delete a comment                                                       |
| `get_page_status`     | Get the content status badge on a page                                 |
| `set_page_status`     | Set the content status badge on a page                                 |
| `remove_page_status`  | Remove the content status badge from a page                            |
| `get_page_versions`   | List version history for a page                                        |
| `get_page_version`    | Get page content at a specific historical version (read-only markdown) |
| `diff_page_versions`  | Compare two versions of a page                                         |
| `prepend_to_page`     | Insert content at the beginning of a page (additive, safe)             |
| `append_to_page`      | Insert content at the end of a page (additive, safe)                   |
| `revert_page`         | Revert a page to a previous version (lossless)                         |
| `lookup_user`         | Search for Atlassian users by name or email                            |
| `resolve_page_link`   | Resolve a page title + space key to a stable page ID and URL           |
| `get_version`         | Return the server version                                              |

## Environment Variables

Configuration via environment variables (all optional; sensible defaults provided):

| Variable | Default | Purpose |
|---|---|---|
| `CONFLUENCE_PROFILE` | *(required)* | Active profile name (e.g., `my-profile`). Credentials are loaded from OS keychain. |
| `EPIMETHIAN_WRITE_BUDGET_ROLLING` | 75 writes per 15 min | Rolling-window write limit (per-scope: session, profile, global). Set to `0` to disable. Replaces deprecated `EPIMETHIAN_WRITE_BUDGET_HOURLY` (removed in v7.0); the old name still works as an alias. |
| `EPIMETHIAN_WRITE_BUDGET_SESSION` | 250 writes | Session-scoped write limit. |
| `EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS` | `false` | Opt-in feature flag. When `true`, suppress `confirm_deletions` for macro byte-equivalent round-trips (e.g. re-rendered `<ac:link>` with reordered attributes). |
| `EPIMETHIAN_BYPASS_ELICITATION` | `false` | Escape hatch for MCP clients that advertise elicitation support but never honour it. When `true`, skips the in-protocol confirmation prompt. The harness's permission allow-list still gates writes. |
| `EPIMETHIAN_MUTATION_LOG` | `false` | Opt-in logging. Write JSONL records to `~/.epimethian/logs/` for every write operation. |
| `EPIMETHIAN_AUTO_UPGRADE` | `check-only` | Set to `patches` for automatic patch-version installs (same npm provenance verification). |
| `CONFLUENCE_READ_ONLY` | *(deprecated)* | Legacy alias for `posture: "read-only"` in profile settings. Use the profile config instead. |
| `CONFLUENCE_UNVERIFIED_STATUS` | `true` | Master toggle for AI-edited badge. Set to `false` to disable. |
| `CONFLUENCE_UNVERIFIED_STATUS_LOCALE` | Confluence site default → `en` | Language for the badge label (10 locales: en/fr/de/es/pt/it/nl/ja/zh/ko). |

For CI/headless environments without OS keychain, set all three: `CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`.

## Content Safety

Write operations are protected by layered safety guards to prevent accidental content loss:

- **Shrinkage guard** — `update_page` rejects writes that reduce the body by more than 50%. Pass `confirm_shrinkage: true` to override.
- **Structural integrity** — rejects writes that drop more than 50% of headings. Pass `confirm_structure_loss: true` to override.
- **Empty-body rejection** — hard guard, no opt-out. Rejects writes that produce near-empty pages.
- **Additive tools** — `prepend_to_page` and `append_to_page` avoid full-body replacement entirely.
- **Lossless revert** — `revert_page` uses raw storage format, avoiding lossy markdown conversion.
- **Mutation log** — opt-in via `EPIMETHIAN_MUTATION_LOG=true`. Writes JSONL records to `~/.epimethian/logs/` for every write operation.

## Credential Security

- Credentials are stored per-profile in the OS keychain (macOS Keychain / Linux libsecret)
- URL, email, and API token are stored as an atomic unit — no mixing across profiles
- Tokens are never written to disk in plaintext
- The `setup` command uses masked input so tokens don't appear in terminal scrollback
- Startup validation verifies credentials, tenant identity (email), and tenant seal (cloudId) before accepting tool calls. Sealed profiles fail closed if the tenant-id endpoint is unreachable.
- Write operations include a tenant echo so the target is always visible
- For CI/headless environments, set all three env vars (`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`) — partial combinations are rejected
- Updates are **check-and-notify** by default. Run `epimethian-mcp upgrade` to install — the CLI verifies the npm provenance attestation first and refuses to install without it. Set `EPIMETHIAN_AUTO_UPGRADE=patches` to opt in to automatic patch installs (same integrity check).

For a full security & safety evaluation — threat model, defence-in-depth mechanisms, known limitations — see [doc/design/security/](doc/design/security/README.md).

## Development

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm test
```

## Architecture

```mermaid
flowchart LR
    Agent["AI Agent<br/>(Claude Code, Cursor, ...)"]

    subgraph Local["Local machine"]
        MCP["Epimethian MCP Server"]
        Keychain["OS Keychain<br/>(macOS Keychain / libsecret)"]
        Registry["Tenant Profile Registry<br/>(~/.config/epimethian-mcp/profiles.json)"]
    end

    subgraph Atlassian["Atlassian Cloud"]
        TenantA["Tenant A<br/>(e.g. globex)"]
        TenantB["Tenant B<br/>(e.g. acme-corp)"]
    end

    Agent -- "stdio (MCP)" --> MCP
    MCP -- "list / select profile" --> Registry
    MCP -- "read credentials for profile" --> Keychain
    MCP -- "HTTPS + API token<br/>(tenant A)" --> TenantA
    MCP -- "HTTPS + API token<br/>(tenant B)" --> TenantB

    Registry -. "names + read-only flags<br/>(no secrets)" .- Keychain
```

The MCP server resolves the active profile from `CONFLUENCE_PROFILE`, loads its URL/email/token from the keychain, and talks directly to the matching Atlassian tenant. The profile registry stores only non-secret metadata (profile names, read-only flags); tokens never leave the keychain in plaintext.

## License

[MIT](LICENSE)
