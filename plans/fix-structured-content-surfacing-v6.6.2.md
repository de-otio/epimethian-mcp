# Plan: outputSchema declaration + token-in-text fallback (v6.6.2)

Source analysis: [doc/design/investigations/investigate-claude-code-structured-content-surfacing.md](../doc/design/investigations/investigate-claude-code-structured-content-surfacing.md)
(2026-04-30).

v6.6.1 fixed the *server-side* gate — Claude Code's fast decline now
correctly mints a soft-confirm token via the existing v6.6.0 path. But
the *client-side* round-trip is still broken: the agent never sees the
full `confirm_token` because Claude Code (and other clients) ignore
`structuredContent` when no `outputSchema` is declared. Per the MCP
spec (`@modelcontextprotocol/sdk` types):

> If the Tool defines an outputSchema, this field [structuredContent]
> MUST be present in the result, and contain a JSON object that
> matches the schema.
> If the Tool does not define an outputSchema, this field [content]
> MUST be present in the result.

Epimethian's five mutating tools never declared `outputSchema`. Most
clients exercise the spec-permitted liberty of dropping the
unspec'd `structuredContent`. v6.6.2 fixes this at the spec level
(declare `outputSchema`) and adds a configurable opt-in fallback for
clients with documented rendering bugs that drop `content` blocks
when `outputSchema` is present (Claude Code issues `#15412`, `#9962`,
`#39976`).

Verified against tree at commit `70c6f1e`, package `6.6.1`, ~1851
tests passing. Smoke-tested against Claude Code VS Code extension —
soft-confirm token mints correctly, agent receives only the 8-char
tail.

---

## 1. Version sequencing

- **6.6.2 (patch)** — both fixes ship together.
  - This is the spec-correct completion of the v6.6.0 soft-elicitation
    flow that v6.6.1 partially closed. No minor bump warranted.
  - Backwards-compatible: every existing client that string-matches
    `content[0].text` keeps working. Agents that begin to consume
    `structuredContent` get strictly more information than before.

The investigation also lists Option F (file upstream Claude Code
bug). That is filed *outside* this plan — it is not blocking and
the §5.0 fix benefits epimethian regardless of when Claude Code
addresses #15412 et al.

---

## 2. Parallelism strategy

Four independent tasks, dispatched in parallel after §3 contracts
are frozen. Per the project's RAM-vs-parallelism memory, no agent
runs `npm test`; the orchestrator runs the suite once at integration
time.

Per the **always-assess-data-loss-risk** rule, T1 carries a
"data-loss invariants" section. The change is in the destructive-
write critical path: a wrong `outputSchema` shape can cause clients
to (a) reject otherwise-valid responses, (b) lose the human-readable
explanation, or (c) misinterpret a confirmation-required response
as success. All three are tested against in T1 and T2.

| #  | Task                                              | Files                                                                                              | Model  | Worktree   |
| -- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ | ---------- |
| T1 | outputSchema + structuredContent emission         | `src/server/index.ts`, `src/server/elicitation.ts`, `src/server/output-schema.ts` (NEW), tests     | opus   | `agent-t1` |
| T2 | `EPIMETHIAN_TOKEN_IN_TEXT` opt-in fallback        | `src/server/elicitation.ts` (small, additive), `src/server/elicitation.test.ts`                    | sonnet | `agent-t2` |
| T3 | Setup-CLI per-client warning + integration test   | `src/cli/client-configs.ts`, `src/cli/client-configs.test.ts`, `src/server/output-schema-conformance.integration.test.ts` (NEW) | sonnet | `agent-t3` |
| T4 | CHANGELOG, version bump, doc patches              | `CHANGELOG.md`, `package.json`, `plans/opencode-compatibility-implementation.md`, `doc/destructive-flag-prompts.md` | haiku  | `agent-t4` |

**File overlap.** T1 and T2 both touch `elicitation.ts`. The contract
in §3.4 isolates them: T1 owns `formatSoftConfirmationResult`'s
signature and the structuredContent emission; T2 owns *only* a new
guarded branch inside the same function that conditionally appends
the full token to the text block when the env var is set. T2 must
not change the structured payload — it strictly augments the
content text. The handover is a frozen function contract: T1 leaves
the function structured so T2 can splice cleanly.

Merge order: T1 → T2 → T3 → T4 (T4 last so test counts can be
filled in).

Per the **T4-haiku-may-write-to-master observation** from v6.6.1:
explicitly warn T4 in the prompt that its agent runs in a worktree
and it must commit there — *not* on the parent repo's working tree.

---

## 3. Frozen API contracts

### 3.1 New shared module: `src/server/output-schema.ts`

```ts
import { z } from "zod";

/**
 * Shape of `structuredContent` when a destructive write tool needs
 * confirmation. Matches the v6.6.0 soft-elicitation token flow: the
 * agent receives the full token here, surfaces the prompt to the
 * user, and re-invokes with the same parameters plus
 * `confirm_token`.
 *
 * The token lives only in `structuredContent.confirm_token`. It MUST
 * NOT be duplicated into the `content` text array except via the
 * `EPIMETHIAN_TOKEN_IN_TEXT=true` opt-in path (see elicitation.ts).
 */
export const confirmationRequiredArm = z.object({
  kind: z.literal("confirmation_required"),
  confirm_token: z.string().min(16),
  audit_id: z.string(),
  /** ISO 8601 UTC. */
  expires_at: z.string(),
  page_id: z.string(),
  /** Numeric counts only — never tenant content. */
  deletion_summary: z
    .object({
      tocs: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
      structured_macros: z.number().int().nonnegative(),
      code_macros: z.number().int().nonnegative(),
      plain_elements: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
    })
    .optional(),
  /** Human-readable summary, also in content[0].text. */
  human_summary: z.string(),
});

/** Success arm for tools that *write* to a page (everything except delete). */
export const writeSuccessArm = z.object({
  kind: z.literal("written"),
  page_id: z.string(),
  new_version: z.number().int().positive(),
  /** Pre→post body byte counts (when computable). */
  body_bytes_before: z.number().int().nonnegative().optional(),
  body_bytes_after: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
});

/** Success arm for `delete_page`. */
export const deleteSuccessArm = z.object({
  kind: z.literal("deleted"),
  page_id: z.string(),
  /** Last-known version before deletion. */
  last_version: z.number().int().positive(),
});

/** outputSchema for the four write-mutating tools (update / append / prepend / section). */
export const writeOutputSchema = z.discriminatedUnion("kind", [
  writeSuccessArm,
  confirmationRequiredArm,
]);

/** outputSchema for delete_page. */
export const deleteOutputSchema = z.discriminatedUnion("kind", [
  deleteSuccessArm,
  confirmationRequiredArm,
]);

export type WriteOutput = z.infer<typeof writeOutputSchema>;
export type DeleteOutput = z.infer<typeof deleteOutputSchema>;
```

The `kind` discriminator is the canonical way agents distinguish
"the write happened" from "we need approval." Both arms are JSON-
serialisable and never carry tenant content beyond the page id and
counters.

### 3.2 `formatSoftConfirmationResult` returns the structured payload

Updated signature (in `src/server/elicitation.ts`):

```ts
export function formatSoftConfirmationResult(
  err: SoftConfirmationRequiredError,
  params: {
    pageId: string;
    deletionSummary?: DeletionSummary;
  },
): {
  content: { type: "text"; text: string }[];
  isError: true;
  structuredContent: z.infer<typeof confirmationRequiredArm>;
} {
  // ... existing text2 generation ...
  const structuredContent: z.infer<typeof confirmationRequiredArm> = {
    kind: "confirmation_required",
    confirm_token: err.token,
    audit_id: err.auditId,
    expires_at: new Date(err.expiresAt).toISOString(),
    page_id: params.pageId,
    deletion_summary: params.deletionSummary
      ? toDeletionSummarySnakeCase(params.deletionSummary)
      : undefined,
    human_summary: err.humanSummary,
  };
  // ... env-var conditional (T2) splices here ...
  return { content: [{ type: "text", text: text2 }], isError: true, structuredContent };
}
```

The `kind: "confirmation_required"` discriminator is added (was
implicit before). All other fields are renamed to snake_case to
match the success arms and to fit JSON-Schema convention. Tests
must pin these names — agents will key on them.

### 3.3 `EPIMETHIAN_TOKEN_IN_TEXT` env var (T2)

```
EPIMETHIAN_TOKEN_IN_TEXT=true
```

When set, the `formatSoftConfirmationResult` text block gets an
extra trailing line:

```
[FALLBACK] Full token (EPIMETHIAN_TOKEN_IN_TEXT=true): <full-token>
```

with a leading `\n\n` and the literal `[FALLBACK]` prefix so it's
unambiguous.

Constraints:

- The structured payload is **unchanged** — token still lives in
  `structuredContent.confirm_token`. The env var is strictly
  additive.
- The fallback line includes the env-var name explicitly so
  forensic readers know how it got there. Nothing infers it from
  user data.
- The function still has a "tail only" line above it — the
  fallback line is in addition to the tail, not a replacement.
  Agents that already work with `structuredContent` ignore the
  fallback line.

### 3.4 outputSchema wired into the five tool registrations

In `src/server/index.ts`:

- `update_page`, `update_page_section`, `append_to_page`,
  `prepend_to_page` → `outputSchema: writeOutputSchema`.
- `delete_page` → `outputSchema: deleteOutputSchema`.

The success path of each handler must emit a structuredContent
matching the relevant success arm. Concretely, the handler return
shape becomes:

```ts
return {
  content: [{ type: "text", text: existingHumanReadableText }],
  structuredContent: { kind: "written", page_id, new_version, ... },
};
```

(or `kind: "deleted"` for `delete_page`).

The text content is unchanged from v6.6.1 — every existing agent
that string-matches the success message keeps working.

### 3.5 Per-client setup-CLI snippet (T3)

Update `src/cli/client-configs.ts` — for `claude-code-vscode` and
any other client whose docs/issues indicate render quirks:

- Append a final paragraph in the warning text:
  *"v6.6.2 declares an `outputSchema` on every write tool, so a
  spec-compliant client should now surface the soft-confirm
  `structuredContent` to the agent. If your version of Claude Code
  drops content blocks when structuredContent is present
  (issue #15412), set `EPIMETHIAN_TOKEN_IN_TEXT=true` as a
  fallback — this restores the human-readable explanation by also
  putting the full token in the text block."*

- Do NOT default `EPIMETHIAN_TOKEN_IN_TEXT=true` in the snippet.
  Pre-set it only if the user opts in via a new `--with-fallback`
  flag (out of scope for v6.6.2 unless trivial — defer).

The other six client entries (`claude-code`, `claude-desktop`,
`cursor`, `windsurf`, `zed`, `opencode`) are unchanged — they
should work cleanly with §3.4's `outputSchema` declaration.

---

## 4. Tasks

### T1 (opus) — outputSchema declaration + structured payload emission

**Files:**
- `src/server/output-schema.ts` (NEW, per §3.1)
- `src/server/output-schema.test.ts` (NEW)
- `src/server/index.ts` (5 tool registrations + 5 success-path handler returns)
- `src/server/elicitation.ts` (`formatSoftConfirmationResult` shape change per §3.2)
- `src/server/elicitation.test.ts` (update existing tests for new field names)
- `src/server/soft-elicitation.integration.test.ts` (update assertions to match `kind: "confirmation_required"`)

**Subtasks:**

1. Create `src/server/output-schema.ts` per §3.1.
2. Tests for the schema in `src/server/output-schema.test.ts`:
   - `writeOutputSchema` accepts a valid success object.
   - `writeOutputSchema` accepts a valid confirmation_required object.
   - `writeOutputSchema` rejects mixed shapes (e.g., `kind: "deleted"` for write tools).
   - `deleteOutputSchema` accepts both arms.
   - Discriminator-mismatch is rejected with a clear error.
3. Update `formatSoftConfirmationResult` per §3.2:
   - Add `kind: "confirmation_required"`.
   - Rename `confirm_token` (already snake), `audit_id` (was camel-mixed in some places — verify), `expires_at` (was ISO string), `page_id`, `deletion_summary`, `human_summary` — all snake_case.
   - Validate the emitted payload against `confirmationRequiredArm` at runtime when `process.env.NODE_ENV !== "production"` (debug-build safety net).
4. Add `outputSchema` to each of the five tool registrations in
   `src/server/index.ts`:
   - `update_page` → `writeOutputSchema`
   - `update_page_section` → `writeOutputSchema`
   - `append_to_page` → `writeOutputSchema`
   - `prepend_to_page` → `writeOutputSchema`
   - `delete_page` → `deleteOutputSchema`
5. Update each success-path handler return to include
   `structuredContent` matching the respective success arm. Existing
   text content is preserved verbatim.
6. Update existing tests in `elicitation.test.ts` and
   `soft-elicitation.integration.test.ts` that reference
   `confirm_token`, `audit_id`, `expires_at`, `page_id` to expect the
   new snake_case keys and `kind: "confirmation_required"`. Pin the
   discriminator explicitly.

**Data-loss invariants — must be tested:**

- The token's full byte sequence is reachable from
  `structuredContent.confirm_token` after T1's changes. No
  truncation.
- `validateToken` accepts the byte sequence emitted by
  `formatSoftConfirmationResult` (round-trip test).
- A `confirmation_required` payload **must not** validate against
  `writeSuccessArm`. A discriminator collision is a security defect.
- The success path's `kind: "written"` cannot accidentally embed a
  `confirm_token` field (wrong arm leaking secrets). Add a static
  test that asserts the success arm's typescript type does not
  include any of the confirmation-arm secret-bearing fields.
- `humanSummary` in the structured payload is sourced solely from
  numeric counts (existing v6.6.0 invariant) — preserved.

**Strict don'ts:**

- Do NOT run `npm test` or any test runner.
- Do NOT modify `EPIMETHIAN_TOKEN_IN_TEXT` handling — that's T2.
- Do NOT modify `client-configs.ts` — that's T3.
- Do NOT modify CHANGELOG / package.json / docs — that's T4.

**When done:**

- `git add` and `git commit` in the worktree.
- Report: paragraph summary, worktree path, commit SHA, list of
  affected line numbers in `index.ts`.

### T2 (sonnet) — `EPIMETHIAN_TOKEN_IN_TEXT` opt-in fallback

**Files:**
- `src/server/elicitation.ts` (additive change in `formatSoftConfirmationResult`)
- `src/server/elicitation.test.ts` (new tests)

**Subtasks:**

1. In `formatSoftConfirmationResult`, after T1's `text2` generation
   and before the return, splice:

   ```ts
   const tokenInText = process.env.EPIMETHIAN_TOKEN_IN_TEXT === "true";
   const finalText = tokenInText
     ? text2 +
       `\n\n[FALLBACK] Full token (EPIMETHIAN_TOKEN_IN_TEXT=true): ${err.token}`
     : text2;
   // ... return { content: [{ type: "text", text: finalText }], ... } ...
   ```

2. The structured payload is unchanged — env var is additive.
3. Tests:
   - Default (env unset) → text contains `Token tail: ...XXXXXXXX`,
     does not contain the full token.
   - `EPIMETHIAN_TOKEN_IN_TEXT=true` → text contains
     `[FALLBACK] Full token` AND the full token byte sequence.
   - `EPIMETHIAN_TOKEN_IN_TEXT=false` → behaves like default.
   - `EPIMETHIAN_TOKEN_IN_TEXT=1` → behaves like default (only
     `"true"` activates).
   - In both modes, `structuredContent.confirm_token` is the full
     token (regression test for §3.3 invariant).
   - In both modes, the audit ID and expiry remain visible in
     content text.

**Strict don'ts:**

- Do NOT change the structured payload shape — that's T1.
- Do NOT add the env var handling anywhere outside
  `formatSoftConfirmationResult`.
- Do NOT couple this with `EPIMETHIAN_BYPASS_ELICITATION` or other
  env-var precedence; the fallback applies whenever soft-confirm
  fires, regardless of how it fired.

**When done:** commit, report.

### T3 (sonnet) — Setup-CLI warning + integration test

**Files:**
- `src/cli/client-configs.ts`
- `src/cli/client-configs.test.ts`
- `src/server/output-schema-conformance.integration.test.ts` (NEW)

**Subtasks:**

1. In `src/cli/client-configs.ts`, update the `claude-code-vscode`
   entry's `warning` field to include the §3.5 paragraph. Other
   entries unchanged.
2. Update `client-configs.test.ts` to assert the new warning text.
3. New file `src/server/output-schema-conformance.integration.test.ts`:
   - Spin up the in-process MCP server (existing test pattern).
   - Trigger a destructive call to each of the five tools, mocking
     the elicitation client to fast-decline so soft-confirm fires.
   - Assert that the returned `structuredContent` validates
     against the corresponding `outputSchema` arm.
   - Trigger a successful call to each tool with a valid
     `confirm_token`. Assert `structuredContent` validates against
     the success arm.
4. The integration test serves as the §4.1 / §4.3 regression net —
   if a future agent breaks the schema mid-flight, this catches it.

**Strict don'ts:**

- Do NOT modify production source under `src/server/`.
- Do NOT modify `client-configs.ts` for clients other than
  `claude-code-vscode` unless the contract for that other client
  was demonstrably affected (it isn't, per §3.5).

**When done:** commit, report.

### T4 (haiku) — CHANGELOG, version bump, doc patches

**IMPORTANT — file path discipline:** This task runs in a *worktree*.
All edits must be made inside the worktree directory the runtime
hands you, NOT in the parent repo's `/Users/rmyers/repos/dot/epimethian-mcp/`
working tree. The v6.6.1 dispatch had a haiku agent write to the
parent tree by mistake — that produced a clean recovery path but
cost us a stash dance. Don't repeat it: read your worktree path
from the agent runtime context, prefix every edit path with it,
and run `git status` inside the worktree before committing to
verify.

**Files (relative to your worktree root):**
- `CHANGELOG.md`
- `package.json`
- `plans/opencode-compatibility-implementation.md`
- `doc/destructive-flag-prompts.md`

**Subtasks:**

1. `package.json`: bump `version` from `6.6.1` to `6.6.2`.
2. `CHANGELOG.md`: prepend a `## [6.6.2] - 2026-04-30 - structured
   content surfacing` block. Body draft below — adjust for actual
   test counts at integration time:

   ```
   ## [6.6.2] - 2026-04-30 - structured content surfacing

   ### Fixed

   - **Soft-confirmation round-trip works in spec-compliant clients.**
     v6.6.0's design returns the full `confirm_token` in
     `structuredContent.confirm_token`, never in `content` text. But
     epimethian's mutating tools never declared an `outputSchema`,
     and per the MCP spec clients are obliged to forward
     `structuredContent` to the agent only when one is declared.
     Without it, most clients (verified: Claude Code in our smoke
     test; OpenCode via Vercel AI SDK without outputSchema)
     dropped the field. v6.6.2 declares `outputSchema` on
     `update_page`, `update_page_section`, `append_to_page`,
     `prepend_to_page`, and `delete_page`. Spec-compliant clients
     now MUST forward the structured payload to the agent.
   - All five tools now also emit a `kind: "written"` /
     `"deleted"` structured payload on success — agents can parse
     `new_version`, `body_bytes_after`, etc. without string-matching
     the human-readable text.

   ### Added

   - **`EPIMETHIAN_TOKEN_IN_TEXT=true`** — opt-in fallback for
     clients that ignore `outputSchema` declarations or drop
     `content` blocks when structured content is present (Claude
     Code issues #15412, #9962, #39976). When set, the soft-confirm
     `content` text appends a `[FALLBACK] Full token` line. The
     structured payload is unchanged — env var is strictly
     additive. Trade-off: token now visible in agent transcripts
     (the security choice v6.6.0 explicitly avoided), so use only
     when needed.

   ### Changed

   - Soft-confirm `structuredContent` field names are now snake_case
     (`confirm_token`, `audit_id`, `expires_at`, `page_id`,
     `deletion_summary`, `human_summary`) and discriminated by
     `kind: "confirmation_required"`. Agents that consumed the
     v6.6.0 keys (which were already snake_case for `confirm_token`
     but inconsistent for others) need a small key-name update —
     check the new outputSchema declaration in
     `src/server/output-schema.ts`.

   ### Tests

   Net test delta vs v6.6.1: +XX (1851 → XXXX passing). Coverage:
   schema unit tests, end-to-end integration test that asserts the
   emitted `structuredContent` validates against the declared
   `outputSchema` for both success and confirmation_required arms,
   `EPIMETHIAN_TOKEN_IN_TEXT` toggle tests.

   ### Investigation

   See `doc/design/investigations/investigate-claude-code-structured-content-surfacing.md`
   for the root-cause analysis.
   ```

3. `plans/opencode-compatibility-implementation.md`: append a v6.6.2
   addendum noting that structuredContent surfacing is now
   spec-correct via outputSchema.
4. `doc/destructive-flag-prompts.md`: extend the existing v6.6.1+
   env-var section with a paragraph on `EPIMETHIAN_TOKEN_IN_TEXT`
   and a note that v6.6.2's outputSchema makes it unnecessary in
   most clients.

**Strict don'ts:**

- Do NOT touch any source under `src/`.
- Do NOT fill in test counts — the orchestrator does that at
  integration time using actual numbers.

**When done:** commit *inside the worktree*, report.

---

## 5. Security & data-loss review

Before merging T1: the orchestrator runs through this checklist (no
security-reviewer agent dispatch — surface is small). Per the
**always-assess-data-loss-risk** memory:

1. **Token byte-sequence integrity.** Round-trip test: emit a
   `SoftConfirmationRequiredError`, run it through the new
   `formatSoftConfirmationResult`, parse `structuredContent.confirm_token`
   from the result, pass it to `validateToken`. Must succeed.
2. **No token leak in the success arm.** The `writeSuccessArm` and
   `deleteSuccessArm` cannot contain `confirm_token` /
   `audit_id` even by accident. Static type test: assert the TS
   types of the two arms have disjoint key sets except `page_id`,
   `kind`, and the explicit shared fields.
3. **Discriminator integrity.** A confirmation-required payload
   must NOT validate against any success arm. Test:
   `writeSuccessArm.safeParse(confirmationRequiredArm.parse(...))`
   must fail. Reverse direction must also fail.
4. **Fallback token in text is opt-in.** With
   `EPIMETHIAN_TOKEN_IN_TEXT=true`, the full token appears in the
   `content` text. Test that the env var name is part of the
   appended line (so a forensic reader can pinpoint the cause).
   Test that the structured payload is *also* still emitted —
   never replace, only append.
5. **No tenant content interpolated into structured fields.** The
   `human_summary` is generated from numeric counts only. The
   `deletion_summary` arms enforce numeric types. Add a test that
   passes a maliciously-shaped tenant string and asserts it does
   not appear in the structured payload.
6. **Backwards compatibility for legacy agents.** The text content
   on success is unchanged; the new structured payload is purely
   additive. Test: an agent that consumes only `content[0].text`
   still receives the same string as in v6.6.1 (ignoring the new
   structured-payload presence).
7. **Multi-tenant safety unchanged.** v6.6.0's tenant binding lives
   in `mintToken`'s 5-field validation. T1 does not touch that
   path. Verify by grep: `mintToken` and `validateToken` are NOT
   in T1's diff.

---

## 6. Verification

After T1–T4 merge, **once**:

```bash
npm test
npx tsc --noEmit

# §3.4 outputSchema declarations exist on all five tools:
grep -n 'outputSchema:' src/server/index.ts | wc -l    # expect 5

# §3.2 structured payload uses snake_case:
grep -nE 'confirm_token|audit_id|expires_at|page_id|human_summary|deletion_summary' \
  src/server/elicitation.ts | head -20

# §3.3 env var is read in elicitation.ts only:
grep -rn 'EPIMETHIAN_TOKEN_IN_TEXT' src/                 # expect: src/server/elicitation.ts only

# T3 conformance test exists:
ls src/server/output-schema-conformance.integration.test.ts
```

Then a manual smoke test against a freshly published v6.6.2 (or a
local tarball install) with the live Claude Code extension:

1. Trigger `update_page` with `replace_body=true`. Verify the
   agent receives the **full** `confirm_token` (not just the tail).
2. Re-invoke with the token — write succeeds.
3. Trigger `delete_page`. Verify same flow; token retrievable;
   delete completes.
4. As a control: set `EPIMETHIAN_TOKEN_IN_TEXT=true`. Verify the
   `[FALLBACK]` text line appears AND the structured payload is
   still emitted. Re-invoke succeeds.

After the manual smoke test passes, prune `887881730` (the v6.6.0
test page that has been parked at v8 since the v6.6.1 smoke test).

---

## 7. Pre-flight: MCP Inspector dry-run

Before publishing v6.6.2 to npm, run the §4.1 validation from the
investigation:

```bash
npm pack
npx -y @modelcontextprotocol/inspector \
  /opt/homebrew/opt/node/bin/node \
  /opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp/dist/cli/index.js
```

(Replace the install path with the local tarball install if
testing pre-publish.) Trigger a destructive call from the
Inspector UI; verify `structuredContent` is well-formed JSON
matching the declared schema.

If Inspector reports a schema-validation failure, fix the
discrepancy *before* publishing — every spec-compliant client
will reject the response otherwise.

---

## 8. Out of scope (explicit)

- **MCP spec clarification.** Whether `structuredContent` should be
  MUST-forward on `isError: true` regardless of `outputSchema` is
  an upstream-spec conversation. File at
  `modelcontextprotocol/specification` separately.
- **Filing the upstream Claude Code issue.** Do this in parallel
  with v6.6.2; not blocking. Reference the investigation file in
  the bug report.
- **Per-client behaviour matrix.** A documented matrix of
  `structuredContent` and `outputSchema` handling across all
  known MCP clients would help future onboarding. Out of scope for
  v6.6.2 unless someone independently produces it.
- **Additive: `--with-fallback` flag on setup-CLI.** Pre-setting
  `EPIMETHIAN_TOKEN_IN_TEXT=true` in a per-client snippet via a
  user opt-in. Defer until we know how often it is actually needed
  in practice.
- **Test page cleanup.** `887881730` lives on until v6.6.2's smoke
  test confirms the round-trip works end-to-end. Then delete via
  the now-functional `delete_page` flow as the *final* smoke test.

---

## 9. Rollback

- v6.6.2 → v6.6.1 is a clean rollback.
  `outputSchema` declarations are tool-registration metadata —
  removing them reverts the spec obligation.
- The `EPIMETHIAN_TOKEN_IN_TEXT` env var is opt-in; unsetting it
  restores the prior behaviour without a rollback.
- The snake_case rename in `structuredContent` field names is the
  one breaking change for agents that already consumed v6.6.0's
  field names. Mitigation: the v6.6.1 → v6.6.2 transition is
  expected to enable agents to consume the structured payload for
  the *first time* (because Claude Code et al. dropped it before),
  so few agents will have keyed off the v6.6.0 names.
