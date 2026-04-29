# Plan: Implement OpenCode compatibility (and other elicitation-less clients)

Source analysis: [doc/design/investigations/investigate-opencode-compatibility.md](../doc/design/investigations/investigate-opencode-compatibility.md)
(2026-04-29).

The investigation recommended a 2-phase rollout: first **(C+F)** a setup-CLI
improvement plus tool-description awareness, then **(A)** soft elicitation
via tool-result errors with diff-bound confirmation tokens. This plan turns
both phases into discrete, parallelisable tasks with frozen API contracts so
agents can work concurrently without cross-coordination.

Verified against tree at commit `d793ab1`, package `6.4.1`, 1696 tests
passing.

**Security review:** 2026-04-29 (security-reviewer agent). Two HIGH
findings (cloudId binding, BYPASS precedence) and five MEDIUM
findings (TOCTOU on concurrent retries, timing side-channel,
humanSummary exfil channel, mint-rate ceiling, version-keyed
OpenCode snippet) integrated as binding amendments to §§3.2, 3.4,
3.5, 3.6, 4.2, 5.6, 5.9, and 10. All four LOW findings also
integrated. The plan rejects no recommendation; every splice is
applied verbatim or in a strictly-stronger form.

---

## 1. Version sequencing

- **6.5.0 (minor)** — Phase 1: setup-CLI per-client onboarding (option C)
  + tool-description awareness (option F). Pure additive; existing setup
  flow unchanged; new `--client` flag opt-in.
- **6.6.0 (minor)** — Phase 2: soft elicitation via tool-result errors
  with confirmation tokens (option A). New behaviour, but the existing
  fail-closed default is preserved when neither
  `EPIMETHIAN_ALLOW_UNGATED_WRITES` nor the new soft-elicitation path is
  active for the connecting client. Soft elicitation triggers
  *automatically* when the client lacks elicitation; the user's
  `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` override (if set) takes
  precedence and silences soft elicitation too.
- **(Outside this plan, file in parallel)** — open an issue at
  <https://github.com/sst/opencode> requesting elicitation support, with
  a link to the soft-elicitation design as the interim solution.

Each phase ships independently. 6.5.0 alone improves install UX
significantly; 6.6.0 closes the safety gap.

---

## 2. Parallelism strategy

The user has a standing preference for **maximum parallelism**. Both
phases are designed so that all tasks within a phase can run
concurrently (same git worktree) once the API contracts in §3 are
frozen. With the contracts agreed, no task depends on another task's
output during implementation — only the final verification step is
serial.

Per the project's RAM-vs-parallelism memory, each agent is told **not**
to run `npm test` itself; the orchestrator runs verification once at
the end of each phase. This drops per-agent memory cost from ~3–4 GB
(full vitest pool) to a few hundred MB and lifts the cap from ~3
parallel agents to "as many as the task split warrants".

For this plan: **Phase 1 = 4 parallel agents; Phase 2 = 7 parallel
agents**. Models are assigned per task complexity (opus for the
data-loss-sensitive token semantics, sonnet for handler edits, haiku
for description text and config tables).

---

## 3. Frozen API contracts (must be agreed before dispatch)

These contracts let parallel agents work without coordination. **Any
agent that wants to deviate from a frozen contract must stop and ask
first** — silent divergence will break the integration step.

### 3.1 `src/cli/client-configs.ts` (Phase 1, new file)

```ts
export interface ClientConfigEntry {
  /** Stable id used as the --client value (e.g. "opencode"). */
  id: string;
  /** Human-readable display name (e.g. "OpenCode"). */
  displayName: string;
  /** Path hint shown to the user (e.g. "opencode.json or ~/.config/opencode/opencode.json"). */
  configFileHint: string;
  /** JSON template with {{PROFILE}} and {{BIN}} placeholders. */
  template: string;
  /** Optional safety warning rendered after the template. */
  warning?: string;
}

export const CLIENT_CONFIGS: readonly ClientConfigEntry[] = [
  /* claude-code, claude-desktop, claude-code-vscode, cursor, windsurf, zed, opencode */
];

export function renderConfigSnippet(
  clientId: string,
  profile: string,
  binPath: string,
): { snippet: string; warning?: string };

export function knownClientIds(): readonly string[];
```

`renderConfigSnippet` throws on unknown `clientId`; tests pin the error
message format.

### 3.2 `src/server/confirmation-tokens.ts` (Phase 2, new file)

```ts
export interface ConfirmationContext {
  /** Tool that minted the token (must match on validation). */
  tool: string;
  /**
   * Confluence cloudId of the tenant the token was minted against.
   * Sourced from the live tenant-seal in confluence-client.ts. Mismatch
   * on validate is treated as token-invalid — protects against
   * profile/tenant flips mid-session in long-lived MCP host processes.
   */
  cloudId: string;
  /** Page ID the token applies to. */
  pageId: string;
  /**
   * The page's version.number AT MINT TIME. Bound into the diffHash
   * inputs so a token minted for "apply diff X on top of v7" cannot
   * validate after the page has advanced past v7.
   */
  pageVersion: number;
  /**
   * Stable SHA-256 hash of the canonical post-prepare storage XML
   * (i.e. the exact bytes that were about to be PUT) plus pageVersion.
   * Computed via the shared `computeDiffHash` helper.
   */
  diffHash: string;
}

export interface ConfirmationToken {
  /** Opaque, ~24 bytes base64url. NEVER logged in full. */
  token: string;
  /** Stable per-mint UUID used for audit log correlation in place of the token. */
  auditId: string;
  /** ms since epoch */
  expiresAt: number;
}

/** Default TTL for new tokens. Clamped to [60_000, 900_000] ms (1–15 min). */
export const DEFAULT_SOFT_CONFIRM_TTL_MS: number;

/** Hard caps to bound abuse and memory use. */
export const MAX_OUTSTANDING_TOKENS = 50;       // FIFO-evict on overflow
export const MAX_MINTS_PER_15_MIN = 100;        // window matches write-budget rolling window
                                                 // overridable via env EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT
                                                 // ("0" = disable cap)

/**
 * Mint a fresh token bound to the given context. Throws
 * `SOFT_CONFIRM_RATE_LIMITED` if the 15-minute mint cap is hit.
 * The chosen TTL is clamped to [60_000, 900_000] ms regardless of
 * input. Caller never sees the raw randomness — `auditId` is used
 * for cross-system correlation.
 */
export function mintToken(ctx: ConfirmationContext, ttlMs?: number): ConfirmationToken;

/**
 * Validate a token against the context.
 *
 * The function ALWAYS takes a minimum 5 ms wall time before
 * returning, regardless of outcome — the lookup itself is in a JS
 * Map (early-exit on key prefix), so a fixed-floor sleep removes the
 * timing-side-channel that would otherwise distinguish hit / miss /
 * expired / mismatch.
 *
 * Returns ONLY two outcomes externally:
 *  - "ok"      — token exists, matches ctx (tool + cloudId + pageId +
 *               pageVersion + diffHash), not expired, no competing
 *               write since mint. Token is consumed (single-use) AND
 *               every other outstanding token for the same {cloudId,
 *               pageId} is invalidated atomically (closes the
 *               concurrent-retries TOCTOU window).
 *  - "invalid" — every other case (unknown, expired, stale,
 *               mismatch). The specific reason is recorded only in
 *               the audit log via `onValidate`. External callers see
 *               one bucket — distinguishing them at the API layer
 *               leaks a token-state oracle.
 */
export function validateToken(
  token: string,
  ctx: ConfirmationContext,
): Promise<"ok" | "invalid">;

/**
 * Invalidate every token bound to this {cloudId, pageId}. Called from
 * the safe-write success path AND from the validateToken success path
 * (consume-and-invalidate-page atomically).
 */
export function invalidateForPage(cloudId: string, pageId: string): void;

/** Testing-only reset. */
export function _resetForTest(): void;

/**
 * Write-only audit hooks. Implementers register these to ship to the
 * mutation log; the module never reads back from them. Replaces the
 * earlier `_peekToken` proposal — diagnostics flow through these
 * hooks only, never through a public read API.
 */
export function onMint(handler: (meta: AuditMintMeta) => void): void;
export function onValidate(handler: (meta: AuditValidateMeta) => void): void;

export interface AuditMintMeta {
  auditId: string;
  tool: string;
  cloudId: string;
  pageId: string;
  pageVersion: number;
  expiresAt: number;
  outstanding: number;
}

export interface AuditValidateMeta {
  auditId: string | undefined;          // undefined when token is unknown
  tool: string;
  cloudId: string;
  pageId: string;
  outcome: "ok" | "unknown" | "expired" | "stale" | "mismatch";
  // External callers see only "ok" or "invalid" — this field exists
  // for postmortem only and is never returned by validateToken.
}

/**
 * Stable SHA-256 of `${canonicalStorageXml}\n${pageVersion}`, hex-
 * encoded. Two outputs differ if the storage XML differs by even one
 * byte OR if the page version differs. Shared between mint and
 * validate sites so the binding is deterministic.
 */
export function computeDiffHash(canonicalStorageXml: string, pageVersion: number): string;
```

**Security notes (binding on implementer):**

1. Tokens are **single-use** — a successful `validateToken("ok")`
   removes the token from the store. Replay returns `"invalid"`.
2. Tokens **never appear** in error messages, log output, audit
   records, stderr, telemetry, or `console.error` — not even
   redacted as first-4-last-4. The audit trail uses a per-mint UUID
   (`auditId`) for correlation. The full integration suite asserts
   no full-token byte sequence appears in captured stderr.
3. The token store is **process-local in-memory** — no cross-process
   sharing. A server restart invalidates all tokens. The store is
   capped at `MAX_OUTSTANDING_TOKENS` (50) entries; FIFO-evict on
   overflow. Mint-rate is capped at `MAX_MINTS_PER_15_MIN` (100);
   over-budget mints throw `SOFT_CONFIRM_RATE_LIMITED`.
4. The TTL clock is `Date.now()`. The TTL value is clamped to
   `[60_000, 900_000]` ms (1–15 minutes); values outside this range
   are silently clamped, not rejected (avoids surfacing a config-
   value oracle). Tests use `vi.useFakeTimers()`.
5. Token comparison runs with a **minimum 5 ms wall-time floor**
   regardless of outcome (uses `Promise.race`-style timing or a
   simple `await sleep(...)` to a wall-clock target). The Map lookup
   itself is hash-based and would otherwise leak hit/miss timing on a
   colocated attacker.
6. Tokens are bound to **all five fields** of `ConfirmationContext`
   (`tool`, `cloudId`, `pageId`, `pageVersion`, `diffHash`). Mismatch
   on any one is `"invalid"`. The `cloudId` field protects against
   the multi-tenant "profile flip mid-session" replay vector.
7. The successful-validate path **invalidates every other
   outstanding token** for the same `{cloudId, pageId}` atomically.
   This closes the concurrent-retries TOCTOU window — two retries
   minted off the same head version cannot both validate.
8. `validateToken` returns `Promise<"ok" | "invalid">` — only two
   external outcomes. The fine-grained reasons (`unknown`,
   `expired`, `stale`, `mismatch`) flow into `AuditValidateMeta`
   only, never to the caller. This prevents a token-state oracle
   that would let an attacker enumerate the store.
9. There is no public introspection API. The earlier `_peekToken`
   proposal is replaced by write-only `onMint` / `onValidate` hooks.
10. `randomBytes(24).toString("base64url")` is preferred over
    `crypto.randomUUID()` — UUIDs leak version/variant nibbles that
    would otherwise be entropy.

### 3.3 New error code: `SOFT_CONFIRMATION_REQUIRED`

Added to `src/server/elicitation.ts`. Replaces (in the soft-mode
branch only) the throw of `ELICITATION_REQUIRED_BUT_UNAVAILABLE`. The
error carries:

```ts
class SoftConfirmationRequiredError extends GatedOperationError {
  readonly token: string;
  readonly expiresAt: number;
  readonly humanSummary: string;   // e.g. "remove 1 TOC macro and 8 link macros"
  readonly retryHint: string;      // exact param shape the agent must use on retry
}
```

The `index.ts` handler catches this and emits `isError: true` with a
structured message (see §3.5).

### 3.4 Soft-mode trigger — explicit precedence

`gateOperation`'s branches are evaluated in this exact order. The
first matching branch wins; later branches do not run. Implementers
MUST preserve this ordering and add a unit test that walks the
matrix.

| # | Condition | Branch |
|---|---|---|
| 1 | `EPIMETHIAN_BYPASS_ELICITATION === "true"` | bypass (existing — for clients that fake elicitation support) |
| 2 | `EPIMETHIAN_ALLOW_UNGATED_WRITES === "true"` AND `!clientSupportsElicitation(server)` | bypass (existing — operator opt-out for elicitation-less clients) |
| 3 | `EPIMETHIAN_DISABLE_SOFT_CONFIRM === "true"` AND `!clientSupportsElicitation(server)` | throw `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (legacy fail-closed; for users who want the old behaviour back) |
| 4 | `!clientSupportsElicitation(server)` AND `pageId` AND `cloudId` AND `pageVersion` AND `diffHash` all present | mint token, throw `SoftConfirmationRequiredError` (NEW soft-elicitation path) |
| 5 | `!clientSupportsElicitation(server)` AND any required mint input missing | throw `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (fail closed — refuse rather than silently bypass) |
| 6 | otherwise (client supports elicitation) | real elicitation request (existing) |

**Startup-time warning.** When `EPIMETHIAN_BYPASS_ELICITATION === "true"`
AND the connecting client does NOT advertise elicitation, log a
`console.error` warning at the next `gateOperation` invocation:
*"BYPASS_ELICITATION is set, but the connected client does not advertise
elicitation support. The intended use of BYPASS_ELICITATION is for
clients that falsely advertise the capability and never honour requests.
For clients that don't advertise it (e.g. OpenCode), set
EPIMETHIAN_ALLOW_UNGATED_WRITES instead, or upgrade to v6.6.0 to
benefit from soft elicitation."* This catches the most common
misconfiguration without changing behaviour.

When NOT triggered (because the user opted out via the new disable
var, or the bypass / allow vars are set): existing behaviour.

### 3.5 Tool-result shape for `SOFT_CONFIRMATION_REQUIRED`

The full token is returned in **`structuredContent.confirm_token`**
(per the MCP 2025-11-25 spec's structured output channel), NOT in the
free-text content. The visible message shows only the last 8 chars
of the token for human reference; the agent reads the full value
from `structuredContent` programmatically. This keeps the token out
of the agent's free-text scratchpad, which on multi-tenant agent
platforms is often logged to disk or telemetry.

```
isError: true
structuredContent:
  {
    confirm_token: "<full token, opaque>",
    audit_id: "<UUID for postmortem correlation>",
    expires_at: "<ISO timestamp>",
    page_id: "<pageId>",
    deletion_summary: { tocs: 1, links: 8, ... }   // counts only — see invariant below
  }
content[0].text:
  ⚠️  Confirmation required (SOFT_CONFIRMATION_REQUIRED)

  {humanSummary}

  Your MCP client does not support in-protocol elicitation. This
  confirmation is being routed through you (the agent). Please ASK
  THE USER before retrying. If the user approves, re-call this tool
  with the same parameters plus the `confirm_token` from
  structuredContent.

  Token tail: ...{last8}    Expires: {ISO}    Audit ID: {auditId}

  The token is single-use, bound to this exact diff and page version,
  and invalidated by any competing write to this page. If validation
  fails, mint a new one by re-calling without `confirm_token`.
```

**`humanSummary` content invariant (binding).** `humanSummary` is
generated **solely** from numeric counts in `DeletionSummary` (the
{tocs, links, codeMacros, structuredMacros, plainElements, other}
shape from A2). NO page content, attribute value, CDATA body, user
display name, or other tenant-controlled string is ever interpolated
into `humanSummary`. This closes the prompt-injection exfil channel
that an attacker who plants malicious storage XML would otherwise
have. Implementer must add a test fixture: a page with
attacker-controlled content in every macro field, asserting that
none of it appears in the resulting `humanSummary`.

**Token-failure error code (single bucket).** All four token-failure
reasons (`stale`, `expired`, `mismatch`, `unknown`) collapse to the
external code `CONFIRMATION_TOKEN_INVALID`. The actual reason is
recorded only in the audit-log via `onValidate` — never in the tool
result. This prevents a token-state oracle. The error message text
also stays generic: *"The confirmation token is no longer valid.
Mint a new one by re-calling this tool without `confirm_token`,
ask the user again, then retry with the new token."*

This text is **directed at the agent**, not the user. The agent reads
it, asks the user in its own chat surface, and re-calls.

### 3.6 Abuse-rate ceilings & resource caps

To prevent a prompt-injected agent from minting tokens in a tight
loop (each call returns `isError: true` and consumes memory + audit
trail entries), the token store enforces:

- **`MAX_OUTSTANDING_TOKENS = 50`.** When a 51st mint is attempted,
  the FIFO-oldest token is evicted from the store. Eviction is
  recorded in the audit log with `outcome: "evicted"`. (Eviction
  is not catastrophic — the legitimate user just needs to mint a
  fresh token if their old one was evicted before they could
  approve. The 50-cap accommodates 50 concurrent destructive-flag
  calls, which is well above any realistic legitimate workflow.)
- **`MAX_MINTS_PER_15_MIN = 100`.** Window matches the existing
  write-budget rolling window. Over-budget mints throw
  `SOFT_CONFIRM_RATE_LIMITED`. The error message includes the
  remaining wait time (similar to the `WRITE_BUDGET_EXCEEDED`
  template). Operator override: `EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT`
  (positive integer; `0` to disable).
- **TTL clamp `[60_000, 900_000]` ms.** `EPIMETHIAN_SOFT_CONFIRM_TTL_MS`
  outside this range is silently clamped to the boundary (not
  rejected — avoids surfacing a config-value oracle).

Audit-log entries from `onMint` and `onValidate` flow into the
existing mutation-log infrastructure (see [src/server/mutation-log.ts](../src/server/mutation-log.ts)).
Add a new `softConfirm?: AuditMintMeta | AuditValidateMeta` field to
the mutation-record schema; populate from the hook callbacks.

### 3.7 Extended `GatedOperationContext` (Phase 2)

The current shape in [src/server/elicitation.ts](../src/server/elicitation.ts)
is:

```ts
export interface GatedOperationContext {
  tool: string;
  summary: string;
  details?: Record<string, string | number | boolean | DeletionSummary | undefined>;
}
```

Phase 2 extends it with the four fields required for soft-mode mint:

```ts
export interface GatedOperationContext {
  tool: string;
  summary: string;
  details?: Record<string, string | number | boolean | DeletionSummary | undefined>;

  /** ──── Soft-elicitation fields (all optional; required as a SET when soft-mode triggers) ──── */
  /** Confluence cloudId of the tenant the operation runs under. Sourced from `cfg.sealedCloudId`. */
  cloudId?: string;
  /** Page ID the operation will affect. */
  pageId?: string;
  /** version.number of the page at the time the diff was computed. */
  pageVersion?: number;
  /**
   * SHA-256 hex of the canonical post-prepare storage XML, computed via
   * `computeDiffHash(canonicalXml, pageVersion)` from confirmation-tokens.ts.
   */
  diffHash?: string;
}
```

When the four soft-mode fields are all present AND the §3.4 trigger
fires, `gateOperation` mints a token bound to the matching
`ConfirmationContext`. When ANY of the four is absent and soft-mode
would otherwise trigger, the gate falls through to the legacy
`ELICITATION_REQUIRED_BUT_UNAVAILABLE` throw (fail-closed; do not
silently bypass).

### 3.8 `cloudId` and `pageVersion` sources (call-site contract)

Every call site that passes the new fields uses the same two sources:

- **`cloudId`:** read from `cfg.sealedCloudId` after `await getConfig()`.
  Defined at [src/server/confluence-client.ts:78](../src/server/confluence-client.ts#L78)
  on the `Config` interface; populated from the keychain entry at
  startup. The value is verified live against the tenant's
  `_edge/tenant_info` response by `validate-startup.ts` (the tenant
  seal). For env-var-mode profiles or pre-seal legacy profiles
  `sealedCloudId` may be `undefined` — in that case soft-mode does
  NOT trigger (the four-field requirement above is unmet), and the
  legacy `ELICITATION_REQUIRED_BUT_UNAVAILABLE` throw fires. Document
  this limit in install-agent.md "Soft confirmation": *"Pre-seal
  profiles upgraded from versions before v5.5.0 must run
  `epimethian-mcp setup` once to acquire a sealed cloudId before
  soft confirmation is available."*
- **`pageVersion`:** read from the `getPage()` result that every
  gated handler already calls — `page.version?.number`. The Phase 2
  edits in §5.3 / §5.4 assert that `pageVersion` is non-zero before
  passing it through; zero indicates a server returned a stub
  response and the operation should fail with the existing
  "no version metadata" error rather than silently mint an
  unbindable token.

These two sources are stable today and do not require new helpers in
`confluence-client.ts`.

### 3.9 Multi-process deployments

Tokens are process-local in-memory (§3.2 note 3). Operators running
**multiple MCP server processes for one tenant** (e.g. a
load-balanced fleet, separate processes per IDE window) will see
soft confirmations fail in this shape: agent issues call A → server
process P1 mints token T → agent retries with T → load balancer
routes the retry to process P2 → P2 has never seen T → returns
`CONFIRMATION_TOKEN_INVALID`.

This is **not a bug** — it's the safe failure mode for a
process-local store — but the user-facing behaviour is "soft
confirmation always fails on retry". Mitigations, in order of
preference:

1. Pin a single MCP server process per agent / per IDE window.
   The MCP transport in most clients is stdio, which is naturally
   one-process-per-spawn; load-balancing typically requires the
   user to opt into it deliberately.
2. Set `EPIMETHIAN_DISABLE_SOFT_CONFIRM=true` and fall back to
   `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` (or `BYPASS_ELICITATION`
   for fake-advertise clients).
3. Future work (out of scope for 6.6.0): a Redis-backed token
   store under `EPIMETHIAN_SOFT_CONFIRM_BACKEND=redis://...`. The
   API contract in §3.2 is shaped to allow this without breaking
   changes — `mintToken`/`validateToken` are already async, the
   store is hidden behind the module's exports.

The setup CLI emits a one-line note when `--client opencode` is
chosen: *"Soft confirmation tokens are process-local in this version.
If you run multiple MCP servers for this tenant simultaneously,
confirmation retries may fail; in that case, set
EPIMETHIAN_ALLOW_UNGATED_WRITES=true and document the trade-off."*

---

## 4. Phase 1 — Setup CLI + tool descriptions (target: 6.5.0)

### 4.1 Parallelism diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  All four tasks run in parallel (no cross-file conflicts).      │
│  Verification once at end.                                      │
└─────────────────────────────────────────────────────────────────┘

Agent 1.A — sonnet — src/cli/client-configs.ts (NEW) + src/cli/setup.ts
Agent 1.B — sonnet — src/cli/setup.test.ts + src/cli/client-configs.test.ts (NEW)
Agent 1.C — haiku  — src/server/index.ts tool descriptions (~6 strings)
Agent 1.D — haiku  — install-agent.md update (reference setup --client)
```

### 4.2 Task 1.A — Setup CLI implementation

**Model:** sonnet
**Files:**
- [src/cli/setup.ts](../src/cli/setup.ts) — accept `--client` flag,
  call `renderConfigSnippet` after credential save.
- New: `src/cli/client-configs.ts` per the §3.1 contract.

**Change:** Add a `--client <id>` flag to the `runSetup` function
(currently at line ~60). After the existing successful-save log line,
when `--client` is present, render the matching snippet via
`renderConfigSnippet(clientId, profile, binPath)` and print to stdout
along with the entry's `warning` (if any). When `--client` is absent,
print all known snippets in sequence (current "show all clients"
behaviour, but factored through the new table).

**Resolving `binPath`:** prefer `process.argv[1]` (the running CLI's
absolute path), fall back to running `which epimethian-mcp` via
child_process. If both fail, emit `<absolute path to epimethian-mcp>`
as a placeholder with a warning.

**Client config entries (initial set):**
- `claude-code` — `.mcp.json`, mcpServers shape, no warning.
- `claude-desktop` — `~/Library/Application Support/Claude/claude_desktop_config.json` (mac) / `%APPDATA%\Claude\claude_desktop_config.json` (win) / `~/.config/Claude/claude_desktop_config.json` (linux), mcpServers shape, no warning.
- `claude-code-vscode` — VS Code settings.json `mcp.servers` block; warning: *"VS Code extension ≤ 2.1.123 does not honour elicitation requests; if write tools fail with NO_USER_RESPONSE, set `EPIMETHIAN_BYPASS_ELICITATION=true`."*
- `cursor` — `.cursor/mcp.json`, mcpServers shape, no warning.
- `windsurf` — `~/.codeium/windsurf/mcp_config.json`, mcpServers shape, no warning.
- `zed` — `~/.config/zed/settings.json` `context_servers` block, no warning.
- `opencode` — `opencode.json` or `~/.config/opencode/opencode.json`, `mcp` shape with `type: "local"`, `command` array, `environment` not `env`. **Version-keyed:** for binaries `< 6.6.0`, the snippet INCLUDES `EPIMETHIAN_ALLOW_UNGATED_WRITES: "true"` in the `environment` block (necessary; OpenCode lacks elicitation support). For `>= 6.6.0`, the snippet OMITS this env var entirely — soft elicitation handles confirmation through the agent's chat surface. The setup CLI reads `process.env.npm_package_version` (or the build-time version constant) and selects the right template. Warnings, also version-keyed:
  - `< 6.6.0`: *"OpenCode does not yet support MCP elicitation. The `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` env var above removes the interactive confirmation prompt for destructive operations. Read tools and additive writes work without any flag. Upgrade to epimethian-mcp v6.6.0 to get soft elicitation (confirmations routed through the agent), and remove the env var when you do."*
  - `>= 6.6.0`: *"OpenCode does not yet support MCP elicitation. epimethian-mcp v6.6.0+ routes destructive-flag confirmations through the agent's chat surface — your agent will be told to ask you before each destructive write, and re-call with a confirmation token. No env var needed."*

**Test acceptance:**
- `epimethian-mcp setup --client opencode --profile globex` (after
  successful credential save) prints exactly the OpenCode template
  with `{{PROFILE}}` and `{{BIN}}` substituted, followed by the
  warning text. (Snapshot test in 1.B.)
- Unknown `--client` value errors with a list of valid IDs.

**Data-loss risk:** None. Setup CLI does not mutate Confluence; it
only writes credentials to the keychain (existing behaviour) and
prints config snippets to stdout. Verify the `--client` flag does NOT
modify the user's `.mcp.json` / `opencode.json` directly — only
prints the snippet for them to paste. Auto-modification is out of
scope (see §6).

### 4.3 Task 1.B — Setup CLI tests

**Model:** sonnet
**Files:**
- [src/cli/setup.test.ts](../src/cli/setup.test.ts) — extend.
- New: `src/cli/client-configs.test.ts`.

**Change:**
- One snapshot test per client ID covering the full rendered output
  (including the warning if present).
- Negative tests: unknown client ID; missing profile.
- `renderConfigSnippet` returns deterministic output for fixed inputs
  (no timestamps, no random IDs in the template).
- `knownClientIds()` returns the expected set.

**Data-loss risk:** None.

### 4.4 Task 1.C — Tool descriptions append

**Model:** haiku
**Files:**
- [src/server/index.ts](../src/server/index.ts) — append a sentence to
  the description strings of these tools:
  - `update_page` (description starts ~line 1045)
  - `update_page_section` (~line 1334)
  - `update_page_sections` (~line 1586)
  - `delete_page`
  - `revert_page`
  - `prepend_to_page`
  - `append_to_page`

**Sentence to append (verbatim):**

> "If your MCP client does not support in-protocol confirmation,
> destructive flag use will be mediated through your agent's normal
> chat surface in v6.6.0+. In v6.5.0 and earlier, set
> `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` to proceed without the
> confirmation prompt — but you (the agent) MUST still ask the user
> before invoking this tool with destructive flags."

**Test acceptance:** the existing `expectedTools` consistency test in
[src/server/index.test.ts](../src/server/index.test.ts) keeps passing
(description text is not asserted).

**Data-loss risk:** None — copy change only.

### 4.5 Task 1.D — install-agent.md reference

**Model:** haiku
**Files:**
- [install-agent.md](../install-agent.md) Step 4 — replace the
  copy-paste-the-JSON instruction with: *"Run
  `epimethian-mcp setup --profile <name> --client <client-id>` after
  Step 5 (credential setup) — it prints the exact config snippet for
  your MCP host. Supported clients: `claude-code`, `claude-desktop`,
  `claude-code-vscode`, `cursor`, `windsurf`, `zed`, `opencode`."*
  Keep the fallback hand-typed examples below the new line.

**Test acceptance:** the install-agent.test.ts assertion that the
"Write budget" section heading exists keeps passing. Optionally add a
new assertion that "setup --client" appears.

**Data-loss risk:** None.

---

## 5. Phase 2 — Soft elicitation (target: 6.6.0)

### 5.1 Parallelism diagram

```
                          §3 contracts agreed
                                  │
        ┌───────┬───────┬─────────┼─────────┬───────┬───────┐
        ▼       ▼       ▼         ▼         ▼       ▼       ▼
       2.A     2.B     2.C       2.D       2.E    2.F     2.G
       opus    opus    sonnet    sonnet    sonnet haiku   haiku
       ─────   ─────   ─────     ─────     ─────  ─────   ─────
       token   gate    schema +  result    inval. tool    agent
       store   branch  handler   shape     hook   desc    guide

                                  │
                          (all complete)
                                  │
                                  ▼
                                 2.H
                                sonnet
                                ─────
                              integ tests
```

All seven implementation tasks (2.A–2.G) target disjoint files or
disjoint regions of `src/server/index.ts` and can run concurrently
once §3 is frozen. **2.H runs last** because it asserts the integrated
behaviour end-to-end.

**Pre-flight contract check.** Before dispatching any agent, confirm
that §§3.1–3.9 are stable (no further amendments). Two of the seven
tasks (2.A, 2.B) are **opus** because they own the trust-boundary
logic; the other five are **sonnet** or **haiku** because they
follow the contracts mechanically. If any agent proposes deviating
from a §3 contract during implementation, that agent stops and
escalates rather than merging an inconsistent change.

### 5.2 Task 2.A — Token store

**Model:** opus
**Files:**
- New: `src/server/confirmation-tokens.ts` per §3.2.
- New: `src/server/confirmation-tokens.test.ts`.

**Change:** Implement the token store per §3.2. In-memory only; no
persistence. Tokens generated via `crypto.randomUUID()` (Node 18+) or
`crypto.randomBytes(24).toString("base64url")`.

**Tests (must cover, not exhaustive — note the public API now returns
`Promise<"ok" | "invalid">` only; the fine-grained reason is asserted
via the `onValidate` audit hook, NOT the return value):**

External-API tests (assert `await validateToken(...)` return value):
- Mint then validate immediately → `"ok"`. Second validate of the
  same token → `"invalid"` (single-use; audit shows `"unknown"`).
- Mint with `{cloudId: "abc"}`, validate with `{cloudId: "xyz"}` →
  `"invalid"` (audit shows `"mismatch"`). **Multi-tenant guard.**
- Mint with `{tool: A}`, validate with `{tool: B}` → `"invalid"`
  (audit shows `"mismatch"`).
- Mint with `{pageId: 1}`, validate with `{pageId: 2}` → `"invalid"`
  (audit shows `"mismatch"`).
- Mint with `{pageVersion: 7}`, validate with `{pageVersion: 8}` →
  `"invalid"` (audit shows `"mismatch"`).
- Mint with `{diffHash: X}`, validate with `{diffHash: Y}` →
  `"invalid"` (audit shows `"mismatch"`).
- Mint, advance fake time past TTL, validate → `"invalid"` (audit
  shows `"expired"`).
- Mint, `invalidateForPage(cloudId, samePageId)`, validate →
  `"invalid"` (audit shows `"stale"`).
- Validate a never-minted token → `"invalid"` (audit shows
  `"unknown"`).
- **TOCTOU test** (the new sibling-invalidation in §3.2 note 7):
  mint two tokens T1 and T2 against the same `{cloudId, pageId}` but
  different `diffHash`. `validateToken(T1, ctx1)` → `"ok"`.
  Immediately afterward, `validateToken(T2, ctx2)` → `"invalid"`
  (audit shows `"stale"`).

Resource / abuse-cap tests:
- 51st `mintToken` after 50 outstanding: oldest is FIFO-evicted; the
  evicted token's subsequent validate → `"invalid"` (audit shows
  `"unknown"` since the token is no longer in the store).
- 101st `mintToken` within 15 min: throws `SOFT_CONFIRM_RATE_LIMITED`.
  Advance fake time past 15 min; next mint succeeds.
- `EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT="0"` disables the rate cap;
  1000 mints in 1 second succeed (subject only to FIFO eviction
  at 50 outstanding).
- `EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT="200"` lifts the rate cap to
  200 / 15 min.
- TTL clamp: pass `ttlMs=10_000` (under floor) → `expiresAt` is
  60 s after mint (clamped up). Pass `ttlMs=99_999_999_999` (over
  ceiling) → `expiresAt` is 900 s after mint (clamped down).
- `EPIMETHIAN_SOFT_CONFIRM_TTL_MS=10000` (under floor) → minted
  tokens default to 60 s; over-ceiling values clamp to 900 s.

Timing-floor test:
- Compare wall-time of a hit-path validate vs a miss-path validate
  (using `performance.now()` × 100 iterations each). Assert the
  difference is < 1 ms — proves the 5 ms minimum-response floor
  removed the timing-side-channel.

Audit-hook tests:
- `onMint` fires exactly once per `mintToken` call; payload
  contains `auditId`, `tool`, `cloudId`, `pageId`, `pageVersion`,
  `expiresAt`, `outstanding`. NEVER contains the token itself.
- `onValidate` fires exactly once per `validateToken` call; payload
  contains the actual `outcome` (one of `"ok"` / `"unknown"` /
  `"expired"` / `"stale"` / `"mismatch"`); never the token; the
  `auditId` matches the original mint when applicable.

Memory & cleanliness:
- 1000 mints + 1000 validates: outstanding-token map is empty (or at
  most 50 if FIFO eviction is engaged); no leaked entries.
- `_resetForTest()` clears state between tests.

The `_peekToken` API is GONE (security-review item 8); do not write
tests for it.

**Data-loss risk:** **HIGH if the store has a bug.** A token-store
bug could let a stale or wrong-page token validate as `"ok"` and
bypass the gate. Mitigations:
1. Single-use semantics (validate consumes the token).
2. Strict ctx equality on every field (tool + pageId + diffHash).
3. Per-pageId invalidation on every successful write (separate
   integration in 2.E).
4. The diffHash is computed from the canonical storage XML
   *post-prepare* — i.e. it includes the exact bytes that would have
   been submitted. A token minted for one diff cannot validate for
   any other diff against the same page.
5. **Code review by a human before merge.** Same posture as C1's
   byte-equivalent suppression. This is the highest-risk module in
   the plan.

### 5.3 Task 2.B — `gateOperation` soft-mode branch

**Model:** opus
**Files:**
- [src/server/elicitation.ts](../src/server/elicitation.ts) at the
  unsupported-client branch (~line 122–140) — implement the §3.4
  precedence table.
- Same file — extend `GatedOperationContext` per §3.7 (add
  optional `cloudId`, `pageId`, `pageVersion`, `diffHash` fields).
- Same file — add the new `SOFT_CONFIRMATION_REQUIRED` error code
  and `SoftConfirmationRequiredError` subclass per §3.3.
- Same file — add the startup-time warning per §3.4 ("BYPASS set
  against a non-faking client").
- [src/server/elicitation.test.ts](../src/server/elicitation.test.ts)
  — extend with the matrix tests below.

**Change.** Replace the existing single-branch unsupported-client
check with the six-row precedence table from §3.4. Branch 4 (soft
mode) does:

1. Verify all four soft-mode fields (`cloudId`, `pageId`,
   `pageVersion`, `diffHash`) are present on the context. If any is
   missing, fall through to branch 5 (legacy throw).
2. Build a human summary from `context.details.deletionSummary`
   (the structured `DeletionSummary` shape from A2). If absent,
   fall back to `context.summary` — but DO NOT interpolate any
   field of `context.details` other than `deletionSummary`'s
   numeric counts (security-review §3.5 invariant).
3. Mint a token via `mintToken({tool, cloudId, pageId, pageVersion,
   diffHash})`. The mint call may itself throw
   `SOFT_CONFIRM_RATE_LIMITED`; let that propagate as an
   `isError: true` tool result with no token.
4. Throw `SoftConfirmationRequiredError(token, auditId, expiresAt,
   humanSummary, retryHint, pageId)`.

The `humanSummary` template is a pure function of the
`DeletionSummary` counts: `"This update will remove ${tocs ? `${tocs}
TOC macro${tocs===1?'':'s'}` : ''}{...and ${links} link macros}…"` —
short, human, no page content. Implement once in a helper
`renderDeletionSummary(s: DeletionSummary): string`; reuse from §3.5
result formatting and from this branch.

When the trigger conditions are NOT met (existing client supports
elicitation, OR an earlier env-var branch fired), behaviour is
unchanged from 6.5.0.

**Tests:**
- **Branch 4 happy path:** soft mode triggers and throws
  `SoftConfirmationRequiredError` with a valid token, an `auditId`,
  the right `expiresAt`, and a `humanSummary` derived purely from
  the deletion counts.
- **Branch 5 fail-closed:** soft mode would otherwise fire but
  `cloudId` / `pageId` / `pageVersion` / `diffHash` is missing →
  legacy `ELICITATION_REQUIRED_BUT_UNAVAILABLE` throw.
- **§3.4 precedence matrix:** all 16 combinations of the four env
  vars, with `clientSupportsElicitation` mocked both ways. Each
  combo asserts the expected branch fires (use the row number from
  the table as the test description).
- **Startup-warning test:** with `BYPASS_ELICITATION=true` and
  `clientSupportsElicitation()` returning false, the next
  `gateOperation` invocation calls `console.error` with the §3.4
  warning text exactly once per process (use a `firedOnce` flag in
  the implementation; assert the warning is silent on the second
  call).
- **`SOFT_CONFIRM_RATE_LIMITED` propagation:** mock `mintToken` to
  throw the rate-limit error; assert it bubbles as
  `SOFT_CONFIRM_RATE_LIMITED` with no token in the result.
- **`humanSummary` exfil resistance:** invoke `gateOperation` with a
  context whose `details` map contains attacker-shaped strings under
  every other key (not under `deletionSummary`). Assert that none
  of those values appears in the resulting `humanSummary` —
  `humanSummary` is built solely from `DeletionSummary` numeric
  fields.

**Data-loss risk:** Inherits from 2.A. Additionally: a buggy
soft-mode trigger that fires for clients that DO support elicitation
would silently downgrade safety. Mitigation: branch 4's condition
includes `!clientSupportsElicitation(server)` as the first AND of
the SET test; test fixtures cover the precedence matrix; the
startup-warning surfaces the most common misconfiguration without
changing behaviour.

### 5.4 Task 2.C — `confirm_token` parameter on gated tools + handler plumbing

**Model:** sonnet
**Files:**
- [src/server/index.ts](../src/server/index.ts) — extend the input
  schema of these tools to add `confirm_token: z.string().optional()`:
  `update_page`, `update_page_section`, `update_page_sections`,
  `delete_page`, `revert_page`, `prepend_to_page`, `append_to_page`.
- Same file — in each gated handler, do the work outlined below
  BEFORE the existing `gateOperation` call.

**Change. Each gated handler grows a small, identical preamble.**
The structure is:

```ts
// In every gated handler, after `await getPage(...)` and after the
// post-prepare canonical storage XML is in hand:
const cloudId = cfg.sealedCloudId;
const pageVersion = page.version?.number ?? 0;
const diffHash = (cloudId && pageVersion > 0)
  ? computeDiffHash(canonicalStorageXml, pageVersion)
  : undefined;

if (confirm_token !== undefined && cloudId && pageVersion > 0 && diffHash) {
  const outcome = await validateToken(confirm_token, {
    tool: <this tool's name>,
    cloudId,
    pageId: page_id,
    pageVersion,
    diffHash,
  });
  if (outcome === "ok") {
    // Token consumed; skip the gate entirely. Proceed to write.
  } else {
    // outcome === "invalid" — single bucket per §3.5.
    throw new ConverterError(
      `The confirmation token is no longer valid. Mint a new one by ` +
      `re-calling this tool without confirm_token, ask the user again, ` +
      `then retry with the new token.`,
      "CONFIRMATION_TOKEN_INVALID"
    );
  }
} else {
  // No token, or required context unavailable — fall through to
  // gateOperation, which (per §3.7) receives cloudId / pageVersion /
  // diffHash via GatedOperationContext and mints a token if the
  // soft-mode trigger fires (branch 4 of §3.4).
  await gateOperation(server, {
    tool: <this tool's name>,
    summary: <existing summary>,
    details: { ..., deletionSummary },
    cloudId,
    pageId: page_id,
    pageVersion,
    diffHash,
  });
}
```

**Important invariants for the implementer:**

1. The handler MUST NOT call `gateOperation` after a successful
   `validateToken` returns `"ok"`. The token is the gate; calling the
   gate again would either no-op (elicitation-capable client) or
   double-mint (soft-mode client). The branching above enforces this.
2. `validateToken` is `async` (returns `Promise<...>`) — the handler
   must `await`. TypeScript will catch this at compile time given the
   contract in §3.2; tests must cover the await behaviour.
3. Pass `cloudId`, `pageVersion`, and `diffHash` into
   `GatedOperationContext` whenever they are computable, even when
   the connecting client supports elicitation. The fields are no-ops
   on the elicitation path; supplying them keeps the soft-mode
   trigger correct if a future client downgrades capabilities.
4. When `cfg.sealedCloudId` is `undefined` (env-var-mode profile or
   pre-seal legacy profile), DO NOT mint or validate tokens. The
   handler's behaviour is identical to v6.5.0 in that case (gate
   throws legacy `ELICITATION_REQUIRED_BUT_UNAVAILABLE` when soft
   mode would otherwise have fired).

**`diffHash` computation:** use the shared helper
`computeDiffHash(canonicalXml: string, pageVersion: number)` exported
from `src/server/confirmation-tokens.ts`. The handler computes
`canonicalStorageXml` from the prepared body — for `update_page` /
`update_page_section`, this is `prepared.finalStorage`; for
`update_page_sections`, the aggregated `prepared.finalStorage`; for
`delete_page` / `revert_page`, where there is no body diff, pass an
empty string and rely on `pageVersion` for binding.

**Tests:** unit tests in `index.test.ts` per gated tool:
- Valid token short-circuits the gate (assert `gateOperation` is not
  called and the write succeeds).
- Token reuse → second call returns `CONFIRMATION_TOKEN_INVALID`
  (single-use).
- Cross-tool token: mint via `update_page`, retry on `delete_page`
  → `CONFIRMATION_TOKEN_INVALID`.
- Cross-page token: mint for pageId X, retry on pageId Y →
  `CONFIRMATION_TOKEN_INVALID`.
- Different diff: mint with body A, retry with token + body B →
  `CONFIRMATION_TOKEN_INVALID`.
- Different page version: mint at version 7, server advances to 8,
  retry → `CONFIRMATION_TOKEN_INVALID`.
- Different tenant (cloudId): simulate by calling validate with a
  different `cfg.sealedCloudId` than the mint context (mock
  `getConfig`) → `CONFIRMATION_TOKEN_INVALID`. **Multi-tenant
  guard.**
- Pre-seal profile (cloudId undefined): handler does not call
  `validateToken` even when `confirm_token` is provided; falls
  through to `gateOperation` with no `cloudId`; gate throws legacy
  `ELICITATION_REQUIRED_BUT_UNAVAILABLE`.

**Data-loss risk:** Same as 2.A — the validate path is the trust
boundary. The implementation is mechanical (delegate to the store);
the safety lives in 2.A's strict 5-field ctx equality. The handler
preamble is identical across all 7 gated tools — extract a
`maybeConsumeConfirmToken(handler-args, pre-prepared-state)` helper
into [src/server/safe-write.ts](../src/server/safe-write.ts) so the
preamble lives in ONE place. Verify that NO handler calls
`gateOperation` after a successful validate.

### 5.5 Task 2.D — Tool-result shape for `SOFT_CONFIRMATION_REQUIRED`

**Model:** sonnet
**Files:**
- [src/server/index.ts](../src/server/index.ts) — in the existing
  catch / `toolErrorWithContext` path of each gated tool's handler,
  add a branch that detects `SoftConfirmationRequiredError` and
  formats the result per §3.5 (instead of a bare error string).

**Implementation note:** factor the formatting into a single helper,
e.g. `formatSoftConfirmationResult(err, params): ToolResult`, called
from every gated tool's catch. Reuse, don't duplicate.

**Tests:** assert the `isError: true` shape and the presence of the
key strings (`SOFT_CONFIRMATION_REQUIRED`, the token, the page ID,
the human summary) for one representative gated tool. The other
tools share the helper, so per-tool assertions are unnecessary.

**Data-loss risk:** None — formatting only.

### 5.6 Task 2.E — Per-pageId invalidation on successful writes (defense-in-depth)

**Model:** sonnet
**Files:**
- [src/server/safe-write.ts](../src/server/safe-write.ts) at the
  end of the success path of `safeSubmitPage` — call
  `invalidateForPage(cloudId, pageId)` from the new module.

**Change:** After every successful Confluence write (PUT 200 OK),
invalidate every soft-confirmation token bound to that
`{cloudId, pageId}`. This is **defense-in-depth** — the primary
TOCTOU guard lives inside `validateToken` itself (see §3.2 note 7),
which atomically invalidates sibling tokens for the same page on a
successful validate, before returning `"ok"`. The post-PUT
invalidation here covers the residual case where a write succeeds
through a path that did NOT go through `validateToken` (e.g., a
non-gated tool, or an `EPIMETHIAN_ALLOW_UNGATED_WRITES` bypass).

**Tests:** unit test in `safe-write.test.ts`: mint a token at T1,
PUT through a non-gated path at T2, then validate at T3 returns
`"invalid"` (the audit log shows `outcome: "stale"`).

**Data-loss risk:** Low. The validate-time invalidation is the
primary control; this hook is defense-in-depth. Failure to
invalidate here only matters if a write reached the page via a path
other than `validateToken`'s consume — in which case the next
validate falls through to the diffHash check (which now includes
`pageVersion` per §3.2), and a stale token still fails because the
page version has advanced. Two independent safeguards.

### 5.7 Task 2.F — Tool-description updates (Phase 2 follow-up to 1.C)

**Model:** haiku
**Files:**
- [src/server/index.ts](../src/server/index.ts) — replace the Phase 1
  description text on the same gated tools with the v6.6.0 wording:

> "If your MCP client does not support in-protocol confirmation, this
> tool returns `SOFT_CONFIRMATION_REQUIRED` on the first call when
> destructive flags are set. STOP and ask the user before retrying.
> If the user approves, re-call this tool with the same parameters
> plus `confirm_token` from the first response. The token expires
> after 5 minutes and is invalidated by competing writes. See the
> 'Soft confirmation' section of `install-agent.md` for the full
> protocol."

**Data-loss risk:** None — copy change.

### 5.8 Task 2.G — install-agent.md "Soft confirmation" section

**Model:** haiku
**Files:**
- [install-agent.md](../install-agent.md) — new section between
  "Write budget" and "Available Tools (35)". Title: *"Soft
  confirmation (clients without elicitation)"*.

**Section content (binding outline; agent can polish prose):**

```
## Soft confirmation (clients without elicitation)

Some MCP clients (currently OpenCode, plus some others) don't
implement the in-protocol confirmation prompt. Starting in v6.6.0,
epimethian-mcp routes those confirmations through your agent's
normal chat surface instead.

### What you (the agent) see

When a destructive write is requested against a client without
elicitation, the tool returns:

  isError: true
  content[0].text:
    ⚠️  Confirmation required (SOFT_CONFIRMATION_REQUIRED)
    {humanSummary}
    Please ask the user before retrying. If approved, re-call with:
        "confirm_token": "{token}"
    Expires at {timestamp}; invalidated by competing writes.

### What to do

1. STOP. Don't retry blindly.
2. Show the user, in their language, what's about to happen
   (use the `humanSummary` field from the result).
3. Ask the user explicitly. Wait for their answer.
4. If approved: re-call the tool with the SAME parameters plus
   `confirm_token` from the result.
5. If denied: tell the user the operation has been cancelled.

### Token semantics

- Single-use: a successful retry consumes the token. Replays fail.
- 5-minute TTL by default.
- Invalidated by any competing write to the same page (stale).
- Bound to the specific diff: changing the body between the first
  call and the retry will fail validation.

### Operator opt-outs

- `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` — bypasses soft confirmation
  entirely (no prompt; useful for headless / CI).
- `EPIMETHIAN_DISABLE_SOFT_CONFIRM=true` — keeps the legacy
  `ELICITATION_REQUIRED_BUT_UNAVAILABLE` failure mode for clients
  that lack elicitation.
- `EPIMETHIAN_SOFT_CONFIRM_TTL_MS=300000` — override the 5-minute
  TTL.
```

**Test acceptance:** add a `install-agent.test.ts` assertion that the
new section heading exists.

**Data-loss risk:** None.

### 5.9 Task 2.H — Integration tests

**Model:** sonnet
**Runs after:** all of 2.A–2.G complete.
**Files:**
- New: `src/server/soft-elicitation.integration.test.ts`.
- Optionally extend `permission-and-provenance.integration.test.ts`.

**Scenarios to cover** (note: external token-failure code is always
`CONFIRMATION_TOKEN_INVALID` per §3.5; the specific reason — stale,
expired, mismatch, unknown — is asserted via the audit log
`onValidate` hook, NOT via the tool result):

1. **Happy path:** client lacks elicitation; first call returns
   `SOFT_CONFIRMATION_REQUIRED` + structured `confirm_token`; second
   call with token succeeds; page is updated.
2. **Token reuse:** repeat scenario 1 → second use of the same token
   returns `CONFIRMATION_TOKEN_INVALID`; audit log shows
   `outcome: "unknown"` (the token was consumed on the first
   successful validate).
3. **Stale token:** mint via call 1; another agent's call writes to
   the same page; call 2 with token → `CONFIRMATION_TOKEN_INVALID`;
   audit log shows `outcome: "stale"`.
4. **Expired token:** mint via call 1; advance fake time past TTL
   (use `vi.useFakeTimers()`); call 2 → `CONFIRMATION_TOKEN_INVALID`;
   audit log shows `outcome: "expired"`.
5. **Different diff:** call 1 with body A; call 2 with token but
   body B → `CONFIRMATION_TOKEN_INVALID`; audit log shows
   `outcome: "mismatch"`.
6. **Cross-tool token:** mint from `update_page`; try to use on
   `delete_page` → `CONFIRMATION_TOKEN_INVALID`; audit log shows
   `outcome: "mismatch"`.
7. **`EPIMETHIAN_DISABLE_SOFT_CONFIRM=true`:** legacy
   `ELICITATION_REQUIRED_BUT_UNAVAILABLE` fires; no token minted;
   `onMint` hook never fires.
8. **`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`:** soft confirmation
   skipped; write proceeds.
9. **Elicitation-capable client:** soft confirmation never triggers;
   existing flow.
10. **`update_page_sections` (multi-section):** token is bound to
    the *aggregate* diff hash; a token minted from one set of
    sections cannot apply a different set.
11. **Concurrent retries (TOCTOU close):** mint two tokens for the
    same `{cloudId, pageId}` (different agents racing); first
    `validate` returns `"ok"` and the page is updated; second
    `validate` (using the other token) returns `"invalid"` even
    though it was minted independently. Asserts the validate-time
    sibling-invalidation in §3.2 note 7 fires.
12. **Tenant flip mid-session:** mint a token under
    `cloudId: "abc"`; the server is reconfigured (or a new connection
    arrives) with `cloudId: "xyz"`; validate returns `"invalid"`;
    audit log shows `outcome: "mismatch"`. **Critical multi-tenant
    safety test.**
13. **Env-precedence matrix:** all 16 combinations of the four env
    vars (`BYPASS_ELICITATION`, `ALLOW_UNGATED_WRITES`,
    `DISABLE_SOFT_CONFIRM`, `SUPPRESS_EQUIVALENT_DELETIONS`), each
    asserting the expected branch executes per the §3.4 table.
14. **Audit log integrity:** every mint produces exactly one
    `onMint` callback; every validate (regardless of outcome)
    produces exactly one `onValidate` callback; no token-byte string
    appears in any audit-record field.
15. **Memory ceiling:** mint 60 tokens; assert outstanding count
    never exceeds 50 (FIFO eviction kicks in); 51st mint succeeds,
    oldest token's subsequent validate returns `"invalid"` with
    audit `outcome: "evicted"` (or `"unknown"`, depending on whether
    the audit hook fires before eviction — pin the chosen behaviour
    in the test).
16. **No-leak in stderr:** capture stderr during the full
    integration suite via `vi.spyOn(console, "error")`; assert no
    `confirm_token` byte sequence (full or partial > 8 chars)
    appears in any captured argument. Tokens may appear ONLY in the
    `structuredContent` channel of tool results.
17. **Mint-rate ceiling:** issue 100 mints inside 1 minute; mint #101
    throws `SOFT_CONFIRM_RATE_LIMITED`. Advance fake time past 15
    min; next mint succeeds.
18. **TTL clamp:** set `EPIMETHIAN_SOFT_CONFIRM_TTL_MS=10000` (under
    floor); mint a token; expiresAt is at least 60 s from mint.
    Set the env to `99999999999` (over ceiling); expiresAt is at
    most 900 s from mint.
19. **`humanSummary` exfil resistance:** craft a fixture page whose
    macros contain attacker-shaped strings in attribute values, CDATA
    bodies, and display text (e.g. `ri:content-title="ATTACKER_PAYLOAD"`,
    `<![CDATA[ATTACKER_PAYLOAD]]>`); trigger soft-mode; assert that
    `ATTACKER_PAYLOAD` does NOT appear in `humanSummary` or
    `content[0].text`. Counts only.

**Data-loss risk:** Low — these tests are the safety-net for the
whole feature.

---

## 6. Out of scope

- **Auto-modifying the user's `.mcp.json` / `opencode.json`.** The
  setup CLI prints snippets for the user to paste; it never writes
  to the host's config files.
- **Cross-process token sharing.** Tokens are process-local in-memory.
  Documented as a limitation. Persistence would invite a different
  class of bugs.
- **Per-client name-based behaviour switches.** Soft elicitation is
  triggered by capability detection (`clientSupportsElicitation`),
  not client name. We don't ship a list of "blessed" client names.
  The `clientLabel` value remains observational only.
- **Filing the upstream OpenCode issue.** Worth doing in parallel,
  but not part of this plan's deliverables.
- **Default-on for `EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS`.** Stays
  opt-in regardless of soft-elicitation rollout.

---

## 7. Test-coverage requirements

This work touches a security-critical path (a soft-elicitation gate
that substitutes for the in-protocol confirmation). The new modules
must hit **≥ 80 % coverage on lines, branches, functions, and
statements** — matching the existing `src/server/**` threshold.
Coverage is enforced in CI via vitest's existing thresholds in
`vitest.config.ts`.

**Per-file thresholds to add to [vitest.config.ts](../vitest.config.ts)
when each module lands:**

```ts
"src/server/confirmation-tokens.ts": {
  lines: 90, branches: 90, functions: 90, statements: 90
},
"src/cli/client-configs.ts": {
  lines: 85, branches: 85, functions: 85, statements: 85
},
```

`confirmation-tokens.ts` is held to **90 %** because it is the trust
boundary for the soft-mode gate; coverage gaps here mean untested
states where a wrong-page or replayed token could validate. Pin every
branch of `validateToken`'s switch (ok / stale / expired / mismatch /
unknown) plus the `mintToken`-after-`invalidateForPage` race.

`client-configs.ts` is held to **85 %** because it is mechanical
templating with one rendered output per supported client; reaching
85 % only requires snapshot tests for each entry plus the
unknown-client error path.

**Modified surfaces** (`elicitation.ts`, `index.ts`, `safe-write.ts`,
`setup.ts`) inherit the existing `src/server/**` 80 % / `src/cli/**`
60 % thresholds. New code added to those files must not drag the file
below threshold; verify per-file coverage after each phase via
`npm run test:coverage` and fix gaps before merge.

**Definition-of-done tightening for both phases:** add to §8 (below)
that every checklist item is gated by `npm run test:coverage` showing
no new file under threshold.

---

## 8. Verification & rollout

After each phase's parallel agents complete:

```bash
npm test -- --run --reporter=basic   # 1696 + new tests
npx tsc --noEmit                      # expected: 25 pre-existing errors, 0 new
npm run build
```

**Manual smoke** (Phase 2 only, against a sandbox tenant):

1. Configure with OpenCode (or `EPIMETHIAN_DISABLE_SOFT_CONFIRM`
   forcibly off and a test profile that pretends not to advertise
   elicitation). Issue a `delete_page` on a sandbox page →
   `SOFT_CONFIRMATION_REQUIRED` returned with a token.
2. Re-call with the token → page deleted; second re-call with same
   token → `CONFIRMATION_TOKEN_INVALID`.
3. Mint a token for an `update_page`, manually `update_page` the
   same page from another session, retry with the token →
   `CONFIRMATION_TOKEN_INVALID` (audit log shows `outcome: "stale"`).

**CHANGELOG entries** for each version, in the existing voice (terse,
"why" before "what"). Link the source investigation file from each
entry.

---

## 9. Definition of done (per phase)

**Phase 1 (6.5.0):**
- [ ] `epimethian-mcp setup --client opencode --profile X` prints
  the OpenCode template + warning verbatim, in the agreed shape.
- [ ] All 7 client IDs from §4.2 are covered.
- [ ] Tool descriptions on the 7 gated tools include the v6.5.0 text
  (no soft-elicitation mention yet — that lands in 6.6.0).
- [ ] install-agent.md Step 4 references `setup --client`.
- [ ] No new tsc errors; all tests green.
- [ ] `npm run test:coverage` shows `src/cli/client-configs.ts`
  ≥ 85 % across lines / branches / functions / statements.
- [ ] No file in `src/server/**` or `src/cli/**` falls below its
  existing threshold as a result of this change.

**Phase 2 (6.6.0):**
- [ ] Token store passes the §3.2 contract tests (single-use,
  TTL clamp, per-page invalidation, 5-field ctx equality, FIFO
  eviction at MAX_OUTSTANDING_TOKENS, mint-rate ceiling).
- [ ] Soft-mode trigger fires only per the §3.4 precedence table;
  every row of the matrix has a unit test.
- [ ] Every gated tool accepts `confirm_token` and round-trips
  cleanly.
- [ ] All 19 integration scenarios in §5.9 pass.
- [ ] install-agent.md "Soft confirmation" section present and
  asserted by `install-agent.test.ts`.
- [ ] No new tsc errors; total test count up by ≥40 (was ≥30
  pre-security-review; the additional scenarios cover
  multi-tenant + concurrency + exfil + audit + memory).
- [ ] `npm run test:coverage` shows
  `src/server/confirmation-tokens.ts` ≥ 90 % across lines /
  branches / functions / statements.
- [ ] No file in `src/server/**` or `src/cli/**` falls below its
  existing threshold as a result of this change.
- [ ] **Security gates** (mandatory pre-merge):
  - [ ] Tokens never appear in stderr, mutation log, telemetry,
    or any tool-result `text` field. Verified by scenario 16.
  - [ ] `humanSummary` is derived solely from `DeletionSummary`
    counts. Verified by scenario 19.
  - [ ] Multi-tenant cloudId binding is enforced. Verified by
    scenario 12.
  - [ ] All four token-failure reasons collapse to one external
    code. Verified by scenarios 2, 3, 4, 5, 6.
  - [ ] Validate-time sibling-invalidation closes the
    concurrent-retries TOCTOU. Verified by scenario 11.
  - [ ] Constant-time-floor on validate (≥ 5 ms regardless of
    outcome). Verified by a timing test that asserts hit and miss
    paths are within 1 ms of each other.
- [ ] Human code review on `confirmation-tokens.ts` AND the
  soft-mode branch in `elicitation.ts` AND the
  `validateToken`-bypass logic in every gated tool handler in
  `index.ts`, before merge.

---

## 10. Risk register

Updated per the security review of 2026-04-29 (11 findings; all
HIGH/MEDIUM mitigations integrated; LOW findings either integrated
or scoped out with rationale).

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **HIGH** Token replays across tenants (cloudId collision) | medium without mitigation | cross-tenant write | `cloudId` bound into `ConfirmationContext`; mismatch returns `"invalid"`; covered by integration scenario 12 |
| **HIGH** Operator sets `BYPASS_ELICITATION=true` for an OpenCode-style client (wrong env var) | medium | silent gate bypass | startup-time warning when BYPASS is set AND client lacks elicitation; setup CLI emits the correct flag per client; install-agent.md table distinguishes the two |
| **MEDIUM** Concurrent retries TOCTOU: two tokens mint, both validate | medium | dual write, second overwrites first | validate-time sibling-invalidation per `{cloudId, pageId}` (§3.2 note 7); covered by integration scenario 11 |
| **MEDIUM** Timing side-channel on token comparison | very low (colocated attacker only) | token enumeration over time | 5 ms minimum response time floor in `validateToken` regardless of outcome; Map lookup itself is hash-based |
| **MEDIUM** `humanSummary` carries page content as exfil channel | low without mitigation | tenant-content exfil via tool-result text | `humanSummary` derived solely from `DeletionSummary` numeric counts; never interpolates page content; covered by scenario 19 |
| **MEDIUM** Mint-loop abuse (memory + audit noise) | low | DoS / log pollution | `MAX_OUTSTANDING_TOKENS=50` (FIFO evict); `MAX_MINTS_PER_15_MIN=100` (`SOFT_CONFIRM_RATE_LIMITED` over budget); covered by scenarios 15 + 17 |
| **MEDIUM** OpenCode setup snippet ships `ALLOW_UNGATED_WRITES=true` and user keeps it after upgrading | medium | continued silent bypass | setup-CLI snippet is **version-keyed**: < 6.6.0 includes the env var; >= 6.6.0 omits it. Warning text version-specific. |
| **LOW** Distinct error codes leak token-state oracle | low | enumeration aid | all four token-failure outcomes collapse to single `CONFIRMATION_TOKEN_INVALID` external code; specific reason recorded only in audit log via `onValidate` |
| **LOW** TTL outside reasonable bounds | low | tokens too persistent or too ephemeral | clamped to `[60_000, 900_000]` ms silently; covered by scenario 18 |
| **LOW** Tokens leak via stderr / logs / telemetry | low | replay aid | tokens never appear in any log surface, full or partial; `auditId` UUID used for correlation; covered by scenario 16 |
| **LOW** `_peekToken` accidentally reached for in a future refactor | low | safety surface erosion | not exported; observability via write-only `onMint`/`onValidate` hooks |
| **LOW (carry-over)** Agent retries with token without asking the user | medium | silent gate bypass | tool-result message is imperative ("STOP and ask"); same risk as today's `EPIMETHIAN_ALLOW_UNGATED_WRITES`; mitigated, not eliminated, by routing the token through `structuredContent` (out of free-text scratchpad) |
| **LOW** Token-store bug lets a wrong-page token validate | low | data loss | strict 5-field ctx equality; single-use; validate-time sibling-invalidation; mandatory human code review on `confirmation-tokens.ts` before merge |
| **LOW** Soft-mode trigger fires for elicitation-capable clients | very low | safety downgrade | trigger explicitly requires `!clientSupportsElicitation()`; precedence matrix tested in scenario 13 |
