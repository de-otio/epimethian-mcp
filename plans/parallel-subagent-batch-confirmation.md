# Plan: Enable parallel subagent destructive writes (batch confirmation)

**Status:** analysis + design proposal, no work started.
**Catalyst:** an orchestrating agent attempted to fan out 11 parallel
`update_page` calls (one per page, `replace_body: true`) by dispatching
11 sub-agents in one message. Of the 11, only 1 sub-agent ran; that one
hit the soft-confirmation gate and could not retrieve the full
`confirm_token` from its tool-result surface. Net result: zero pages
updated, ~3 minutes of wall-clock burned, and orchestrator confidence
shaken.

This is the third time the user has hit this pattern. It blocks any
"do N independent destructive Confluence writes in parallel" workflow,
which is a real and recurring need (large doc-tree refreshes, bulk
banner removals, post-migration cleanups).

The Claude Code permission UX side (11 simultaneous `Agent`-tool prompts)
is out of scope for this repo. This plan is about what
**`epimethian-mcp`** can do.

## TL;DR

The current soft-confirmation flow is intrinsically per-call and
intrinsically interactive. Both properties make it ill-suited to
fan-out:

- **Per-call** means N destructive operations cost N elicitation
  round-trips. With sub-agents, each round-trip travels through a
  separate tool-result surface that may truncate the token.
- **Interactive** means each call adds a user-visible prompt. A
  fan-out that feels safe to the orchestrator (one `AskUserQuestion`
  for "shall I rewrite these 13 pages?") still produces 13 prompts
  downstream.

The proposed fix: **pre-authorisation batch tokens.** The orchestrator
asks the user *once* for permission to mutate a specific list of pages,
receives a `batch_token`, and passes that token into each subsequent
`update_page` / `update_page_section` / `delete_page` call (via
sub-agents or directly). The MCP validates the token, checks the
`page_id` is in the allowlist, decrements a counter, and proceeds
without further elicitation.

This change is **additive** — the existing `confirm_token` flow stays.
Single-page interactive use is unaffected. Sub-agent piping issues are
sidestepped because the same `batch_token` is reused across all
sub-agents; no agent ever needs to receive a token from a tool result.

## What the current code does

(For maintainers: see `src/server/elicitation.ts` and
`src/server/safe-write.ts:formatSoftConfirmationResult` for the
authoritative implementation.)

When a destructive flag (`replace_body`, `confirm_deletions`,
`confirm_shrinkage`, `confirm_structure_loss`) is set:

1. `gateOperation` is called with `cloudId`, `pageId`, `pageVersion`,
   `diffHash` (computed from the canonical post-prepare XML).
2. If the client supports MCP elicitation: prompt the user; on accept,
   proceed.
3. If the client does **not** support elicitation but all four
   soft-mode fields are present: mint a token bound to
   `(cloudId, pageId, pageVersion, diffHash)` with a 5-minute TTL,
   throw `SoftConfirmationRequiredError`. The handler in `index.ts`
   wraps that into:
   ```json
   {
     "isError": true,
     "content": [{ "type": "text", "text": "...token tail: ...kcDyeyvT..." }],
     "structuredContent": {
       "kind": "confirmation_required",
       "confirm_token": "<full token>",
       "audit_id": "...",
       "expires_at": "...",
       "page_id": "...",
       "human_summary": "..."
     }
   }
   ```
4. The agent reads `structuredContent.confirm_token`, surfaces the
   prompt to the user, retries the same call with the token. The
   token is single-use, validated against the same `(page_id, version,
   diffHash)` it was minted with, and consumed.

The `EPIMETHIAN_TOKEN_IN_TEXT=true` env var splices the full token
into `content[0].text` as a fallback for clients (Claude Code) that
don't surface `structuredContent` on `isError: true` responses
(referenced as Claude Code issues #15412, #9962, #39976 in
`safe-write.ts:683`).

## Why this fails for sub-agent fan-out

Three independent failure modes, in roughly this order of impact:

### F1. Per-call cost compounds across the fan-out boundary

For an orchestrator dispatching N sub-agents, each sub-agent makes its
own first call to `update_page`, hits the gate, gets back an
`isError: true` result. The token is in `structuredContent` (and, with
the env var, in `content[0].text`). For each sub-agent, the agent
must then:

1. Parse the token from the tool result.
2. Decide it has user authority to retry (it doesn't — the user
   approved the orchestrator's plan, not this specific MCP-level
   confirmation).
3. Either bail (current observed behaviour: the sub-agent reports
   "blocked, full token not surfaced") or retry blindly (which is
   worse — silent bypass).

Even if the token *were* perfectly surfaced, the sub-agent's correct
behaviour is to escalate back to the orchestrator, who escalates to
the user. That makes fan-out useless: the user is now answering N
prompts.

### F2. Tool-result piping across sub-agent boundaries truncates

Observed empirically: `structuredContent.confirm_token` does not reach
the sub-agent's view of the tool result. `content[0].text` only
contains the "token tail" (last 8 chars) unless `EPIMETHIAN_TOKEN_IN_TEXT=true`
is set. Even with that env var, sub-agent-result handling in some MCP
clients truncates long fields.

This is a Claude Code / MCP transport concern that we cannot fix
from inside the server, but it amplifies F1.

### F3. The token is bound to a diff that the orchestrator hasn't computed yet

The diff hash is computed from canonical post-prepare XML. The
orchestrator (the parent agent that wants to fan out) doesn't have
the diff at the moment it would want to ask the user "is the whole
batch OK?" — only each sub-agent computes its own diff. So the
current model can't answer "pre-authorise these N writes" because
"these N writes" don't exist as a hashable artefact yet.

## Design options

Three options, from least to most invasive.

### Option A — Surface the token reliably, don't change the model

- Make `EPIMETHIAN_TOKEN_IN_TEXT=true` the **default**. Add an opt-out
  env var (`EPIMETHIAN_HIDE_TOKEN_IN_TEXT=true`) for setups that have
  reliable structuredContent piping and want the leaner text response.
- Document that sub-agents must surface the soft-confirm result to
  their parent / orchestrator, not consume the token themselves.

**Note on framing:** `install-agent.md:484` already instructs Claude
Code users to set `EPIMETHIAN_TOKEN_IN_TEXT=true`. So this isn't a fix
for users following the docs — it's making the default match the
documented setup, narrowing the failure mode to "user skipped the env
var step." It is **not** a meaningful F2 mitigation for the fan-out
case (sub-agent transports may still drop long fields), and shouldn't
be sold as one.

**Pros:** smallest change. Closes the doc-skipped-env-var gap.
**Cons:** doesn't help F1 (still N round-trips, still N prompts) or
F3. Doesn't unlock parallel work — the user still answers N prompts.
Doesn't reliably eliminate F2 either; transport truncation can still
bite even when the token is in the text block.
**Verdict:** ship as a defaults-only patch. Not sufficient on its own;
it just makes the existing single-page flow more robust for
under-configured installs.

### Option B — Bulk tool: `update_pages` (one call, many pages)

Add a new tool that takes an array of operations and runs them server-
side:

```ts
update_pages({
  cloudId,
  operations: [
    { page_id, version, title, body, replace_body, ... },
    { page_id, version, title, body, replace_body, ... },
    ...
  ],
  source: "user_request",
  confirm_token?: string,  // single token covers the whole batch
})
```

Soft-confirm fires **once** for the whole array. The diff hash is the
hash of (concatenation of per-op diff hashes); the token is bound to
that aggregate. On accept, the server walks `operations` serially and
returns an array of per-op results.

**Pros:** one prompt, one token, fits the existing soft-confirm model
without redesign.
**Cons:**
- The orchestrator must compute all bodies up-front. For a
  Confluence rewrite where each page draft costs a few minutes of
  agent thinking, having to draft all 13 pages before submitting
  defeats parallelism — the drafts are the slow part, not the API
  call.
- Returning a partial result on mid-batch failure is awkward (which
  ops succeeded? what's the rollback?).
- Doesn't compose with sub-agents (sub-agents are good at
  parallelising the *drafting*, not the *publishing*).

**Verdict:** useful for some workflows (programmatic batch fixes
where the bodies are known in advance — bulk banner removal, bulk
label addition). Not the primary fix for parallel-drafting fan-out.
Worth shipping in parallel with C.

### Option C — Pre-authorisation batch token (RECOMMENDED)

New tool `authorise_destructive_writes` issues a session-bound batch
token after a single elicitation. Subsequent destructive calls accept
either `confirm_token` (existing) or `batch_token` (new) and skip the
per-call gate when `batch_token` is valid.

```ts
authorise_destructive_writes({
  cloudId: "<sealed cloudId>",
  page_ids: ["644251678", "644677642", "645234690", ...],  // explicit allowlist, max 50
  ttl_seconds: 3600,                                       // capped at 3600
  max_operations: 13,                                      // defaults to page_ids.length; cap = page_ids.length × 2
  reason: "Bulk doc refresh: rewrite N runbook pages"      // shown to user
})
```

Returns (after a SINGLE soft-confirm or live elicitation):

```ts
{
  batch_token: "btk_<32 bytes hex>",
  expires_at: "2026-05-07T07:30:00Z",
  authorised_page_ids: [...],
  remaining_operations: 50,
  audit_id: "..."
}
```

Subsequent destructive calls accept it as an alternative to
`confirm_token`:

```ts
update_page({
  page_id: "644251678",
  version: "current",
  title: "...",
  body: "...",
  replace_body: true,
  source: "user_request",
  batch_token: "btk_..."          // NEW
})
```

Server-side validation (in `gateOperation`, behind a new branch
before the existing rows):

1. `batch_token` is present and well-formed (32 hex bytes prefixed
   `btk_`).
2. The token exists in the in-memory store and has not expired.
3. The token's `cloudId` matches the request's resolved cloudId.
4. `page_id` is in the token's `authorised_page_ids` allowlist.
5. The token's `remaining_operations` counter is >0; **reserve** one
   slot (atomic decrement-then-record-reservation-id). If exhausted,
   refuse with `BATCH_TOKEN_INVALID` (see invariant below).
6. `source` is still required and validated as today.

If all checks pass, the gate is bypassed and the write proceeds. The
reserved slot is **refunded** only when the underlying write call
fails before any server-side mutation could have occurred — i.e. local
preparation errors, schema validation failures, and pre-flight
`confluence-client` errors that cleanly mapped to "request never
reached Confluence." HTTP-layer errors that may have mutated state
(timeouts after send, 5xx after request entered the server) keep the
slot consumed; we cannot distinguish "wrote and lost the response"
from "didn't write" and must assume the worst.

This mirrors the reservation semantics already used by `write-budget.ts`
for write-quota accounting — a flaky sub-agent does not burn through
the operation budget on local validation failures, but a half-mutated
remote write does count.

If any of checks 1–6 fails, fall through to the existing per-call gate
(so the orchestrator can recover by handling a `confirm_token`
round-trip instead).

**Validation-failure invariant (mirrors `confirmation-tokens.ts:41-44`):**
batch-token validation returns a single opaque `BATCH_TOKEN_INVALID`
reason to the caller; granular reasons (`unknown`, `expired`,
`page_id_not_authorised`, `exhausted`, `cloudid_mismatch`) flow only
into the `onValidate` audit hook. This avoids an oracle that lets a
malicious orchestrator probe the token store ("which page IDs are
authorised right now?", "is this token expired or did I never have
it?"). The fall-through to the per-call gate then runs as if no
`batch_token` had been supplied — the agent sees the normal
`SOFT_CONFIRMATION_REQUIRED` response, not a different error class.

#### Sub-agent flow

```
[parent agent]
  → AskUserQuestion("Rewrite these 13 pages?")  ← Claude Code UX, not MCP
  → user approves
  → mcp.authorise_destructive_writes({ page_ids: [...13 IDs...], ttl: 3600 })
  → soft-confirm fires (or live elicitation), user approves
  → batch_token returned to parent
  ↓
[parent dispatches 13 sub-agents, each given the batch_token in its prompt]
  ↓
[sub-agent N]
  → reads sources, drafts page N
  → mcp.update_page({ page_id, body, replace_body: true,
                       source: "user_request", batch_token })
  → server: page_id ∈ allowlist? ✓; counter > 0? ✓; decrement; proceed
  → page updated
  → sub-agent reports back to parent
```

No per-sub-agent elicitation. The token never has to traverse a
tool-result boundary because the parent passes it directly into each
sub-agent's prompt.

#### Security analysis vs. current gate

The current gate's load-bearing properties:

| Property | Current gate | Batch token |
|---|---|---|
| Per-page user signal | yes (per call) | yes (page_ids enumerated up-front) |
| Diff binding | yes (`diffHash` bound) | **no** — only page_id allowlist |
| TTL | 5 min | up to 1 h (capped, not configurable) |
| Single-use | yes | no — `max_operations` cap |
| `source` provenance check | yes | yes (unchanged) |
| Rate-limit on mint | yes | yes (`authorise_destructive_writes` itself is rate-limited) |
| Explicit user approval | per-call | per-batch (one elicitation for the whole list) |

The single weaker property is **diff binding**. The existing token's
diff binding defends against this poisoning case:

> A page contains injected instructions that get the agent to call
> `update_page` on *that same page* with adversarial content.
> Because the diff hash changes between when the user approved and
> when the malicious call lands, the token doesn't validate.

With a batch token, the page_id is pre-approved. The defence becomes:

> The user must approve the page_id list before any drafting happens.
> The `page_ids` list is part of the elicitation payload (visible to
> the user). The token covers writes to those page IDs only — but
> any of those writes can have arbitrary content.

This is a real reduction in defence. Mitigations:

1. **Explicit page_id allowlist (no wildcards).** A poisoned page can
   make the agent draft adversarial content, but only for pages the
   user already approved. The injection cannot redirect the write
   target.
2. **`reason` is shown to the user during the elicitation.** The user
   sees what the orchestrator says it's going to do. (Not a strong
   defence — the orchestrator is what's potentially compromised.)
3. **Audit log** records the batch_token mint and every consumption
   (page_id, source, body length). This is forensic, not preventative.
4. **Refuse to mint a batch token from a `chained_tool_output`
   source.** Same provenance gate as today.
5. **Cap TTL and max_operations.** Prevents long-lived high-blast-
   radius tokens.
6. **Optional: server-side flag `EPIMETHIAN_BATCH_REQUIRES_ELICITATION=true`**
   forces `authorise_destructive_writes` to only succeed via live
   elicitation (not soft-confirm). For the Claude Code "fakes
   elicitation" case this would mean batch tokens are unavailable —
   fine; they fall back to the existing soft-confirm path one page
   at a time.

This trade reduces protection against page-content-driven prompt
injection that targets the same page being viewed. In exchange we get
fan-out parallelism. For maintainers driving doc cleanups (the
primary use case), this is the right trade. For semi-autonomous
agents reading random Confluence content, less so.

#### Failure modes worth designing for

- **Token invalidated mid-batch by competing write.** Unlike the
  diff-bound `confirm_token`, a batch token does NOT detect competing
  writes per-page. Concurrent edits can override fresh content. The
  per-call `version: "current"` (or numeric version) handling is
  unchanged — competing writes still surface as 409 conflicts on the
  individual `update_page` call. Document that batch-token mode is
  not a substitute for re-reading versions.
- **Sub-agent fails with bad body.** Per-call result includes the
  failure. Per the reservation semantics above, the slot is refunded
  only on local / pre-flight failures; an HTTP error after the request
  was dispatched keeps the slot consumed (the server cannot prove the
  remote did not mutate).
- **Sub-agent abuses the token to update a different page.** The
  page_id allowlist prevents this. Unauthorised page_id → fall
  through to per-call gate (with the opaque-reason invariant above —
  the agent only learns "batch token didn't cover this", not why).

#### API surface — proposed

Add to `index.ts`:

```ts
server.registerTool(
  "authorise_destructive_writes",
  {
    description: describeWithLock(
      withDestructiveWarning(
        "Pre-authorise a batch of destructive Confluence write operations. " +
        "Returns a batch_token that can be passed to subsequent update_page / " +
        "update_page_section / delete_page calls in place of confirm_token. " +
        "Single user prompt covers the entire batch. Use when fanning out " +
        "destructive writes across multiple pages (sub-agent fan-out, bulk " +
        "doc refreshes). The token is page-id-scoped — calls to pages outside " +
        "the allowlist fall through to the per-call confirmation gate.\n\n" +
        "If your MCP client does not support in-protocol confirmation, this " +
        "tool returns SOFT_CONFIRMATION_REQUIRED on the first call. STOP and " +
        "ask the user. If approved, re-call with the same parameters plus " +
        "confirm_token. The batch_token returned then covers all subsequent " +
        "destructive writes within page_ids until ttl_seconds elapse or " +
        "max_operations are exhausted."
      ),
      config
    ),
    inputSchema: {
      cloudId: z.string().describe(...),
      page_ids: z.array(z.string()).min(1).max(50)
        .describe("Explicit list of page IDs the batch_token is valid for."),
      ttl_seconds: z.number().int().min(60).max(3600).default(900)
        .describe("Token lifetime, capped at 3600 (1h)."),
      max_operations: z.number().int().min(1).max(100).optional()
        .describe(
          "Operation cap. Defaults to page_ids.length (one successful " +
          "write per page). Maximum allowed is page_ids.length × 2 — " +
          "headroom that exists only to absorb network-layer retries " +
          "the server cannot distinguish from real conflicts; do NOT " +
          "rely on it for application-level retry budgets."
        ),
      reason: z.string().min(10).max(500)
        .describe("Human-readable purpose, shown to the user during confirmation."),
      source: sourceSchema,
      confirm_token: z.string().optional()
        .describe("Soft-confirmation token from a prior SOFT_CONFIRMATION_REQUIRED response."),
    },
    outputSchema: batchAuthorisationSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  async (args) => { /* ... */ }
);
```

Modify the destructive-tool input schemas (`update_page`,
`update_page_section`, `delete_page`) to accept an optional
`batch_token`:

```ts
batch_token: z.string().optional()
  .describe(
    "Batch authorisation token from a prior authorise_destructive_writes call. " +
    "Bypasses per-call confirmation if valid for this page_id."
  ),
```

In each handler's gating logic, before the existing `gateOperation`
call: if `batch_token` is set, attempt the batch validation; on
success skip the gate; on failure continue to the existing path
(don't error — fall through, so the agent can recover). Per the
validation-failure invariant above, the fall-through must not leak
*why* the batch token was rejected — the agent simply gets the
normal `SOFT_CONFIRMATION_REQUIRED` from the per-call gate.

Add a new module `src/server/batch-tokens.ts` mirroring
`confirmation-tokens.ts`:
- In-memory `Map<batchTokenId, BatchTokenRecord>` with TTL eviction.
- Reservation-style operation accounting: `reserveOperation()` returns
  a `reservationId` on success, `refundOperation(reservationId)` is
  idempotent and a no-op if the reservation has already been finalised.
- `validateBatchToken({ token, cloudId, pageId })` returns
  `{ valid: true, reservationId } | { valid: false }` to the caller;
  the granular reason (`unknown`, `expired`,
  `page_id_not_authorised`, `exhausted`, `cloudid_mismatch`) is passed
  to the `onValidate` audit hook only.
- `mintBatchToken({ cloudId, pageIds, ttlSeconds, maxOperations })`.
- Independent rate-limit budget from `confirmation-tokens.ts` (mints
  here represent batch authorisations, not per-page confirmations,
  so they share neither budget nor counters).

Add unit tests parallel to `confirmation-tokens.test.ts` covering
mint, validate, expiry, allowlist enforcement, decrement, exhaustion.

Add an integration test `batch-confirmation.integration.test.ts`
covering: mint a batch token via soft-confirm, use it for 3 page
updates, verify only ONE soft-confirm prompt fires, verify the 4th
update (over the cap) falls through to per-call gate.

#### Compatibility

- Existing `confirm_token` flow is unchanged. Old clients keep
  working.
- New `batch_token` is a new opt-in field. Adding it to existing tool
  schemas is non-breaking.
- The new `authorise_destructive_writes` tool is additive.
- `EPIMETHIAN_BATCH_REQUIRES_ELICITATION=true` is a new opt-in flag;
  default false. Operators wanting a stricter posture can enable it.

#### Versioning

- Current shipped version is **6.7.1**. This work targets **6.8.0**
  (minor) — new tool, new field on existing schemas.
- Option A (default-on `EPIMETHIAN_TOKEN_IN_TEXT`) ships first as a
  **6.7.2** patch. It is independent of batch tokens — its job is to
  close the under-configured-install gap for the existing single-page
  flow, per the framing note in §Option A above.

## Out of scope

- **Cross-tenant batch tokens.** A batch_token is bound to a single
  cloudId. Multi-tenant orchestrators must mint one per tenant.
- **Persistent / cross-session tokens.** In-memory only, evicted on
  process restart, like `confirm_token`.
- **Wildcard / glob page allowlists.** Explicit IDs only. Wildcards
  would re-introduce the redirect-injection risk that the explicit
  allowlist exists to prevent.
- **Claude Code permission UX.** Reducing the count of `Agent`-tool
  permission prompts on the orchestrator's side is a Claude Code
  concern, not an MCP concern.

## Sequencing

Current shipped: **6.7.1**.

1. **6.7.2 patch:** flip `EPIMETHIAN_TOKEN_IN_TEXT` to default-on; add
   opt-out env var (`EPIMETHIAN_HIDE_TOKEN_IN_TEXT=true`). Update
   `install-agent.md` so the per-client guidance no longer asks Claude
   Code users to set the env var. Pure defaults change (Option A).
2. **6.8.0 minor:** Option C — `authorise_destructive_writes` +
   `batch_token` field on destructive tools + tests + docs.
3. (Optional, later) **6.9.0 minor:** Option B — `update_pages` bulk
   tool. Lower priority; serves a different use case (pre-computed
   bulk fixes). Ship only if real demand.

## Open questions

- Does the in-memory batch-token store need eviction semantics
  beyond TTL? (e.g. on cloudId rotation, on process suspend/resume.)
  Probably no — same answer as `confirm_token`'s store.
- Should the batch token cover create_page too? Today create_page is
  not gated, but bulk page creation is a plausible workflow (creating
  N child pages from a template). Out of scope for the v6.8.0 cut;
  re-evaluate if requested.
- Should the human-summary shown to the user during the batch
  authorisation include per-page titles? Tradeoff: more informative
  but `pageTitle` is tenant-controlled (prompt-injection surface). The
  same §3.5 invariant in `elicitation.ts:466` applies — the
  human-summary should be derived only from numeric facts and the
  user-supplied `reason`. Page IDs are safe; titles are not.

## References

- `src/server/elicitation.ts` — current gate, `SoftConfirmationRequiredError`
- `src/server/confirmation-tokens.ts` — token mint/validate primitives to mirror
- `src/server/safe-write.ts:formatSoftConfirmationResult` — soft-confirm result shape
- `plans/opencode-compatibility-implementation.md` — origin of soft-confirm
- `plans/fix-claude-code-elicitation-and-version-schema.md` — fast-decline detection (related)
- `install-agent.md` — soft-confirm protocol docs to extend
