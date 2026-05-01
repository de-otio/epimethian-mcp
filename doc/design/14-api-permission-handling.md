# 14 — API Token Permission Failures: Investigation & Design

## Problem Statement

Every tool in this MCP ultimately executes a Confluence REST call authenticated with the user's API token. That token inherits the authenticated user's permissions — which vary by space, by page, and by operation class (read, write, label, attachment, content state, admin). The server currently assumes the token has every permission it needs and discovers otherwise only at call time, when the operation fails mid-flight.

This document investigates what breaks when the token lacks a needed permission, treats **read-only tokens as a first-class supported deployment**, and proposes graceful handling so the MCP surfaces permission state clearly, fails predictably, and never silently drops transparency / provenance signals.

This is adjacent to [13 — Default "Unverified" Status on AI-Edited Pages](13-unverified-status.md), whose silent-failure concern (Security Consideration #1) is a specific instance of the general problem treated here.

---

## Background: Confluence Permissions in One Page

An Atlassian API token authenticates **as a user**; it does not carry separate scopes. Every REST call is evaluated against the authenticated user's permissions, which live at three layers:

| Layer | Examples | Rejection status |
|---|---|---|
| **Site-level** | "Use Confluence," admin | 401 or 403 |
| **Space-level** | View, add-page, edit-page, delete-page, add-attachment, add-label, space-admin | 403 (sometimes 404) |
| **Page-level (restrictions)** | View, edit, inherited + per-page overrides | 403 or 404 |

Important quirks:

- Confluence frequently returns **404** where HTTP semantics expect 403: if the token cannot *see* a page, it looks indistinguishable from a page that doesn't exist. This is deliberate (avoids enumeration leaks) but means "not found" error messages are often actually "not allowed."
- **Content states** (`/content/{id}/state`) require edit permission on the target page; some instances restrict it separately or do not implement the endpoint at all.
- **Label operations** use the legacy v1 API and have their own permission check, tighter than body edit in some configurations.
- **Attachments** require add-attachment, which some locked-down spaces withhold even from editors.
- **Comment creation** requires add-comment, orthogonal to page edit.

The result: "can this token do X" is not a single boolean. The MCP cannot assume uniform permission across operation classes.

---

## Read-Only Mode as a First-Class Configuration

Read-only is a **deployment posture the user chooses at the MCP profile level**, independent of what the API token itself supports. Two distinct rationales converge on the same treatment:

**Rationale A — the token is read-only.** A dedicated view-only Confluence user is the strongest defense-in-depth: no matter how the agent is persuaded (prompt injection, hallucination, buggy prompt), the API boundary refuses writes. For auditors, researchers, and consultants browsing client tenants, policy often *requires* this posture.

**Rationale B — the token has write access, but the user wants the MCP to behave read-only anyway.** Common scenarios:
- The user can only obtain a full-access personal API token from their Atlassian account (their organization does not issue purpose-scoped tokens).
- The same token is used for multiple tools/profiles, and this particular agent integration should be locked down to reads.
- A consultant is in an exploratory phase of an engagement and wants to guarantee they cannot accidentally mutate the client's Confluence, even if their token technically could.
- Defense-in-depth: restrict at the MCP layer even though the Confluence layer also grants read-only — belt and suspenders.

These rationales produce the **same effective mode**: the MCP exposes only read tools, the agent cannot attempt writes. The effective posture is `min(tokenCapability, configuredPosture)` — if either side says read-only, the MCP is read-only.

### Design commitments

1. **Write tools are not registered** when the server is in read-only mode, regardless of how that mode was reached (user config or detection). The agent's tool list is truthful.
2. **Posture is user-configurable independently of token capability.** A user with a write-capable token can pin the MCP to read-only; the setting wins over what the token could theoretically do. This is the primary mechanism — detection is a convenience fallback, not the source of truth.
3. **Posture is also detected** when the user hasn't decided. A startup probe infers read-only when the token provably lacks write permission. Users who did not configure anything are not punished; the server figures it out.
4. **`check_permissions` is always exposed**, in every mode. It reports both *token capability* and *configured posture* so the distinction is visible.
5. **Setup CLI asks upfront.** `epimethian-mcp setup <profile>` prompts the user to pick a posture, making the choice visible rather than buried in advanced config.
6. **Error messages distinguish deployment-level read-only from permission-level denial.** "This MCP profile is configured read-only; the `update_page` tool is unavailable" is a fundamentally different message from "This token lacks permission to update this page."

### Effective-mode resolution

```
profile posture (user config)    × token capability (probe)    = effective mode
───────────────────────────────────────────────────────────────────────────────
"read-only" (user pinned)        × any                          = read-only
"read-write" (user pinned)       × write-capable                = read-write
"read-write" (user pinned)       × read-only token              = read-write  *
"detect" (default)               × write-capable                = read-write
"detect" (default)               × read-only token              = read-only
"detect" (default)               × probe inconclusive           = read-write **

 * User explicitly opted out of read-only. Writes will fail at call time with
   remediation messaging (Level 1b). A startup warning flags the mismatch but
   does not override the user's choice.
** Preserves current behavior when detection cannot confirm. A visible warning
   tells the user the probe could not determine capability.
```

The `profile posture` setting is a tri-state: `"read-only"` | `"read-write"` | `"detect"` (default). Env var `CONFLUENCE_READ_ONLY=true|false` maps to the first two; anything else (or unset) is `"detect"`.

### Tool surface in read-only mode

Registered tools (the existing `READ_ONLY_TOOLS` allowlist plus the new `check_permissions`):

- All `get_*` read tools (`get_page`, `get_spaces`, `get_comments`, `get_attachments`, `get_labels`, `get_page_status`, `get_page_versions`, `get_page_version`, `get_page_children`, `get_page_by_title`)
- Search and list (`search_pages`, `list_pages`, `resolve_page_link`, `diff_page_versions`, `lookup_user`)
- `check_permissions` — always available

Write tools (`create_page`, `update_page`, `append_to_page`, `prepend_to_page`, `update_page_section`, `delete_page`, `add_drawio_diagram`, `revert_page`, `add_attachment`, `add_label`, `remove_label`, `create_comment`, `delete_comment`, `resolve_comment`, `set_page_status`, `remove_page_status`) are **not registered**.

`writeGuard` remains as a belt-and-suspenders runtime check for the rare case where registration was bypassed (tests, dev harness) — but it is no longer the primary enforcement mechanism.

---

## Current State

### Auth & config

- API token is loaded at startup from the OS keychain (profile-scoped) or from three env vars for CI use — [src/server/confluence-client.ts:81–146](../../src/server/confluence-client.ts#L81-L146).
- Basic auth header is computed once and cached — [src/server/confluence-client.ts:148–194](../../src/server/confluence-client.ts#L148-L194).
- Startup validation (`validateStartup`, [src/server/confluence-client.ts:204–256](../../src/server/confluence-client.ts#L204-L256)) authenticates the token and verifies tenant identity. It does **not** test permissions: no probe ever asks "can this token write?" or "can it add labels?"

### Error handling pipeline

- Every non-2xx response throws `ConfluenceApiError(status, body)` — [src/server/confluence-client.ts:524–557](../../src/server/confluence-client.ts#L524-L557).
- All tool handlers collapse this into `Error: Confluence API error (<status>)`. There is **no distinction** between 401 / 403 / 404.
- Three tools (`get_page_versions`, `get_page_version`, `diff_page_versions`) rewrite 403/404 to `"Page not found or inaccessible"` — [src/server/index.ts:1887–1890, 1936–1939, 2065–2068](../../src/server/index.ts#L1887). Softer, but still conflates "missing" with "forbidden."

### Read-only mode

- Configured via profile setting `readOnly: true` or env var `CONFLUENCE_READ_ONLY=true` — [src/server/confluence-client.ts:154–159](../../src/server/confluence-client.ts#L154-L159). Either enabling wins.
- Enforced by `writeGuard(toolName, config)` at the top of every write handler, checking a hardcoded `READ_ONLY_TOOLS` allowlist — [src/server/index.ts:174–202](../../src/server/index.ts#L174-L202). **All tools are still registered**; writes are rejected at call time rather than hidden from the tool list.
- **Critical gap:** this is a declared flag, not a detected capability. A token that is effectively read-only (writes return 403) but was not configured as such exposes every write tool to the agent. The agent will attempt them and fail loudly on every call.

### Permission-sensitive paths already in the code

| Path | Graceful? |
|---|---|
| `getContentState` returns `null` on 404 — [src/server/confluence-client.ts:1100–1106](../../src/server/confluence-client.ts#L1100) | ✓ good pattern |
| `removeContentState` ignores 404 / 409 (idempotent) — [src/server/confluence-client.ts:1123–1133](../../src/server/confluence-client.ts#L1123) | ✓ |
| `ensureAttributionLabel` wraps ops in `try { … } catch { /* non-critical */ }` | ✗ **silent** |
| `get_page_versions` / `get_page_version` / `diff_page_versions` rewrite 403/404 → "not found or inaccessible" | ~ ambiguous |
| Everything else | ✗ raw error passthrough |

---

## What Breaks When Permissions Are Insufficient

### Class A — Read-only token (supported deployment, handled poorly today)

Many users **will** configure a read-only token by choice. Today they can set `CONFLUENCE_READ_ONLY=true` manually, but:
- If they forget the flag, every write tool appears in the agent's tool list and returns `Confluence API error (403)` on invocation. The agent does not know the token is read-only; it treats each failure as a transient error.
- There is no startup signal that the token is read-only. No log line, no banner, no `check_permissions` tool to call.
- The setup CLI does not ask whether this is a read-only token.

This is not a bug in the permission model — it is a UX and tool-surface gap. See [Read-Only Tokens as a First-Class Use Case](#read-only-tokens-as-a-first-class-use-case) above for the proposed treatment.

### Class B — Write-capable token lacking specialized permissions

The insidious case. Token has edit permission on pages, but:
- **No label permission**: every page write succeeds, but `ensureAttributionLabel` silently fails. The `epimethian-edited` label — the page-level provenance signal from [12](12-model-attribution.md) — is missing with no warning.
- **No content-state permission** (or the instance doesn't support content states): the proposed [#13](13-unverified-status.md) `markPageUnverified` fails silently by design. Every AI-edited page appears un-badged, defeating the transparency feature.
- **No add-comment permission**: `create_comment` fails with generic 403.
- **No add-attachment permission**: `add_attachment` fails; `add_drawio_diagram` can fail halfway, after the diagram has been constructed.

The agent has no way to discover these short of hitting them. And for the first two — the transparency signals — *nobody* discovers them because the failure is silent.

### Class C — Multi-call cascade failures

11 tools make more than one HTTP call. Partial failure leaves Confluence in an inconsistent state with no automatic rollback.

| Tool | Calls | Failure mode |
|---|---|---|
| `create_page` | resolveSpace → create → ensureLabel | Page created, label silently missing |
| `update_page` | get → update → ensureLabel | Page updated, label silently missing |
| `update_page_section` | same as update | same |
| `add_drawio_diagram` | get → upload → update | Attachment uploaded but page update fails → orphan |
| `revert_page` | get → getVersion → update → ensureLabel | Reverted body written, label missing |
| `get_page_by_title` | resolveSpace → search | Fails entirely if resolveSpace fails |
| `set_page_status` | getContentState → setContentState | Get succeeds, set fails with raw 403 |
| `get_comments` (with `include_replies`) | list → N× replies | **One reply 403 fails the whole call** (Promise.all) |
| `diff_page_versions` | getPage → getVersion v1 → getVersion v2 | Fails entirely if any call fails |

### Class D — Silent failure of transparency signals

Already called out but worth naming as a class of its own:

- `ensureAttributionLabel` swallowing 403 means the `epimethian-edited` label is unreliable.
- `markPageUnverified` (#13) would behave the same way by its current design.

For features whose *purpose* is governance, "fail-open silently" is the worst possible behavior: the system appears to work; the property it guarantees is absent.

### Class E — Poor error UX

- `Error: Confluence API error (403): {…}` doesn't tell the agent *which* permission is missing or how to remediate.
- 401 (invalid token) reads identically to 403 (permission denied); the agent cannot distinguish "typed wrong" from "typed right but no permission."
- A 404 that is actually a permission rejection can cause the agent to take a destructive follow-up (e.g. "create it instead" when the page exists but is hidden).

---

## Proposed Graceful Handling

Three levels of investment. V1 commits to Level 1.

### Level 1 — Ship in v1

> **Status: shipped in v6.1.0.** The implementation follows this design. Sections below describe the target behaviour; the `What Breaks` discussion above describes the pre-6.1.0 state.

#### 1a. Error subclasses

Add to `src/server/confluence-client.ts`:

```ts
export class ConfluenceAuthError extends ConfluenceApiError {}        // 401
export class ConfluencePermissionError extends ConfluenceApiError {}  // 403
export class ConfluenceNotFoundError extends ConfluenceApiError {}    // 404
```

`confluenceRequest` branches on status. Existing `ConfluenceApiError` remains for all other non-2xx codes.

#### 1b. Remediation-oriented tool error messages

`toolError()` maps subclasses to user-facing guidance:

| Error | Message |
|---|---|
| `ConfluenceAuthError` | `"Your Confluence API token is invalid or expired. Reauthenticate with `epimethian-mcp login <profile>`."` |
| `ConfluencePermissionError` | `"Your token lacks permission for <operation> on <resource>. The operation was not performed."` |
| `ConfluenceNotFoundError` | `"Resource not found. Confluence returns 'not found' when a token cannot see a resource due to restrictions — verify access."` |

Tool handlers pass operation + resource context when constructing errors.

#### 1c. Loud failures for governance signals

Remove the silent `catch { /* non-critical */ }` on `ensureAttributionLabel`. Replace with a warning surfaced in the tool response:

```
✓ Page 12345 created.
⚠ Warning: could not apply 'epimethian-edited' label (permission denied).
  Provenance label is missing for this page. Contact a space admin if needed.
```

Same pattern for `markPageUnverified` ([#13](13-unverified-status.md) Security Consideration #1 — this section is the general solution).

**This is the single most important change in the document.** It turns two silent-failure security bugs into loud, user-visible warnings at near-zero engineering cost.

#### 1d. `Promise.allSettled` for `get_comments` replies

In the reply loop at [src/server/index.ts:1673–1682](../../src/server/index.ts#L1673):

```ts
const results = await Promise.allSettled(
  topLevel.map(c => getCommentReplies(c.id))
);
const replies = results.map((r, i) =>
  r.status === "fulfilled" ? r.value : { commentId: topLevel[i].id, error: r.reason }
);
```

Return partial results with per-comment notes when a reply fetch was denied.

#### 1e. Read-only detection and conditional tool registration

On startup, after `validateStartup`:

1. If `config.readOnly === true` (config or env): set `effectiveReadOnly = true`; skip the probe.
2. If `config.readOnly === false` (explicitly write): set `effectiveReadOnly = false`; skip the probe.
3. Otherwise run the **minimal probe** (see 1f). Set `effectiveReadOnly` based on the result.

Tool registration in `src/server/index.ts` is then gated on `effectiveReadOnly`:

```ts
// read tools — always registered
server.registerTool("get_page", …);
server.registerTool("check_permissions", …);   // always, in every mode
// … more reads …

if (!config.effectiveReadOnly) {
  server.registerTool("create_page", …);
  server.registerTool("update_page", …);
  // … all writes …
}
```

The agent's tool list is now truthful: read-only deployments expose only the tools that actually work. `writeGuard` remains as a runtime fallback but ceases to be the primary enforcement.

A startup log line announces the mode:

```
[epimethian-mcp] Profile "acme-prod" — mode: read-only (detected via probe).
  Write tools are not exposed. Set CONFLUENCE_READ_ONLY=false to override.
```

#### 1f. Minimal startup probe (write detection)

Purpose: determine whether the token can write. One cheap call.

Approach: attempt a **known-safe no-op write** against a sentinel resource, or query a capability-reporting endpoint. Two candidates:

- `GET /wiki/rest/api/user/current/permission/space/{spaceKey}` — returns a list of operations the current user is permitted for in a space. Requires picking a target space (the first from `getSpaces()`, or a configured one).
- `PUT /wiki/api/v2/pages/{nonexistent}` with an intentionally bad body — inspect the status: 401 = token invalid; 403 = no write; 404 = write permission exists but page missing; 400 = write permission exists, body malformed.

The first is cleaner; the second requires no target space. Prefer the first when spaces are listable, fall back to the second.

Probe outcomes:
- Definitive **write-ok** → `effectiveReadOnly = false`.
- Definitive **no-write** → `effectiveReadOnly = true`; log a banner.
- **Inconclusive** (probe endpoint returned a 4xx/5xx we can't interpret) → `effectiveReadOnly = false` (preserve current behavior) **and** warn the user that detection failed.

The probe adds ~1 API call to startup. Acceptable.

#### 1g. `check_permissions` tool (exposed, always available)

A read-only tool, always registered regardless of mode. Reports **both** the configured MCP posture and the token's underlying capability, so the distinction between "user asked for read-only" and "token can't write" is visible:

```jsonc
{
  "profile": "acme-prod",
  "user": { "email": "ai-readonly@acme.example", "accountId": "…" },
  "posture": {
    "effective": "read-only",
    "configured": "read-only",            // user's choice: "read-only" | "read-write" | "detect"
    "source": "profile"                   // "profile" | "env" | "probe" | "default"
  },
  "tokenCapability": {
    "authenticated": true,
    "listSpaces": true,
    "readPages": true,
    "writePages": true,                   // the token CAN write, but the profile is pinned read-only
    "addLabels": "unknown",
    "setContentState": "unknown",
    "addAttachments": "unknown",
    "addComments": "unknown"
  },
  "notes": [
    "This profile is pinned to read-only mode by user configuration. The underlying token has write access, but write tools are not exposed to the agent."
  ]
}
```

The response makes the common configurations legible:
- Read-only token + read-only profile → both fields agree; notes confirm it.
- Write token + read-only profile → the mismatch is visible; user sees they are intentionally holding back.
- Write token + read-write profile → both fields agree; full capability exposed.
- Read-only token + read-write profile → mismatch flagged as a warning; writes will fail at call time.

Why a tool rather than just a CLI: the agent needs to self-diagnose. An agent that begins a session with *"what can I do with this profile?"* via `check_permissions` can plan appropriately, avoid impossible operations, and explain the setup to the user. A CLI wrapper (`epimethian-mcp permissions <profile>`) wraps the same underlying probe for operator diagnostic use.

#### 1h. Setup CLI prompt

In `src/cli/setup.ts`, during profile creation — framed as choosing an MCP-level posture, not reporting on the token:

```
MCP access mode for this profile:
  [1] Read-only — the agent cannot modify Confluence through this profile,
                  regardless of what the API token can do. Recommended for
                  untrusted agents, exploratory work, and defense-in-depth.
  [2] Read-write — the agent can create, update, and delete pages.
  [3] Detect at startup — infer from the token's actual permissions.
Your choice [default: 1]:
```

Default is `[1] Read-only`. The user's choice writes `posture: "read-only" | "read-write" | "detect"` to the profile. Encouraging read-only as the default nudges users toward the safer posture even when their token has more capability.

### Level 2 — Follow-up

#### 2a. Lazy capability cache

Module-level `capabilityCache: Record<Capability, boolean>`. Operations that can fail for permission reasons other than plain write (labels, content states, attachments, comments) consult the cache before attempting, and update it on `ConfluencePermissionError`.

After the first permission denial for labels, subsequent page writes skip the label attempt entirely. `check_permissions` reflects the updated cache.

Not in v1 because it adds state-management complexity. Level 1's loud warnings already solve the immediate UX problem; the cache is a polish step.

#### 2b. Extended startup probe (fine-grained capabilities)

Optional (`CONFLUENCE_PROBE_EXTENDED=true`). Issues probe calls for labels, content state, attachments, comments. Fills `capabilities` exactly instead of starting with `"unknown"`. Trade-off: more startup latency, more API calls, some endpoints rate-limited.

#### 2c. `autoReadOnlyOnDenial` (session-scoped)

If a write tool receives 403 during a session, and Level 2a's cache flips to "writes-denied," optionally disable write tools for the remainder of the session. More aggressive than v1; appropriate once the loud warnings show it is needed.

### Level 3 — Structural (not planned)

- Transactional multi-call tool contracts with partial-success return shapes.
- Explicit rollback on mid-chain failure (e.g. delete the orphan attachment when `add_drawio_diagram` fails at the page-update step).
- This is a substantial ergonomic change to the tool contract; out of scope for now.

---

## Recommendation for v1

Ship Level 1 in full (1a through 1h). That means:

- Three error subclasses with remediation messaging.
- Loud warnings for missing label and missing unverified-status badge — eliminates the silent-failure security bugs in one stroke.
- Partial-success semantics for `get_comments` replies.
- **Read-only mode as a first-class, auto-detected deployment**: startup probe, conditional tool registration, visible banner, setup-CLI prompt.
- `check_permissions` tool exposed in every mode, plus a CLI wrapper.

Level 2a (lazy capability cache) and 2b (extended probe) can ship in a follow-up once Level 1 has flushed out the UX.

---

## Files Affected (Level 1)

| File | Change |
|---|---|
| `src/server/confluence-client.ts` | Add `ConfluenceAuthError` / `ConfluencePermissionError` / `ConfluenceNotFoundError`. Branch in `confluenceRequest`. Update `ensureAttributionLabel` to raise a warning instead of swallowing. Add `probeWriteCapability()` helper called from `validateStartup`. |
| `src/server/index.ts` | Update `toolError` for subclass-specific remediation messages. Gate write-tool `registerTool` calls on `!effectiveReadOnly`. Always register `check_permissions`. Swap `get_comments` reply fetch to `Promise.allSettled`. Surface attribution / badge warnings in tool response text. |
| `src/server/check-permissions.ts` (new) | Implementation of the `check_permissions` tool — builds the JSON payload from probe + cache + config. |
| `src/server/provenance.ts` (from #13) | `markPageUnverified` surfaces warning on permission failure; consults capability cache once Level 2a ships. |
| `src/cli/setup.ts` | New prompt for posture (read-only / read-write / detect). New CLI subcommand `epimethian-mcp permissions <profile>`. |
| `src/server/config.ts` | Profile schema `posture: z.enum(["read-only","read-write","detect"]).default("detect")`. Legacy `readOnly: boolean` remains as an alias for backward compatibility. |
| `src/server/confluence-client.test.ts` | Tests: each error subclass for the right status; `probeWriteCapability` outcomes; `ensureAttributionLabel` warning path. |
| `src/server/index.test.ts` | Tests: read-only mode unregisters write tools; `check_permissions` returns correct payload per mode; `get_comments` partial-success with per-reply error. |
| `doc/design/03-tools.md` | Document permission requirements per tool. Add `check_permissions`. |
| `README.md` | Prominent section: "Using a read-only token" — recommended posture, how to configure, how `check_permissions` surfaces the current state. |

---

## Open Questions

1. **Probe endpoint choice** — `GET /permission/space/{key}` or a dry-run `PUT`? The first is more structured but requires a target space; the second is space-less but more hacky. **Proposal:** try the first, fall back to the second if `getSpaces()` returns nothing. Worth a quick spike against a real tenant before locking this in.

2. ~~**Should `autoReadOnlyOnDenial` be enabled by default?**~~ **Resolved for v1:** read-only auto-detection at *startup* is default-on. Session-scoped auto-read-only after runtime denials is deferred to Level 2c.

3. **Should the capability cache persist across restarts?** Would avoid re-learning. Downsides: stale data when permissions change server-side; troubleshooting pain. **Proposal:** no, keep process-lifetime.

4. **How should remediation messages handle Confluence Data Center quirks?** Some endpoints (content-state, newer v2 paths) don't exist on all versions. **Proposal:** document the assumption (Cloud-first); distinguish `404 on endpoint` from `404 on resource` in the error pipeline. A 405 Method Not Allowed should be routed to a new `ConfluenceUnsupportedError` so the UX reads "your Confluence version does not support this" rather than "permission denied."

5. ~~**`check_permissions` as MCP tool or CLI?**~~ **Resolved:** both. The tool is primary (agent self-diagnosis); the CLI wrapper (`epimethian-mcp permissions <profile>`) uses the same probe for operator diagnostic use.

6. **Permission changes during a long session.** Out of scope; the process-lifetime cache assumes permissions are stable for session duration. Documented as a limitation.

7. **How loud should the read-only banner be?** Proposal: one startup log line + one-time note in the first tool response of the session (`[epimethian-mcp] This profile is read-only; write tools are not exposed.`). Visible without being repetitive. When the posture is user-pinned (rather than detected), include the reason: `"This profile is pinned to read-only mode — the token has write access but writes are disabled by configuration."`

8. **Should read-only profiles also hide the `write-related getters` that have no meaning without writes** (e.g. `get_page_versions` is fine read-only, but is a profile that reads version history without writing a common real case)? **Proposal:** no — keep all read tools registered in read-only mode. The simpler rule is easier to reason about.

9. **Partial-restriction policies** (e.g. "read-only except comments")? Out of scope for v1. The posture is a binary read-only / read-write. Users who want finer-grained restrictions can use separate profiles with different tokens and postures. Revisit if the demand pattern emerges.

10. **Startup warning when user pins read-write but token is read-only** — worth the extra friction, or just let writes fail at call time? **Proposal:** emit a single visible warning at startup (`"Profile is configured read-write but the token's write capability could not be confirmed — writes will likely fail"`). Does not override the user's choice, just surfaces the mismatch.
