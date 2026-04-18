# Plan: Centralized Write Safety Layer

**Status:** Draft
**Drafted:** 2026-04-17 (tree state: v5.4.2)
**Motivation:** Every data-loss bug in epimethian has the same root cause: safety guards are assembled by each tool handler independently, and new or modified handlers can silently omit a guard. The fix is to make the safe path the *only* path to the Confluence API.

---

## Problem

There are 6 call sites in `index.ts` that mutate pages via `updatePage()` or `createPage()`. Each one independently handles:

1. Read-only-markdown rejection
2. Markdown detection + conversion
3. Token-aware macro preservation (via `planUpdate`)
4. Content safety guards (shrinkage, structure loss, empty body, macro/table loss)
5. Mutation logging

The bottleneck functions (`updatePage`, `createPage` in `confluence-client.ts`) are thin HTTP wrappers that enforce *none* of these. Every handler must remember to wire the full stack. When one doesn't, you get silent data loss.

### Incident history

| Version | Bug | Root cause |
|---------|-----|------------|
| < 5.4.0 | `stripAttributionFooter` regex wiped page bodies | Guard gap in shared write path |
| < 5.4.0 | `update_page` with markdown lost macros silently | No token preservation at all (pre-Stream 5) |
| 5.4.1 | `create_page` created silent duplicates | No existence check |
| 5.4.2 | `update_page_section` lost `<ac:emoticon>` and all `<ac:>` elements | Token preservation never wired in |
| 5.5.x | `update_page` with `confirm_deletions: true` silently dropped embedded drawio macros | `confirm_deletions` is a global opt-out; caller's intent (ack code-macro re-replacement) conflated with unrelated macro deletion |
| 5.5.x | `<ac:link>` output with `ri:content-id` + `<ac:plain-text-link-body>` renders with empty anchor text in the target Confluence Cloud instance | URL rewriter emits a storage shape the target renderer doesn't display correctly; cross-page links appear as gaps in the text |

Every one of these passed multiple reviews because the safety gap wasn't *wrong* code — it was *missing* code. The architecture made omission easy and invisible.

### Current call-site inventory

| # | Tool | Markdown→storage | Token preservation | Content guards | Mutation log |
|---|------|------------------|--------------------|----------------|--------------|
| 1 | `concatPageContent` (prepend/append) | `markdownToStorage` | **NO** | yes | yes (caller) |
| 2 | `create_page` | `markdownToStorage` | N/A (new page) | N/A (new page) | yes |
| 3 | `update_page` | `planUpdate` | yes | yes | yes |
| 4 | `update_page_section` | `planUpdate` (v5.4.2) | yes (v5.4.2) | yes | yes |
| 5 | `add_drawio_diagram` | N/A (storage) | **NO** | yes | yes |
| 6 | `revert_page` | N/A (storage) | **NO** | yes | yes |

**NO** = gap that could cause silent data loss in certain scenarios. **N/A** = not applicable (no prior body to compare against, or input is already storage format).

---

## Design

### Principle

**The only way to write to Confluence is through a two-step pipeline that enforces all safety invariants by default.** Handlers opt *out* of specific guards (with justification), never opt *in*.

### Shape: `safePrepareBody` + `safeSubmitPage`

Two functions, both in `src/server/safe-write.ts`:

- `safePrepareBody` — pure; transforms caller input (markdown or storage) into submit-ready storage. No API calls.
- `safeSubmitPage` — the only function in the module that calls the raw HTTP wrappers. Owns post-transform guards, mutation logging (success and failure), and the duplicate-title check for creates.

Splitting the pipeline (rather than a single `safeWritePage`) lets `update_page_section` splice prepared output into a larger body before submitting, without bypassing the submit-time guard set. Handlers that don't splice (the common case) compose the two calls back-to-back.

`safeSubmitPage` handles both updates and creates by branching on `pageId` (`undefined` → create, string → update). There is no separate `safeCreatePage`: the shared post-transform guard and the shared mutation-log shape are the point of the centralisation.

#### `safePrepareBody`

```
safePrepareBody({
  body,                    // markdown or storage; caller's input
  currentBody,             // page's current storage; undefined for creates
  scope?: "full" | "section" | "additive",  // default "full"
  confirmDeletions?: string[] | true,       // itemised token IDs; true is deprecated blanket ack
  confirmShrinkage?: boolean,
  confirmStructureLoss?: boolean,
  replaceBody?: boolean,
  allowRawHtml?: boolean,
  confluenceBaseUrl?: string,
}) → { finalStorage, versionMessage, deletedTokens }
```

Pipeline:

```
  1. Read-only-markdown rejection     hard guard, no opt-out
  2. Markdown detection               looksLikeMarkdown; allowRawHtml lifts the raw-HTML tripwire
  3. Token-aware conversion           planUpdate            (markdown + currentBody has <ac:> elements)
     OR plain markdownToStorage                             (markdown + no tokens to preserve)
     OR pass-through                                        (already storage format)
  4. Link rewriting                   rewriteConfluenceLinks (runs only if confluenceBaseUrl is set)
  5. Content safety guards            shrinkage, structure, empty body, macro/table loss
  6. Post-transform body guard        reject if output is empty/suspiciously small
```

#### `safeSubmitPage`

```
safeSubmitPage({
  pageId,                  // undefined → create; string → update
  spaceId,                 // required for create
  parentId,                // create only
  title,
  finalStorage,
  previousBody,            // required for update; threaded to _rawUpdatePage as `previousBody` for
                           //   diff/attribution logging — pass the full page body even in section flows
  version,                 // required for update
  versionMessage,
  deletedTokens,           // from prepare; surfaced in tool response + version message
  clientLabel,
}) → { page, newVersion, oldLen, newLen, deletedTokens }
```

Pipeline:

```
  1. Duplicate-title check        create only; preserves the current create_page error verbatim
                                  (existing page ID + next-step guidance)
  2. Post-submit safety guard     re-runs the post-transform body guard on finalStorage,
                                  independent of prepare's decision
  3. API call                     _rawUpdatePage or _rawCreatePage
  4. Mutation log (success)       identical shape to current logMutation emission:
                                  oldVersion, newVersion, oldBodyLen/Hash, newBodyLen/Hash, clientLabel
  5. Mutation log (failure)       on thrown error: emits errorRecord and rethrows
```

Handlers no longer call `logMutation` directly — success and failure logging both live inside `safeSubmitPage`. That closes the same structural gap the rest of the plan addresses: if a handler forgets to log, it fails silently. Moving logging into the pipeline takes it out of "handler's responsibility" entirely.

### Flag semantics

| Flag | Applies | Meaning |
|------|---------|---------|
| `scope: "full"` | prepare | default; normal page-level content guards |
| `scope: "section"` | prepare | body is a section — content guards phrased/thresholded for section-scale changes |
| `scope: "additive"` | prepare | body will be concatenated onto `currentBody` unchanged — skip token diff and deletion checks; keep content guards (which run post-concat in `safeSubmitPage`) |
| `confirmDeletions: string[]` | prepare | specific token IDs acknowledged for removal; mismatch against actual deletion set errors and surfaces the correct list |
| `confirmDeletions: true` | prepare | deprecated blanket ack; accepted in v5.5 with a warning that lists the specific token IDs, removed in v5.7 |
| `confirmShrinkage` | prepare | acknowledge >40% body shrinkage |
| `confirmStructureLoss` | prepare | acknowledge heading/macro structure reduction |
| `replaceBody` | prepare | intent to overwrite the whole body (e.g. `revert_page`). Bypasses *token deletion* and *structure-loss* checks. Does **not** bypass shrinkage, empty-body, or macro/table-loss guards. Distinct from `confirmDeletions: true`: `replaceBody` means "I'm replacing everything, don't diff tokens at all"; `confirmDeletions` means "I've reviewed the specific deletions and they're expected" |
| `allowRawHtml` | prepare | permit raw HTML that the `looksLikeMarkdown` / raw-HTML tripwire would otherwise reject |
| `confluenceBaseUrl` | prepare | enables link rewriting when set; skipped if unset (not an error — external links still round-trip unchanged) |

Opting out is always explicit in code and visible in review. The default path is the safest path.

### What handlers look like after

Before (current `update_page_section`, 60+ lines of safety logic):

```typescript
async ({ page_id, section, body, version, ... }) => {
  // writeGuard, read-only-md check, getPage, looksLikeMarkdown,
  // extractSectionBody, planUpdate, replaceSection,
  // enforceContentSafetyGuards, updatePage, logMutation...
}
```

After:

```typescript
async ({ page_id, section, body, version, confirm_deletions, ... }) => {
  const blocked = writeGuard("update_page_section", config);
  if (blocked) return blocked;

  const page = await getPage(page_id, true);
  const fullBody = page.body?.storage?.value ?? page.body?.value ?? "";

  const currentSectionBody = extractSectionBody(fullBody, section);
  if (!currentSectionBody) return toolResult(`Section "${section}" not found...`);

  const prepared = await safePrepareBody({
    body,
    currentBody: currentSectionBody,
    scope: "section",
    confirmDeletions: confirm_deletions,
    confluenceBaseUrl: getConfluenceBaseUrl(),
  });

  const newFullBody = replaceSection(fullBody, section, prepared.finalStorage);

  const result = await safeSubmitPage({
    pageId: page_id,
    title: page.title,
    finalStorage: newFullBody,
    previousBody: fullBody,          // full body, not section — for attribution/diff logging
    version,
    versionMessage: prepared.versionMessage,
    deletedTokens: prepared.deletedTokens,
    clientLabel: getClientLabel(server),
  });

  return toolResult(formatUpdateSuccess(result));   // surfaces deletedTokens if non-empty
}
```

Handlers become 10-20 lines of tool-specific logic. Safety is structural, not manual.

### `confirm_deletions` UX: the boolean is too coarse

The 5.5.x drawio-loss incident exposes a footgun in the current `confirm_deletions` signal: it's a single flag that acknowledges *every* preserved-element deletion, including deletions the caller never looked at. The typical pattern:

1. Caller submits markdown that re-renders existing code blocks (so `ac:macro-id` UUIDs change — structurally a delete+insert).
2. `planUpdate` reports `DELETIONS_NOT_CONFIRMED` listing *both* the code macros *and* any unrelated macros the markdown doesn't carry a token reference for (e.g. an embedded drawio diagram the caller hasn't noticed).
3. Caller sets `confirm_deletions: true` to resolve the code-macro churn.
4. The flag silently also accepts the drawio deletion.

Three design changes fold naturally into the `safePrepareBody` pipeline and keep `confirm_deletions` for genuine semantic deletions rather than routine churn:

**1. Stable IDs for code-block macros.** When `planUpdate` sees a new code macro whose normalised text body matches an existing sidecar entry, it should treat that as an update (reuse the old `ac:macro-id`), not a delete+insert of a new UUID. That removes the most common non-semantic trigger for `confirm_deletions: true` — callers rewriting code samples that haven't actually changed — and narrows `confirm_deletions` to cases the caller genuinely needs to think about.

**2. Itemised confirmation rather than a boolean.** Today `confirm_deletions: true` is a global opt-out. Safer shape: take a list of token IDs being acknowledged — e.g. `confirm_deletions: ["T0003", "T0007"]`. If the actual deletion set doesn't match, the tool errors with the correct list. This forces callers to enumerate what they're removing and eliminates the "I meant to accept A but accidentally accepted A+B" footgun. Backwards-compatible: accept `true` as an unsafe blanket acknowledgement with a deprecation warning that surfaces the specific token IDs for the caller to paste back on the next call. **Deprecated in v5.5, removed in v5.7.**

**3. Surface deletions in the success response, not just the version message.** Today the deletion list appears in the error (before confirmation) and in the Confluence version message (after). It does NOT appear in the MCP tool result after a successful write. A caller who confirms deletions gets no reminder of what they confirmed in the response. `safeSubmitPage` should return `{ page, newVersion, deletedTokens?: Array<{ id, tag, fingerprint }> }`, and the handler should surface non-empty `deletedTokens` in the user-visible tool output (e.g. `"updated page X; removed 2 preserved macros: drawio[architecture.drawio], structured-macro[panel]"`) so accidental deletions are noticed at write-time rather than discovered later by a reader.

### `rewriteConfluenceLinks` emits a storage shape that doesn't render

**Symptom.** When the converter rewrites a markdown link whose URL matches the configured Confluence base URL (via `rewriteConfluenceLinks` in `md-to-storage.ts:866`), it emits:

```xml
<ac:link>
  <ri:page ri:content-id="123456" ri:space-key="XX"/>
  <ac:plain-text-link-body><![CDATA[link text]]></ac:plain-text-link-body>
</ac:link>
```

Against the target Confluence Cloud instance (Atlassian-hosted, modern renderer, 2026), this renders with **empty anchor text** — the link target is correct, but the visible text is blank. The defect surfaced across a 30-page advisory review: every cross-reference between pages appeared as a gap (e.g. `See the    tree.`) instead of a hyperlink. The user-visible damage is severe: a reader sees prose with words missing, with no way to know something was removed, and no hint that the gaps were meant to be navigation.

Plain `<a href="…">link text</a>` inside the same page bodies renders correctly — verified by replacing all `<ac:link>` occurrences on the affected pages with plain anchors, which immediately restored the visible text.

**Cause.** `<ac:plain-text-link-body>` combined with `<ri:page ri:content-id="…"/>` is a structurally valid but older storage shape. Modern Confluence-emitted links use `<ri:page ri:content-title="…"/>` plus `<ac:link-body>` (rich body, not plain-text), and some variants additionally carry `ri:version-at-save` and `ac:card-appearance` attributes. The target renderer evidently does not populate anchor text from the `ac:plain-text-link-body` CDATA when paired with `ri:content-id`.

This class of bug is indistinguishable from the others in the incident history: valid-by-spec output that silently doesn't render. The caller has no way to detect it; the data is there, just invisible.

**Suggested fix.** Stop emitting `<ac:link>` from `rewriteConfluenceLinks`. Two defensible shapes, in order of preference:

1. **Emit plain `<a href="…">` anchors** even for internal Confluence URLs. Simpler, always renders, identical to how the converter treats external URLs today. Costs: loses Confluence's "smart link" behaviour (page-rename follow-through, hover previews for signed-in users). Benefit: can't break in this way.
2. **Emit modern `<ac:link>` with `<ri:page ri:content-title="…"/>` and `<ac:link-body>`** (no `ri:content-id`, no `ac:plain-text-link-body`). Keeps smart-link behaviour but requires knowing the page title, which means a lookup at rewrite time. The lookup can be cached; the converter already takes a `confluenceBaseUrl`, so taking an optional `resolvePageTitle(id): string | undefined` resolver is a minor API change.

Option 1 is the safer default — no runtime lookup, no renderer-shape guessing. Option 2 can be added as an opt-in behind a flag if smart-link behaviour is explicitly wanted.

Either way, the fix folds into `safePrepareBody` as a single call to the updated link rewriter. Old pages on the instance that already contain the broken shape need a separate migration (for the review pages, this was done by hand; going forward, a `--fix-links` maintenance mode on `update_page` or a standalone migration script would be preferable).

**Test.** Add a round-trip test: given `[text](https://configured.base/wiki/spaces/X/pages/123)` as input markdown, the converter output must contain a structurally valid anchor whose visible text is exactly `text` when rendered through a Confluence-compatible renderer. The current `md-to-storage` tests check that `<ac:link>` is produced but not that the produced shape renders — closing that gap prevents this recurring on the next renderer change.

---

## Migration strategy

Phase 2 (`update_page`) is the hardest case and establishes the migration pattern; it must land before Phases 3–6. Once Phase 2 is merged, Phases 3–6 can proceed in parallel — they touch disjoint handlers, and each PR must pass existing tests unmodified so cross-PR interference is structurally excluded. Phase 7 depends on all migrations being complete.

### Phase 1: Introduce the pipeline alongside existing code

- Create `src/server/safe-write.ts` with `safePrepareBody` and `safeSubmitPage`.
- Tests: a **table-driven suite** that enumerates every opt-out permutation and asserts which guards fire (and which don't). Adding a new guard requires adding a table row; forgetting to wire it surfaces as an unexpected test miss. This is the regression net for "guard silently skipped" across all future changes.
- Do NOT change any existing handlers yet.

### Phase 2: Migrate `update_page` — prerequisite for Phases 3–6

- Replace the inline safety logic in the `update_page` handler with `safePrepareBody` + `safeSubmitPage`.
- This is the most complex handler with both markdown and storage paths, `planUpdate`, content guards, and multiple confirmation flags.
- All existing `update_page` tests must pass unchanged (behavior-preserving refactor).
- If any test needs modification, that's a signal the migration changed behavior — investigate before proceeding.

### Phase 3: Migrate `update_page_section` *(parallel-capable with Phases 4–6 once Phase 2 lands)*

- Same pattern: prepare on the section body, splice, submit the full body. Existing token-preservation tests must pass unchanged.

### Phase 4: Migrate `concatPageContent` (prepend/append) *(parallel-capable)*

- Pass `scope: "additive"` so token diff and deletion checks are skipped; content guards still fire post-concat inside `safeSubmitPage`.
- This path currently lacks token preservation; `scope: "additive"` is the deliberate choice for additive operations, not a gap — the existing body is concatenated unchanged, so there's nothing to preserve.
- **Data loss review:** Confirm that `scope: "additive"` truly leaves `currentBody` byte-for-byte untouched in `finalStorage` — the concat is the handler's job between prepare and submit, never inside prepare.

### Phase 5: Migrate `create_page` and `add_drawio_diagram` *(parallel-capable)*

- `create_page` passes `currentBody: undefined` to prepare and `pageId: undefined` to submit. The duplicate-title check runs inside `safeSubmitPage` and **must preserve the current error verbatim** (page ID of the existing page + next-step guidance) — regressing that message is a UX regression even if the guard is correct.
- `add_drawio_diagram` passes storage-format body — prepare's markdown detector returns false and passes through; it picks up content guards and mutation logging for free.

### Phase 6: Migrate `revert_page` *(parallel-capable)*

- Passes the historical body as storage format with `replaceBody: true` (token preservation intentionally skipped; the whole point of revert is to replace everything).

### Phase 7: Remove dead code and enforce the invariant

- Delete the now-inlined guard calls and `logMutation` calls from handlers.
- Remove redundant imports.
- Rename `updatePage` → `_rawUpdatePage` and `createPage` → `_rawCreatePage` in `confluence-client.ts`. Direct use is then visually obvious in review.
- **Structural enforcement:** add a test asserting that only `src/server/safe-write.ts` imports `_rawUpdatePage` / `_rawCreatePage`. A handler bypassing the pipeline fails a test, not just a review.

---

## Risks and mitigations

### Risk: `safePrepareBody` becomes a god function

**Mitigation:** It's a pipeline, not a monolith. Each step is a function call (`rejectReadOnlyMarkdown`, `detectAndConvert`, `planUpdate`, `rewriteConfluenceLinks`, `enforceContentSafetyGuards`). The existing functions don't change — the new module is the composition layer, not a replacement.

### Risk: Some write paths legitimately need to skip guards

**Mitigation:** Every guard has an explicit opt-out flag (`replaceBody`, `confirmDeletions`, `confirmShrinkage`, etc.). The default is always safe. New guards are automatically enforced everywhere; only handlers that need an exception pass the flag. Opting out is visible in code review.

### Risk: Prepend/append don't need full token preservation

**Mitigation:** `scope: "additive"` skips token diff entirely. The concat happens in the handler between prepare and submit; `currentBody` is never transformed. Content guards still run on the concatenated body inside `safeSubmitPage`, which is the invariant that matters.

### Risk: Behavioural changes during migration break things

**Mitigation:** One handler per PR. Each migration PR must pass all existing tests *unmodified*. If a test needs changes, that's a red flag — the migration is behavior-preserving by construction. The same guards fire in the same order; they just live in a different function.

### Risk: Section splicing happens outside the centralised guards

**Mitigation:** This is exactly why prepare and submit are split. `safePrepareBody` handles the section body (token preservation, markdown conversion, content guards on the section). The handler does `replaceSection` to splice. `safeSubmitPage` then runs its post-transform body guard on the full spliced body — catching any splicing damage — before calling `_rawUpdatePage`. The full-page post-transform guard is the backstop that makes handler-side splicing safe.

### Risk: Mass link-shape migration hits the wrong pages or wrong tenant

**Mitigation:** The legacy-link rewrite (Tasks row 16) runs **dry-run by default**, takes an explicit page-ID list or single space key (never a bare "everything"), refuses to run without a client label, and emits a warning if the resolved credentials indicate a multi-tenant context. This is a maintenance command, not an implicit migration; it must never run as a side effect of a normal write.

---

## Tasks

Phase 2 (`update_page`) is a hard prerequisite for Phases 3–6 migrations. The five handler migrations after it can run in parallel.

| Task | Agent | Depends on | Effort |
|------|-------|------------|--------|
| Design `safePrepareBody` + `safeSubmitPage` API | opus | — | Medium |
| Implement `safe-write.ts` with permutation-driven guard tests | opus | API design | Medium |
| Migrate `update_page` handler | opus | safe-write.ts | Medium |
| Migrate `update_page_section` handler | sonnet | `update_page` migration | Small |
| Migrate `concatPageContent` handler | sonnet | `update_page` migration | Small |
| Migrate `create_page` handler (preserve duplicate-title error verbatim) | sonnet | `update_page` migration | Small |
| Migrate `add_drawio_diagram` handler | sonnet | `update_page` migration | Small |
| Migrate `revert_page` handler | sonnet | `update_page` migration | Small |
| Rename raw writers to `_rawUpdatePage` / `_rawCreatePage`; add import-restriction test | sonnet | all migrations | Trivial |
| Data-loss review of every migrated handler | opus | each migration | Small each |
| Stable code-macro IDs: reuse `ac:macro-id` when body text is unchanged | opus | safe-write.ts | Medium |
| Itemised `confirm_deletions` (list of token IDs, with v5.5→v5.7 deprecation of boolean) | opus | safe-write.ts | Medium |
| Thread `deletedTokens` through `safeSubmitPage` response + surface in handler output | sonnet | safe-write.ts | Small |
| Rewrite `rewriteConfluenceLinks` to emit plain `<a href>` anchors (default) | opus | converter | Small |
| Optional: add title-resolver path for `<ac:link>` with `ri:content-title` + `<ac:link-body>` (opt-in) | opus | converter | Medium |
| Round-trip render test for converter-emitted links (plain anchor + opt-in ac:link variant) | sonnet | converter | Small |
| Migration script for legacy `<ac:link>` shape: **dry-run default, explicit page-ID list or space key required, refuses to run without client label, warns on multi-tenant config** | sonnet | safe-write.ts | Medium |

---

## Success criteria

1. **Zero direct calls to `_rawUpdatePage`/`_rawCreatePage` from tool handlers.** All writes go through `safePrepareBody` + `safeSubmitPage`.
2. **Structurally enforced.** A test asserts that only `src/server/safe-write.ts` imports `_rawUpdatePage`/`_rawCreatePage`. Handlers bypassing the pipeline fail a test, not just a review. Mutation logging (success and failure) lives inside `safeSubmitPage`; no handler calls `logMutation` directly.
3. **All existing tests pass unmodified.** The migration is behavior-preserving.
4. **Adding a new write tool requires zero safety boilerplate.** The handler calls `safePrepareBody` + `safeSubmitPage` and gets all guards for free.
5. **Omitting a guard requires an explicit opt-out flag.** No silent absence of safety.
6. **`prepend_to_page` / `append_to_page` flow through the pipeline.** `scope: "additive"` skips token diff (correct for additive ops) but content guards and mutation logging are structural.
7. **`confirm_deletions` reserved for semantic deletions.** Code macros whose text is unchanged no longer trigger it, and it takes a specific token list rather than a blanket boolean (v5.5 deprecation, v5.7 removal).
8. **Successful writes surface what was deleted.** Any caller who confirmed a deletion sees the exact tokens removed in the tool response, not only in the version message.
9. **Converter-emitted links render correctly.** Plain `<a href>` is the default for all URLs (internal and external). The optional smart-link path emits modern `<ac:link>` with `ri:content-title` + `<ac:link-body>`, not the legacy `ri:content-id` + `ac:plain-text-link-body` shape.
