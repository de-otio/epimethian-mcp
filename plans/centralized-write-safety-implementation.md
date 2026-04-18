# Implementation Plan: Centralized Write Safety

**Companion to:** [centralized-write-safety.md](centralized-write-safety.md)
**Drafted:** 2026-04-17 (tree state: v5.4.2)

This document maps the design into concrete, parallelisable work. The design plan (`centralized-write-safety.md`) explains *what* and *why*. This plan specifies *who does what in what order*, and where the parallelism actually lives.

---

## Shape

Four independent tracks. One of them (Track A) is the critical path and has a forced-serial core. The other three can run entirely in parallel with it.

```
Track A (critical path):    A1 ─► A2 ─► A3 ─┬─► A4 ─┐
                                            ├─► A5 ─┤
                                            ├─► A6 ─┼─► A9
                                            ├─► A7 ─┤
                                            └─► A8 ─┘
                                            (E1–E5 reviews attach here)

Track B (converter links):  B1 ─► B2 ─► B3 (optional, lowest priority)

Track C (planUpdate):       C1

Track D (legacy cleanup):                      needs A2 + B2 ─► D1
```

Tracks B, C, and the kickoff of A all start simultaneously at day 0. Nothing in B or C blocks anything in A.

---

## Kickoff set (start in parallel, day 0)

| Task | Agent | Why it's parallelisable |
|------|-------|-------------------------|
| A1 — Design `safePrepareBody` + `safeSubmitPage` API | opus | Critical path starts here |
| B1 — Write failing round-trip render test for internal links | sonnet | Converter-only; no dependency on safe-write |
| C1 — Stable code-macro IDs in `planUpdate` | opus | `planUpdate`-internal; usable before or after migration |

Three agents running concurrently. A1 is the only one that gates other work.

---

## Track A: Write-safety core (critical path)

Sequential inside the track. One handler per PR; each PR must pass all existing tests unmodified.

### A1. Design the API — opus

**Deliverable:** a short design doc (or top-of-file comment in the new module) that nails down:

- Exact TypeScript signatures of `safePrepareBody` and `safeSubmitPage`, including optional-field defaults.
- The return shape for both functions (especially `deletedTokens` structure).
- The full enumeration of `scope` values and what each does.
- Where failure-path logging lives (it lives in `safeSubmitPage`; document it).
- Whether `confluenceBaseUrl` is resolved inside the module or passed by the handler (pass-through is simpler).

**Acceptance:** signatures reviewed by the user; no discovered TODOs at migration time.

### A2. Implement `src/server/safe-write.ts` — opus

Depends on A1.

**Includes from day one** (do not ship boolean-only and migrate later):

- Itemised `confirmDeletions: string[] | true`, with `true` emitting a deprecation warning that lists the specific token IDs for the caller to paste back.
- `deletedTokens` in the `safeSubmitPage` return shape, structured as `Array<{ id, tag, fingerprint }>`.
- `safeSubmitPage` branches on `pageId` for update-vs-create; duplicate-title check lives inside it and preserves the current `create_page` error shape verbatim.
- Success *and* failure mutation logging inside `safeSubmitPage`.

**Tests:** a table-driven permutation suite in `safe-write.test.ts`. Each row is one opt-out combination; assertions check which guards fired and which were skipped. Adding a new guard requires adding a row. The suite is the regression net — not an afterthought.

**Acceptance:** module exists, tests pass, no handler touches it yet.

### A3. Migrate `update_page` — opus

Depends on A2. **Prerequisite for A4–A8.**

Most complex handler: both markdown and storage paths, `planUpdate`, content guards, multiple confirmation flags. This migration establishes the pattern that A4–A8 copy.

**Acceptance:**
- All existing `update_page` tests pass *unmodified*. If any needs changing, stop and investigate.
- No `logMutation` call left in the handler (moved into `safeSubmitPage`).
- No direct call to `updatePage`/`createPage` from this handler.

### A4–A8. Parallel handler migrations — sonnet × 5

All depend on A3. All five can run concurrently, on separate branches, because they touch disjoint handlers in `index.ts` and disjoint test files. Light rebase conflict inside `index.ts` imports, nothing structural.

| ID | Handler | Notes |
|----|---------|-------|
| A4 | `update_page_section` | Prepare on section body, splice, submit full body. `previousBody: fullBody` even though prepare saw only the section |
| A5 | `concatPageContent` (prepend/append) | Pass `scope: "additive"`. Verify `currentBody` round-trips byte-for-byte |
| A6 | `create_page` | `pageId: undefined`. **Preserve duplicate-title error verbatim** (existing page ID + next-step guidance) |
| A7 | `add_drawio_diagram` | Storage-format body; prepare passes through. Content guards newly apply |
| A8 | `revert_page` | Pass `replaceBody: true` (token preservation intentionally skipped) |

**Acceptance each:** existing tests pass unmodified; handler is 10-20 lines of tool-specific logic; no direct `logMutation` or raw-writer call.

### A9. Rename raw writers + enforce invariant — sonnet

Depends on A4–A8 all being landed.

- Rename `updatePage` → `_rawUpdatePage`, `createPage` → `_rawCreatePage` in `confluence-client.ts` (and all imports in tests — the tests can call the raw writers directly since that's their unit).
- Add a test in `safe-write.test.ts` (or a standalone `no-direct-raw-writer.test.ts`) that greps `src/server/*.ts` (excluding `safe-write.ts` and test files) and asserts zero imports of `_rawUpdatePage` / `_rawCreatePage`.
- Delete any remaining `logMutation` calls in handlers (belt-and-braces; the migrations should already have removed them).

**Acceptance:** the import-restriction test is part of CI; a deliberately-broken PR that bypasses the pipeline fails the test.

---

## Track B: Converter link-shape fix (independent)

Runs in parallel with all of Track A. Self-contained in `src/server/converter/md-to-storage.ts` and its tests.

### B1. Round-trip render test (failing) — sonnet

Can start day 0. Write the test *before* the fix: given `[text](https://base/wiki/spaces/X/pages/123)`, assert the emitted storage has a structurally valid anchor whose visible text is exactly `text`. The current output (the `<ac:link>` with `ri:content-id` + `<ac:plain-text-link-body>` shape) either fails the assertion outright or gets a separate assertion pinning the broken shape so B2's change is a diff, not an addition.

**Acceptance:** test committed; fails on `master` at current SHA; clearly named so B2 can land and flip it green.

### B2. Rewrite `rewriteConfluenceLinks` to emit `<a href>` — opus

Depends on B1 (or at least the test being drafted — B2 can run parallel with B1 if the author coordinates). Keep the function's entry point; change the emitted HTML to a plain anchor. External-link handling is already `<a href>`; this collapses internal and external into the same shape.

**Acceptance:** B1 passes; existing `md-to-storage` tests still pass; `rewriteConfluenceLinks` no longer emits `<ac:link>`.

### B3. Optional smart-link path — opus (lowest priority)

Add an opt-in `resolvePageTitle(id): string | undefined` resolver; when provided, emit modern `<ac:link>` with `ri:content-title` + `<ac:link-body>`. Off by default. Lands whenever; blocks nothing.

---

## Track C: Stable code-macro IDs (independent)

Runs in parallel with all of Track A. `planUpdate`-internal change in `src/server/converter/update-orchestrator.ts`.

### C1. Reuse `ac:macro-id` when body text is unchanged — opus

When `planUpdate` encounters a new code macro whose normalised text body matches an existing sidecar entry, treat it as an update (reuse the old `ac:macro-id`) rather than a delete+insert of a new UUID.

**Note on test impact:** existing `update_page` or `planUpdate` tests that assert "code-macro re-emission triggers `DELETIONS_NOT_CONFIRMED`" will need to be updated — the whole point of this change is that re-emission no longer triggers that. That is not a red flag for this PR; it's the whole point. (It *would* be a red flag for any Track A migration PR, which is why C1 lives on its own track.)

**Acceptance:** planUpdate test suite passes (with legitimate test updates); a new test exercises "same code body, new UUID in input → no deletion reported, old UUID reused in output."

---

## Track D: Legacy link migration script (depends on A2 + B2)

### D1. Standalone migration for legacy `<ac:link>` shape — sonnet

Cannot start until:
- A2 is merged (script uses `safePrepareBody` + `safeSubmitPage` for safe writes).
- B2 is merged (script's target shape is what B2 produces).

**Hard safety constraints (write these into the CLI; don't rely on operator discipline):**

- `--dry-run` is the default. An explicit `--apply` flag is required to mutate.
- Target selection is required and explicit: either `--page-ids a,b,c` or `--space-key XX`. No "everything" option.
- Refuses to run if no `--client-label` is provided (mutation log must be attributable).
- Reads the resolved tenant/base URL and emits a `MULTI-TENANT CONFIG DETECTED` warning to stderr when more than one tenant is configured, requiring `--i-understand-multi-tenant` to proceed.
- Emits a dry-run report (page ID, before-shape count, after-shape count, diff preview of first 3 pages) before the apply phase.

**Acceptance:** dry-run on a page with known legacy shape reports correctly; apply on that same page produces the B2-shape output and a mutation-log entry with the script's client label.

---

## Track E: Per-migration data-loss reviews (runs alongside A4–A8)

Each of A4–A8 gets an independent data-loss review by an opus agent **other than the one that did the migration.** The review is a separate pass, not a self-review.

Reviewer's checklist:

- Does the migrated handler have a path (e.g., unusual flag combo, specific input shape) that produces a different `finalStorage` than the pre-migration handler would have?
- Is any guard silently skipped compared to the pre-migration path?
- Does the handler still pass `previousBody` correctly (full body, not section, for splicing handlers)?
- Is every `logMutation` call in the old handler accounted for — either gone (now in `safeSubmitPage`) or justified?
- For `scope: "additive"` (A5 only): does `currentBody` round-trip byte-for-byte into `finalStorage`?
- For `replaceBody: true` (A8 only): are shrinkage, empty-body, and macro-loss guards still active? (They should be — `replaceBody` only skips *token deletion* and *structure loss*.)

**Output:** "approved" or a concrete list of guard gaps to fix before merge.

---

## Agent load

| Phase | Opus slots in flight | Sonnet slots in flight |
|-------|----------------------|------------------------|
| Day 0 (kickoff) | A1, C1 | B1 |
| A1 done, A2 starting | A2, C1 (may finish), B2 | B1 (may finish) |
| A2 done, A3 starting | A3, B2, C1 | D1 preparable |
| A3 done, migrations start | up to 5 E-reviewers | A4, A5, A6, A7, A8 (5) + D1 |
| Migrations all done | — | A9 |

Peak concurrency: **~6 sonnet agents + 2–3 opus agents** during the A4–A8 wave, if reviews run in parallel with migrations.

If opus availability is the constraint, E-reviews can be serialised behind the migrations (one opus reviewer processes A4 → A5 → … as each lands). That stretches the wall-clock of the review phase but keeps peak opus usage at 1.

---

## Rebase and merge discipline

- Land A4–A8 one PR at a time onto `master`. Each rebase is trivial (disjoint handlers), but only one PR is "in review" per handler to avoid reviewer confusion.
- Never land more than one handler migration in a single PR. If a reviewer asks to combine, push back — the single-handler scope is what makes the "tests pass unmodified" check meaningful.
- Track B (link fix) and Track C (stable IDs) land on `master` whenever ready. Track A rebases on top.
- D1 (legacy cleanup) lands only after A2 and B2 are both on `master`.

---

## Progress-tracking surface

Each task above has a corresponding row in the Tasks table of `centralized-write-safety.md`. When running this plan:

- A single TODO list per agent for its own work. The top-level plan does not need a shared task tracker — the phase structure + PR titles are the tracker.
- PR titles prefix with `[safewrite A3]`, `[safewrite B2]`, etc. so the overall state is greppable in the PR list.
- Each migration PR description references the design plan and names which `scope` / flags it passes, so the data-loss reviewer has the context up front.

---

## Critical-path budget

Critical path: A1 → A2 → A3 → (max of A4..A8) → A9.

Rough sizing (from the design plan's effort column):

- A1 (API design): ~1 session
- A2 (safe-write.ts + permutation tests): ~2 sessions
- A3 (`update_page` migration): ~2 sessions
- A4..A8 in parallel: wall-clock ~1 session (bounded by the slowest, realistically `update_page_section` with section splicing)
- A9 (rename + enforcement test): ~0.5 session

Total critical path: **~6.5 sessions.** Tracks B, C, D fit inside that window. If any track slips, the plan degrades gracefully — tracks are independent, so a slow Track C doesn't hold up Track A.

---

## What this plan does not do

- Does not schedule the optional Track B3 (title-resolver smart link). Pick it up whenever; it's pure upside.
- Does not prescribe the exact CLI surface for D1's safety flags — that's a detail the D1 author decides, subject to the acceptance criteria.
- Does not plan a v5.7 removal of boolean `confirmDeletions`. That's a follow-up when v5.7 is cut — drop the boolean branch, tighten the type to `string[]`, re-run the test suite.
