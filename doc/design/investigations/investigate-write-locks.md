# Investigation: Per-Tenant Write Locks

**STATUS: ✅ IMPLEMENTED**

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
| `update_page_section` | `destructiveHint: false, idempotentHint: false` | YES (calls `updatePage()` internally) |
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

### Credential resolution (`src/server/confluence-client.ts`, lines 31-95)

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
  "profiles": ["globex", "acme-corp"],
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

**Cons:** Completely insecure — the AI can toggle its own lock. Prompt injection could disable it. More fundamentally, the MCP protocol provides no mechanism to restrict tool access by caller identity — any registered tool is callable by any connected client. A runtime toggle tool is therefore fundamentally unprotectable regardless of confirmation tokens or passwords.

## Recommendation: Option A + Option B Layered

1. **Primary: Profile registry metadata** — `epimethian-mcp profiles --set-read-only acme-corp` sets it once, applies everywhere.
2. **Override: `CONFLUENCE_READ_ONLY=true` env var** — for CI/CD mode (no profile) or to override in a specific `.mcp.json`. If set, takes precedence.
3. **Strict mode (security invariant):** The env var can only make things *more* restrictive, never less. The merge logic is a logical OR — if *either* source says read-only, the profile is read-only:

   ```typescript
   const readOnly = registryReadOnly || (process.env.CONFLUENCE_READ_ONLY === "true");
   ```

   `CONFLUENCE_READ_ONLY=false` (or any value other than `"true"`) has no effect on a registry-level read-only flag. This prevents a stale or malicious `.mcp.json` from accidentally unlocking a protected profile. This invariant must have a dedicated unit test.

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

**Concurrency guard:** The read-modify-write cycle in the profile registry is not locked. Concurrent CLI invocations (e.g., `--set-read-only` in one terminal while `setup` runs in another) can silently drop the read-only flag. Use advisory file locking (`proper-lockfile` or equivalent) around the read-modify-write cycle.

**Permission verification:** On the read path, verify that the registry file is not group- or world-writable (`stat` the file, reject if `mode & 0o022` is nonzero). Defense-in-depth against permission drift from backup tools or misconfiguration.

### 2. Config Interface Extension

**File:** `src/server/confluence-client.ts`

Extend `Config` (line 9) to add `readOnly: boolean`. In `resolveCredentials()`, after resolving the profile name:
- Read profile settings from registry
- Check `process.env.CONFLUENCE_READ_ONLY`
- Merge with strict-mode OR: `readOnly = registryReadOnly || (env === "true")`
- Add to the frozen config object

**Important:** The read-only flag is resolved once at server startup and frozen into the config object. Changes via `--set-read-only` do not affect already-running servers. The CLI command must warn: "Note: Restart any running MCP servers for this change to take effect."

### 3. Write Guard

**File:** `src/server/index.ts`

Register write tools but reject at call time (Strategy B — more informative than hiding tools). When read-only is active, write tool descriptions are prefixed with `[READ-ONLY]` so the AI avoids calling them in the first place, reducing prompt injection success rates.

**Design trade-off:** Visible write tools mean a prompt injection in a Confluence page body could instruct the AI to retry blocked writes. The server-side guard is hard (no actual write can occur), but the AI may waste tokens retrying. The `[READ-ONLY]` prefix mitigates this by signaling the constraint before the AI decides to call the tool.

Use a **whitelist pattern** — guard all tools that are NOT in the read-only set — rather than a blacklist of named write tools. This makes future omissions impossible:

```typescript
const READ_ONLY_TOOLS = new Set([
  "get_page", "get_page_by_title", "search_pages",
  "list_pages", "get_page_children", "get_spaces", "get_attachments",
]);

function writeGuard(toolName: string, config: Config): ToolResult | null {
  if (!config.readOnly) return null;
  if (READ_ONLY_TOOLS.has(toolName)) return null;
  const mode = config.profile
    ? `profile "${config.profile}"`
    : "current configuration";
  return {
    content: [{
      type: "text",
      text: `Write blocked: ${mode} is set to read-only. ` +
            `To enable writes, run: epimethian-mcp profiles --set-read-write ${config.profile ?? "<profile>"}`,
    }],
    isError: true,
  };
}
```

Add at the top of each write tool handler (6 locations):
- `create_page` handler
- `update_page` handler
- `update_page_section` handler
- `delete_page` handler
- `add_attachment` handler
- `add_drawio_diagram` handler

Any future write tool (comments, labels, move, copy, bulk operations) is automatically guarded because it won't be in `READ_ONLY_TOOLS`.

### 4. CLI Commands

**File:** `src/cli/profiles.ts`

- `--set-read-only <profile>` and `--set-read-write <profile>` subcommands
- Profile listing shows read-only status:
  ```
  Profile      URL                              Read-Only
  globex       https://globex.atlassian.net      no
  acme-corp    https://acme.atlassian.net        YES
  ```

**File:** `src/cli/setup.ts`

- Interactive prompt: "Enable writes for this profile? [y/N]" (default: no → read-only)
- Explicit flags: `--read-only` (default) and `--read-write` for non-interactive use
- Example: `epimethian-mcp setup --profile acme-corp --read-write`

### 5. Startup Log

**File:** `src/server/confluence-client.ts`

Update the startup log (line 172) to include read-only status:
```
epimethian-mcp: connected to https://acme.atlassian.net as user@acme.com (profile: acme-corp, READ-ONLY)
```

### 6. Future write tools are automatically gated

The whitelist pattern means any tool NOT in `READ_ONLY_TOOLS` is automatically blocked when `readOnly` is true. New write tools require no additional guard code — they just need to be omitted from the whitelist (which they are by default). Document this as a development invariant: **only add a tool to `READ_ONLY_TOOLS` if it makes zero mutations.**

## Error Message Design

When a write is blocked:
```
Write blocked: profile "acme-corp" is set to read-only.
To enable writes, run: epimethian-mcp profiles --set-read-write acme-corp
```

Returned as `isError: true` so the AI knows the operation failed and relays the message. The message intentionally omits the tenant hostname to avoid leaking tenant names into AI conversation logs.

## Testing Requirements

Target 80% coverage on all new code. Key test cases:

**Unit — `src/shared/profiles.ts`:**
- `getProfileSettings()` returns `readOnly: true` when set
- `getProfileSettings()` returns `undefined` for unknown profile
- `setProfileSettings()` persists and round-trips
- Permission check rejects world-writable registry file

**Unit — `src/server/confluence-client.ts`:**
- `getConfig()` sets `readOnly: true` when registry says read-only
- `getConfig()` sets `readOnly: true` when env var is `"true"`
- Strict-mode invariant: `CONFLUENCE_READ_ONLY=false` does NOT override registry read-only
- `getConfig()` sets `readOnly: false` when neither source says read-only

**Unit — `src/server/index.ts`:**
- Each of the 6 write tools returns `isError: true` when `readOnly` is true
- Each of the 7 read tools works normally when `readOnly` is true
- Write tools work normally when `readOnly` is false
- Error message includes profile name and remediation command

**Integration — `src/cli/setup.ts` and `src/cli/profiles.ts`:**
- `--set-read-only` / `--set-read-write` round-trip
- `setup --read-write` creates a writable profile
- `setup` without flag defaults to read-only
- Profile listing shows read-only status
- CLI warns about restarting running servers

## Decisions

1. **Default for new profiles: read-only.** The threat model describes cross-tenant writes as "catastrophic" and "contractually damaging." The secure default is read-only. The `setup` command prompts "Enable writes for this profile? [y/N]" and accepts `--read-write` as an explicit opt-in. Single-tenant users type one extra flag; multi-tenant consultants get protection by default.

2. **No `--confirm-write` mode.** A confirmation tool is a runtime toggle (Option D) in disguise — the AI can call the confirmation tool itself, and prompt injection can instruct it to do so. The MCP protocol has no mechanism to restrict which tools an agent calls. Binary read-only/read-write is simpler and more secure.

3. **`addLabel` (internal attribution) is exempt.** The `epimethian-managed` label is only called from within `createPage`/`updatePage`, which are themselves gated by the write guard. It is unreachable in read-only mode. If `addLabel` is ever exposed as a standalone tool, it must be excluded from `READ_ONLY_TOOLS`.

## Security Review Notes

This design was reviewed for security concerns. Key mitigations integrated above:
- **Whitelist pattern** instead of blacklist prevents future write tools from bypassing the guard (Finding 1)
- **Strict-mode OR merge** with pseudocode and unit test requirement prevents ambiguous precedence (Finding 2)
- **`[READ-ONLY]` tool description prefix** reduces prompt injection persuasion surface (Finding 3)
- **Advisory file locking** on registry read-modify-write prevents concurrent CLI race conditions (Finding 4)
- **Startup-only resolution** is documented with restart warning in CLI output (Finding 5)
- **Read-only default** for new profiles matches the threat model (Finding 6)
- **Permission verification** on registry read path guards against permission drift (Finding 7)
