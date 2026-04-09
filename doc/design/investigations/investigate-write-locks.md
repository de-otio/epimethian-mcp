# Investigation: Per-Tenant Write Locks

## Problem

Consultants work across multiple Atlassian tenants simultaneously. An accidental write to the wrong tenant (e.g., creating a page in a client's Confluence instead of your own) can be catastrophic — ranging from embarrassing to contractually damaging. The current tenant echo feature helps the AI confirm which tenant it's writing to, but it doesn't prevent the write from happening.

No existing MCP server offers per-profile write granularity. sooperset has a global `READ_ONLY_MODE` env var (all-or-nothing), and the official Rovo server has no read-only mode at all.

## Current Architecture

### Profile system

- `~/.config/epimethian-mcp/profiles.json` — registry of profile names (no secrets), managed by `src/shared/profiles.ts`
- OS keychain entries at `epimethian-mcp` / `confluence-credentials/{profile-name}` — stores `{url, email, apiToken}` as JSON blob
- `CONFLUENCE_PROFILE` env var in `.mcp.json` selects the active profile

### Tool annotations already partition read vs write

| Tool | Annotation | Write? |
|------|-----------|--------|
| `create_page` | `destructiveHint: false, idempotentHint: false` | YES |
| `update_page` | `destructiveHint: false, idempotentHint: false` | YES |
| `delete_page` | `destructiveHint: true, idempotentHint: true` | YES |
| `add_attachment` | `destructiveHint: false, idempotentHint: false` | YES |
| `add_drawio_diagram` | `destructiveHint: false, idempotentHint: false` | YES |
| `get_page` | `readOnlyHint: true` | no |
| `get_page_by_title` | `readOnlyHint: true` | no |
| `search_pages` | `readOnlyHint: true` | no |
| `list_pages` | `readOnlyHint: true` | no |
| `get_page_children` | `readOnlyHint: true` | no |
| `get_spaces` | `readOnlyHint: true` | no |
| `get_attachments` | `readOnlyHint: true` | no |

### Credential resolution (`src/server/confluence-client.ts`, lines 29-93)

Three-tier resolution with no merging: named profile → all-three env vars → legacy keychain. The resolved config is frozen via `Object.freeze()`.

## How Other Servers Handle This

| Server | Approach | Limitations |
|--------|----------|-------------|
| sooperset/mcp-atlassian | `READ_ONLY_MODE=true` env var, `@check_write_access` decorator. Write tools not registered when enabled. | Global toggle, no per-profile granularity. Binary — must restart to switch. |
| Atlassian Rovo (official) | No read-only mode. OAuth scope restrictions are the intended path but not fully implemented. | No enforcement at tool level. |
| JudicaelPoumay/confluence-mcp-read-only | Fork that removes all write tools entirely. | No write capability at all. |

## Design Options

### Option A: Profile Registry Metadata (recommended)

Store a `readOnly` flag in `~/.config/epimethian-mcp/profiles.json`:

```json
{
  "profiles": ["jambit", "acme-corp"],
  "settings": {
    "acme-corp": { "readOnly": true }
  }
}
```

**Pros:**
- Per-profile granularity — exactly what the consultant use case needs
- Set once during setup, applies everywhere (all projects, all VS Code windows)
- Single source of truth — if acme-corp is read-only, it's read-only everywhere
- Natural extension of existing registry architecture

**Cons:**
- Registry schema change required
- Server must read the registry at startup (currently only CLI reads it)

### Option B: Environment Variable (`CONFLUENCE_READ_ONLY=true`)

Set in `.mcp.json` per server instance.

**Pros:** Simple, familiar (sooperset precedent), no schema changes.

**Cons:** Per-project, not per-profile. If a consultant has 3 projects using acme-corp, they must set it in all 3 `.mcp.json` files. If they forget one, protection is gone.

### Option C: Keychain Metadata

Extend the keychain JSON blob to include `readOnly: true`.

**Pros:** Atomic with credentials.

**Cons:** Mixes security policy with secrets. Changing the flag requires re-saving the API token.

### Option D: Runtime Toggle

A `set_read_only` MCP tool.

**Pros:** Flexible.

**Cons:** Completely insecure — the AI can toggle its own lock. Prompt injection could disable it.

## Recommendation: Option A + Option B Layered

1. **Primary: Profile registry metadata** — `epimethian-mcp profiles --set-read-only acme-corp` sets it once, applies everywhere.
2. **Override: `CONFLUENCE_READ_ONLY=true` env var** — for CI/CD mode (no profile) or to override in a specific `.mcp.json`. If set, takes precedence.
3. **Strict mode consideration:** The env var can only make things *more* restrictive, not less. If the registry says read-only, `CONFLUENCE_READ_ONLY=false` does NOT override it. Prevents stale `.mcp.json` from accidentally unlocking a profile.

## Implementation Plan

### 1. Profile Registry Schema Change

**File:** `src/shared/profiles.ts`

```typescript
interface ProfileSettings {
  readOnly?: boolean;
}

interface ProfileRegistry {
  profiles: string[];
  settings?: Record<string, ProfileSettings>;
}
```

Add `getProfileSettings(name)` and `setProfileSettings(name, settings)` functions. The atomic-write pattern already exists (lines 66-71).

### 2. Config Interface Extension

**File:** `src/server/confluence-client.ts`

Extend `Config` (line 7) to add `readOnly: boolean`. In `resolveCredentials()`, after resolving the profile name:
- Read profile settings from registry
- Check `process.env.CONFLUENCE_READ_ONLY`
- Merge with precedence (env var > registry, or strict mode: env var can only tighten)
- Add to the frozen config object

### 3. Write Guard

**File:** `src/server/index.ts`

Register write tools but reject at call time (Strategy B — more informative than hiding tools):

```typescript
function writeGuard(config: Config): ToolResult | null {
  if (!config.readOnly) return null;
  const host = new URL(config.url).hostname;
  const mode = config.profile
    ? `profile "${config.profile}"`
    : "current configuration";
  return {
    content: [{
      type: "text",
      text: `Write blocked: ${mode} is set to read-only for ${host}. ` +
            `To enable writes, run: epimethian-mcp profiles --set-read-write ${config.profile ?? "<profile>"}`,
    }],
    isError: true,
  };
}
```

Add at the top of each write tool handler (5 locations):
- `create_page` handler (line 88)
- `update_page` handler (line 150)
- `delete_page` handler (line 177)
- `add_attachment` handler (line 386)
- `add_drawio_diagram` handler (line 444)

### 4. CLI Commands

**File:** `src/cli/profiles.ts`

- `--set-read-only <profile>` and `--set-read-write <profile>` subcommands
- Profile listing shows read-only status:
  ```
  Profile      URL                              Read-Only
  jambit       https://jambit.atlassian.net      no
  acme-corp    https://acme.atlassian.net        YES
  ```

**File:** `src/cli/setup.ts`

- `--read-only` flag: `epimethian-mcp setup --profile acme-corp --read-only`

### 5. Startup Log

**File:** `src/server/confluence-client.ts`

Update the startup log (line 169) to include read-only status:
```
epimethian-mcp: connected to https://acme.atlassian.net as user@acme.com (profile: acme-corp, READ-ONLY)
```

### 6. Future write tools must also be gated

Any future write tools (comments, labels, move, copy, bulk operations) must include the `writeGuard()` check. Document this as a development invariant.

## Error Message Design

When a write is blocked:
```
Write blocked: profile "acme-corp" is set to read-only for acme.atlassian.net.
To enable writes, run: epimethian-mcp profiles --set-read-write acme-corp
```

Returned as `isError: true` so the AI knows the operation failed and relays the message.

## Open Questions

1. Should the default for new profiles be read-only (opt-in to writes) or read-write (opt-in to read-only)? Read-only-by-default is safer but adds friction for single-tenant users.
2. Should there be a `--confirm-write` mode that requires the AI to call a confirmation tool before each write, rather than blocking entirely?
3. Should the write lock apply to the internal `epimethian-managed` label addition, or only to user-facing tools? (Recommendation: only user-facing tools — attribution is a server internal.)
