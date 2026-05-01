# Plan: Fix Claude Code silent-decline + version schema rejection (v6.6.1)

Source analysis: [doc/design/investigations/investigate-claude-code-smoke-test-issues.md](../doc/design/investigations/investigate-claude-code-smoke-test-issues.md)
(2026-04-30).

Smoke-testing v6.6.0 against the Claude Code VS Code extension surfaced
two regressions:

1. **The 6.6.0 soft-elicitation path never fires for Claude Code.** The
   extension advertises `capabilities.elicitation = {}` during `initialize`
   but auto-declines every elicitation/create. `clientSupportsElicitation()`
   returns `true`, so `gateOperation` takes the row-6 (real elicitation)
   branch, sees `action: "decline"`, and throws `USER_DECLINED`. The user
   never sees a UI. v6.4.1's `EPIMETHIAN_BYPASS_ELICITATION` mitigates this
   by skipping the gate entirely — but at the cost of the safety net that
   v6.6.0 was supposed to deliver. Filed as the headline fix-target of v6.6.0
   in [CHANGELOG.md:215](../CHANGELOG.md#L215) and the §10 escape-hatch note
   in [plans/opencode-compatibility-implementation.md:507](opencode-compatibility-implementation.md#L507);
   the soft-confirm path was implemented but its activation predicate
   `!clientSupportsElicitation(server)` does not match the
   "advertises-but-lies" case.

2. **`update_page` rejects `version: "6"` with `invalid_union`.** The
   schema is `z.union([z.number().int().positive(), z.literal("current")])`
   at five sites in [src/server/index.ts](../src/server/index.ts) (lines
   1082, 1502, 1761, 2007, 2072). When the LM serialises an integer
   inside a tagged union containing a string-literal alternative, it
   sometimes wraps the value as a string. Strict rejection costs a turn
   and pushes the LM toward `"current"`, which weakens
   optimistic-concurrency.

Both are patch-level (v6.6.1).

Verified against tree at commit `f1385e4`, package `6.6.0`, npm install
under `/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp`, ~1815
tests passing.

---

## 1. Version sequencing

- **6.6.1 (patch)** — both fixes ship together.
  - The first is a real safety regression for Claude Code users (the
    largest install base) — no v6.7.0-style minor bump is warranted; this
    is restoring intended v6.6.0 behaviour.
  - The second is UX-only (intermittent string-int serialisation) and
    rides along.

No 6.7.0 work depends on these. The opencode plan's §10 exit criteria are
met once 6.6.1 lands.

---

## 2. Parallelism strategy

Four independent tasks, dispatched in parallel after §3 contracts are
frozen. Per the project's RAM-vs-parallelism memory, no agent runs
`npm test` itself — the orchestrator runs the test suite once at the end
of the integration step.

Per the **always-assess-data-loss-risk** rule, every task that touches
the gate carries an explicit "data-loss invariants" section. Issue 1's
fix is in the destructive-write critical path, and a wrong implementation
can either (a) silently bypass user intent (catastrophic) or (b) leave
the existing silent-decline (status quo). Both must be prevented.

| #  | Task                                   | Files                                                    | Model  | Worktree   |
| -- | -------------------------------------- | -------------------------------------------------------- | ------ | ---------- |
| T1 | Fast-decline detection + env override  | `src/server/elicitation.ts`, `src/server/elicitation.test.ts` | opus   | `agent-t1` |
| T2 | Version schema preprocess              | `src/server/index.ts` (×5 sites), `src/server/index.test.ts`  | sonnet | `agent-t2` |
| T3 | Soft-elicitation integration test      | `src/server/soft-elicitation.integration.test.ts`        | sonnet | `agent-t3` |
| T4 | CHANGELOG, version bump, doc patches   | `CHANGELOG.md`, `package.json`, `plans/opencode-compatibility-implementation.md`, `doc/design/destructive-flag-prompts.md` | haiku  | `agent-t4` |

T1 owns `elicitation.ts` outright; T3 only reads it. T2 owns the
five `version: z.union(...)` lines and the new `versionField` helper; the
rest of `index.ts` is read-only for T2 (this is enforced by the contract
in §3.4 — the ONLY edits T2 makes are the five replacements and the new
exported helper). T3 and T4 do not edit production source.

The orchestrator merges in order T1 → T2 → T3 → T4 (T4 last because
CHANGELOG entries reference test counts), then runs `npm test`,
`npx tsc --noEmit`, and a manual smoke test against the live Claude Code
extension.

---

## 3. Frozen API contracts

### 3.1 New env var: `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED`

```
EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true
```

When set, `gateOperation` treats the connecting client as if
`clientSupportsElicitation()` returned `false`, even when the
capability is advertised. This is the deterministic counterpart to the
auto-detection in §3.2 — for users who already know their client lies,
or for CI environments where auto-detection's first-call cost is
unwanted.

Naming rationale: the name describes the *effect* (route to the
unsupported branch), not a specific client. The existing
`EPIMETHIAN_BYPASS_ELICITATION` is preserved for the
"skip-the-gate-entirely" use case. The two are orthogonal:

| BYPASS | TREAT_AS_UNSUPPORTED | Effect                                                                                          |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| true   | (any)                | bypass entirely (existing v6.4.1 behaviour) — BYPASS wins                                       |
| false  | true                 | route through soft-elicitation token path (or row-3/row-5 fallbacks if soft fields are missing) |
| false  | false                | existing behaviour — real elicitation if advertised, soft path otherwise                        |

Precedence: BYPASS wins. TREAT_AS_UNSUPPORTED is checked *before* the
auto-detection in §3.2.

### 3.2 Fast-decline auto-detection

A deterministic timing-based heuristic that flips the connecting
client's elicitation-supported flag *for the remainder of the session*
when an `elicitation/create` response comes back declined faster than
any human could plausibly answer.

```ts
// src/server/elicitation.ts (additions)
export const FAST_DECLINE_THRESHOLD_MS = 50;
export const FAST_DECLINE_THRESHOLD_OVERRIDE_ENV =
  "EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS";

/**
 * Per-process, per-server-instance "this client lies about elicitation"
 * flag. Set on the first observed fast-decline; sticky for the
 * lifetime of the McpServer (one session).
 *
 * NOT global — multi-tenant MCP host processes that connect to several
 * clients must track this per `McpServer` instance. Implemented as a
 * `WeakMap<McpServer, boolean>`.
 */
export function isClientFakingElicitation(server: McpServer): boolean;
export function _markClientAsFakingElicitation(server: McpServer): void;
export function _resetFakeElicitationStateForTest(): void;
```

**Threshold rationale.** 50 ms is well below any human reaction time
(median ~250 ms for a *recognise + decide + click* loop, with a hard
floor around 100 ms even for trained reflex tasks). 50 ms cleanly
separates a transport round-trip (which still measures real elicitation
even on slow links — typical Claude Code IPC is <5 ms; a network MCP
client adds <30 ms) from "the SDK transport returned decline immediately
because no handler was registered."

The threshold is overridable via
`EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=<integer>` (clamped to `[10, 5000]`).
This is for slow CI environments where transport adds enough latency
to push a legitimate decline above 50 ms.

**State machine.**

```
     ┌──────────────────────────┐
     │ session start            │
     │ supportsElicitation = ?  │ ← from initialize
     └──────────────┬───────────┘
                    │
                    ▼
     ┌──────────────────────────┐
     │ first gateOperation()    │
     │ → row-6 elicitInput()    │
     │ → measure response time  │
     └──────────────┬───────────┘
                    │
       ┌────────────┴────────────┐
       │                         │
       ▼                         ▼
 decline + ms < 50           any other outcome
       │                         │
       ▼                         ▼
 mark client as           proceed normally;
 "faking";                future calls take
 retry the SAME call      the supported path
 through the !supported   (row 6) again.
 branch (soft-confirm
 mint, or row-5 throw).
```

**Critically:** when fast-decline is detected, the *current call* is
retried through the soft-confirm path (row 4 if all binding fields are
present, row 5 otherwise). The user is not told "you declined" — they
are given the soft-confirm prompt that they would have received from
the start in a properly elicitation-less client. This is what
preserves v6.6.0's intent.

**Data-loss invariants (must be tested, T1).**

- A *real* user decline (action=decline, ms ≥ threshold) MUST still
  throw `USER_DECLINED`. The retry path is gated on the timing measure,
  not on the action.
- The fast-decline flag is set from a one-time observation only after
  the *first* gateOperation in a session; subsequent fast declines
  (e.g. a different tool with a different page) MUST NOT silently
  retry. Once flagged, all later calls take the unsupported branch
  before sending anything to the client.
- The retry MUST NOT issue a second `elicitInput` to the same client
  in the same call. Doing so would risk a user actually answering on
  the second prompt and bypassing the soft-confirm gate. The retry is
  internal — it goes straight to the row-1..row-5 selector with the
  new "supported = false" reading.
- `BYPASS_ELICITATION` precedence is unchanged: row 1 still wins over
  the new detection.

### 3.3 Updated `gateOperation` precedence (replaces the §3.4 table in opencode plan)

| #   | Condition                                                                                                                         | Branch                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `EPIMETHIAN_BYPASS_ELICITATION === "true"`                                                                                        | bypass (existing — for clients that fake elicitation support)                       |
| 2   | `effectiveSupportsElicitation === false` AND `EPIMETHIAN_ALLOW_UNGATED_WRITES === "true"`                                         | bypass (existing operator opt-out)                                                  |
| 3   | `effectiveSupportsElicitation === false` AND `EPIMETHIAN_DISABLE_SOFT_CONFIRM === "true"`                                         | throw `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (legacy fail-closed)                   |
| 4   | `effectiveSupportsElicitation === false` AND all four soft-mode fields present                                                    | mint token, throw `SoftConfirmationRequiredError` (NEW soft-elicitation path)       |
| 5   | `effectiveSupportsElicitation === false` AND any soft-mode field missing                                                          | throw `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (fail-closed)                          |
| 6   | otherwise (effective support is true)                                                                                             | real elicitation request (existing); on fast-decline, set the flag and re-evaluate from row 1 |

Where:

```ts
function effectiveSupportsElicitation(server: McpServer): boolean {
  if (process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED === "true") {
    return false;
  }
  if (isClientFakingElicitation(server)) {
    return false;
  }
  return clientSupportsElicitation(server);
}
```

`clientSupportsElicitation` itself is unchanged — it still reads the
capabilities advertised in `initialize`.

### 3.4 Version schema preprocess (Issue 2)

```ts
// src/server/version-schema.ts (NEW shared module)
import { z } from "zod";

/**
 * Reusable Zod schema for the `version` field on mutation tools.
 *
 * Accepts:
 *   - a positive integer (the page version number from get_page);
 *   - the string literal "current" to skip the read;
 *   - a string-encoded positive integer (e.g. "6"), which is coerced to
 *     a number. This handles a known LM serialisation quirk where an
 *     integer inside a tagged union with a string-literal alternative
 *     is occasionally emitted as a JSON string. Coercion is narrow:
 *     only matches `^\\d+$` and only when the raw value is a string.
 */
export const versionField: z.ZodType<number | "current"> = z.union([
  z.preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.number().int().positive(),
  ),
  z.literal("current"),
]);
```

**Strictness invariants (must be tested, T2).**

- `"6"` → 6 (accepted as integer)
- `"007"` → 7 (allowed; the regex is `\d+`)
- `""` → rejected (empty string fails the regex; falls through to int branch which rejects strings)
- `" 6 "` → rejected (whitespace fails regex)
- `"6.0"` → rejected (period fails regex)
- `"-6"` → rejected (sign fails regex)
- `"current"` → "current" literal (matches the literal branch first)
- `"current2"` → rejected (no branch matches)
- `0` → rejected (positive() rejects)
- `-1` → rejected
- `6.5` → rejected (int() rejects)

The five sites in `index.ts` change from:

```ts
version: z.union([z.number().int().positive(), z.literal("current")])
  .describe(...)
```

to:

```ts
version: versionField.describe(...)
```

Imports: `import { versionField } from "./version-schema.js";`

The `.describe(...)` text is untouched.

---

## 4. Tasks

### T1 (opus) — Fast-decline detection + env override in `elicitation.ts`

**Files:** `src/server/elicitation.ts`, `src/server/elicitation.test.ts`.

**Subtasks (all in this file pair):**

1. Add `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED` handling — early
   `effectiveSupportsElicitation` helper that wraps
   `clientSupportsElicitation`.
2. Add the per-server `WeakMap<McpServer, boolean>` and the
   `isClientFakingElicitation` / `_markClientAsFakingElicitation`
   helpers.
3. Add `FAST_DECLINE_THRESHOLD_MS` (default 50) +
   `FAST_DECLINE_THRESHOLD_OVERRIDE_ENV` reader that clamps to
   `[10, 5000]`.
4. Wrap the `elicitInput()` call site: capture
   `performance.now()` before the call, compute `elapsedMs` after, and
   if `result.action === "decline"` AND `elapsedMs < threshold`:
   - Mark the client as faking.
   - Restart `gateOperation` from the top with the new
     `effectiveSupportsElicitation` reading. Implementation note:
     extract the row-1..row-5 selector into a helper
     `evaluateUnsupportedBranch(server, context)` so both the initial
     pass and the post-fast-decline retry can call it without
     duplicating logic.
5. Replace `clientSupportsElicitation(server)` calls inside
   `gateOperation` with `effectiveSupportsElicitation(server)`. The
   raw `clientSupportsElicitation` symbol stays exported (used by other
   modules per the existing import).
6. Update the `_resetStartupWarningForTest` neighbourhood with
   `_resetFakeElicitationStateForTest()` that clears the WeakMap (use
   a swap-the-WeakMap trick — the WeakMap is a module-level `let`).
7. Tests (each gets a `describe` block):
   - `effectiveSupportsElicitation` returns false when
     `TREAT_ELICITATION_AS_UNSUPPORTED=true`, regardless of advertised
     capability.
   - `effectiveSupportsElicitation` returns false after a fast-decline
     was observed.
   - `gateOperation` with a mock `elicitInput` that returns
     `{action: "decline"}` after 5 ms (< threshold) AND with all soft
     fields present → throws `SoftConfirmationRequiredError` (not
     `USER_DECLINED`).
   - `gateOperation` with a mock that returns `{action: "decline"}`
     after 200 ms (> threshold) → still throws `USER_DECLINED`. Real
     human declines are honoured.
   - Same fast-decline scenario but soft fields missing → throws
     `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (row 5).
   - Fast-decline with `BYPASS_ELICITATION=true` → BYPASS still wins
     (row 1 first); the gate is bypassed, no token mint, the timing
     code never runs.
   - Sticky flag: after one fast-decline observation, a *second* call
     with the same `McpServer` does NOT issue a second `elicitInput`
     even if the soft path would also be available — the unsupported
     branches are taken directly. (Verify with a spy on `elicitInput`:
     call count = 1 across two `gateOperation` invocations.)
   - Per-server isolation: two `McpServer` instances; flagging one
     does not flag the other.
   - Threshold override: set
     `EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=200`, simulate a 100 ms
     decline, verify it counts as a real decline (above the 100 ms
     ceiling? — wait, override SHOULD make 100 < 200 still trigger
     fast-decline; the override raises the bar). Add tests for both
     directions.
   - Clamp test: env var `"5"` is clamped to 10; env var `"99999"` is
     clamped to 5000.
   - Cancel + fast: `{action: "cancel"}` after 5 ms is NOT treated as
     a fast-decline (only `decline` triggers the flag).
   - The retry that fires after fast-decline does NOT call
     `elicitInput` a second time (regression test for the data-loss
     invariant).

**Data-loss check before reporting complete:**

- Re-read the diff and confirm there is no path where the *current*
  call proceeds without either (a) a successful `accept`, (b) a
  bypass env var, or (c) a soft-confirm token mint.
- Confirm fast-decline retry does not call `elicitInput` again.
- Confirm the WeakMap is module-scoped (not test-scoped — tests reset
  via the helper).

**Out of scope:** Issue 2's version schema. Other elicitation flow
work.

### T2 (sonnet) — Version schema preprocess

**Files:** `src/server/version-schema.ts` (NEW), `src/server/index.ts`,
`src/server/index.test.ts`.

**Subtasks:**

1. Create `src/server/version-schema.ts` per the §3.4 contract.
2. In `src/server/index.ts`, replace the five `version: z.union(...)`
   sites at lines 1082, 1502, 1761, 2007, 2072 with
   `version: versionField` (preserving the existing `.describe(...)`).
3. Add `import { versionField } from "./version-schema.js";` at the
   top of `index.ts`.
4. Tests (`src/server/index.test.ts` — add new `describe` block, or
   create `version-schema.test.ts` if cleaner):
   - All ten strictness cases from §3.4.
   - Round-trip: feed the schema as a tool input via the existing
     test harness for one of the five sites (e.g. `update_page`) and
     verify `"6"` is accepted and lands as `version: 6` in the
     handler.

**Data-loss check before reporting complete:**

- Confirm none of the five sites lost their `.describe(...)` text.
- Confirm no other `z.union([z.number().int().positive(), z.literal("current")])`
  pattern exists in `src/` outside the now-replaced sites — grep is in
  the §6 verification step.

**Out of scope:** Issue 1.

### T3 (sonnet) — End-to-end soft-elicitation integration test

**Files:** `src/server/soft-elicitation.integration.test.ts` only.

**Subtasks:**

1. Add a new `describe("Claude Code fake-elicitation interop", ...)`
   block.
2. Build a mock `McpServer` whose `elicitInput` is a stub that
   resolves with `{action: "decline"}` after a controlled delay
   (5 ms / 250 ms cases).
3. Test cases:
   - Fast decline + all soft fields → tool result is the soft-confirm
     payload with a token in `structuredContent.confirm_token`.
     Re-invoke the tool with the token → write succeeds.
   - Slow decline (250 ms) + all soft fields → tool result is the
     `USER_DECLINED` shape; no token. Re-invoke with a fabricated
     token → rejected with `CONFIRMATION_TOKEN_INVALID`.
   - `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true` from the
     start → first call goes straight to soft-confirm without ever
     calling `elicitInput`. Spy assertion: `elicitInput` call count
     is 0.
   - Stickiness across tools: fast-decline on `update_page`, then a
     `delete_page` call in the same session goes straight to soft (no
     `elicitInput`).

**Out of scope:** Editing production source. T3 may import helpers
from `confirmation-tokens.ts` and `elicitation.ts`; it must not modify
either.

### T4 (haiku) — CHANGELOG, version bump, doc patches

**Files:** `CHANGELOG.md`, `package.json`, `plans/opencode-compatibility-implementation.md`,
`doc/design/destructive-flag-prompts.md`.

**Subtasks:**

1. `package.json`: bump `version` from `6.6.0` to `6.6.1`.
2. `CHANGELOG.md`: prepend a `## [6.6.1] - 2026-04-30 - Claude Code
   silent-decline + version schema fixes` block under the existing
   `## [Unreleased]` (or replace `Unreleased` if it's empty). Body:
   - **Fixed** — Claude Code VS Code extension's silent-decline now
     auto-routes to soft-confirm tokens on the first observation,
     restoring v6.6.0's intended user experience without requiring
     `EPIMETHIAN_BYPASS_ELICITATION`.
   - **Added** — `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true` env
     var: deterministic counterpart for users who already know their
     client lies about elicitation.
   - **Added** — `EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=<10..5000>` env
     var: tune the auto-detection threshold for slow CI links (default
     50 ms).
   - **Fixed** — `version` field on `update_page`, `update_page_section`,
     `append_to_page`, `prepend_to_page`, `delete_page` now accepts
     string-encoded positive integers (e.g. `"6"`) in addition to
     numbers and the `"current"` literal. Workaround for an LM
     serialisation quirk in tagged unions with string-literal
     alternatives.
3. `plans/opencode-compatibility-implementation.md`: append a "v6.6.1
   addendum" section noting that the §3.4 precedence table in §3.3 of
   *this* plan is the new authoritative version, and that fast-decline
   detection plugs the gap §10's escape-hatch was working around.
4. `doc/design/destructive-flag-prompts.md`: short paragraph (~5
   lines) documenting the new env vars under the existing
   "configuration" section.

**Out of scope:** All production source. Test counts in the CHANGELOG
are filled in during the integration step (§6) by reading the test
output, not guessed up front.

---

## 5. Security & data-loss review

Before merging T1+T3, the orchestrator runs a checklist (no
security-reviewer agent dispatch needed — this is a small surface):

1. **Fast-decline cannot bypass a real decline.** The threshold
   default (50 ms) is below physiological reaction time; the override
   is clamped to `[10, 5000]` so an attacker cannot push it to e.g. 0
   ms (which would never trigger) or 60000 ms (which would convert
   real declines into soft-confirms). 10 ms is still below human
   capability.
2. **Soft-confirm token security model is unchanged.** The fast-decline
   path mints tokens via the *same* `mintToken` call. All v6.6.0
   guarantees (single-use, TTL, 5-field binding, rate ceiling) carry
   over. The §3.5 humanSummary content invariant is untouched.
3. **No new exfil channel.** The fast-decline measurement is a
   `performance.now()` delta; nothing tenant-controlled flows into
   the log line. The "client is faking elicitation" decision is a
   boolean.
4. **WeakMap scope.** The flag is per-`McpServer` instance, not
   per-process. A multi-tenant host with two simultaneous client
   sessions does not cross-contaminate.
5. **BYPASS still wins.** Row 1 is evaluated before §3.2's detection
   even fires, so users who have explicitly opted to bypass are not
   silently downgraded to soft-confirm.
6. **Version schema tightening, not loosening.** Coercion is via
   `^\\d+$` regex — only matches strict positive-integer strings.
   `0`, signs, decimals, whitespace, and unicode digits all reject.
   The `"current"` literal still wins its branch first.

---

## 6. Verification

Run by the orchestrator after T1–T4 merge, **once**:

```bash
npm test                              # full vitest suite
npx tsc --noEmit                      # type check
grep -rn 'z.union(\[z.number().int().positive(), z.literal("current")\])' src/  # must return 0 hits
grep -rn 'clientSupportsElicitation(server)' src/server/elicitation.ts          # must return 0 hits
                                                                                # (replaced by effectiveSupportsElicitation)
```

Expected deltas:

- ~25 new tests across T1, T2, T3.
- 0 pre-existing tests changed (all additions are net-new `it`
  blocks).
- 5 lines changed in `index.ts` (the union → versionField swap).
- 1 new file: `src/server/version-schema.ts`.

After verification, manual smoke-test against the live Claude Code
extension:

1. Reinstall the locally-built version (`npm pack` + symlink, or
   re-run `npm install -g`).
2. Restart Claude Code (reload the VS Code window).
3. Re-run the smoke test that triggered the original report:
   - `update_page` with `replace_body=true` → should now produce a
     soft-confirm prompt asking the user to retry with a
     `confirm_token`.
   - `delete_page` → same.
   - `update_page` with `version: "6"` → should succeed where it
     previously failed.

Document the manual smoke-test result in the v6.6.1 release commit
message.

---

## 7. Rollback

If a regression appears post-release:

- v6.6.1 → v6.6.0 is a clean rollback (no schema changes; the only
  state is in-memory).
- Users can also set
  `EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=0` to disable fast-decline
  detection without rolling back; this restores exactly v6.6.0
  behaviour for the elicitation gate.
  - *Implementation note for T1:* a value of 0 (post-clamp: 10 ms)
    is still a valid threshold, so for a literal "off" switch we'd
    need `EPIMETHIAN_DISABLE_FAST_DECLINE_DETECTION=true`. Add that
    env var to T1 in the same change — small enough to not warrant a
    separate task.

---

## 8. Out of scope (explicit)

- A startup-time warning when `TREAT_ELICITATION_AS_UNSUPPORTED=true`
  is set against a client that genuinely supports elicitation. The
  symmetric warning fired by `BYPASS_ELICITATION` for the don't-advertise
  case is a useful nudge; the inverse is much rarer (users explicitly
  opting in) and adds log noise. Skip unless we get a misconfiguration
  report.
- Reporting the fast-decline event in the audit log. The existing
  mutation log captures the eventual write (or non-write); duplicating
  the elicitation telemetry is out of scope for a patch release.
- Filing the upstream Claude Code bug report. Worth doing in parallel
  but not blocking on this plan — the workaround is here.
