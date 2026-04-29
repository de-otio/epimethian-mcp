# Plan: Fix UX issues from `ux-feedback-confluence-tree-build.md`

Source feedback: [plans/ux-feedback-confluence-tree-build.md](./ux-feedback-confluence-tree-build.md)
(live session 2026-04-28, building a 12-page German-language tree under jambit
parent 88048037).

This plan turns the 10 feedback items into discrete, parallelisable tasks with
explicit file:line targets, recommended model per task, and an assessment of
data-loss risk for every mutation-touching change. Items §2 and §3 are the
highest-leverage; everything else is tracked but lower-priority.

The mapping below was verified against the current tree (commit `8f0b773`,
package version `6.2.2`). All file:line citations were confirmed by direct
read.

---

## 0. In-flight v6.2.2 baseline (predecessor)

The working tree contains an uncommitted v6.2.2 release: badge locale now
follows the Confluence tenant instead of the MCP process locale. Touched
files (per `git diff HEAD`): `package.json` (6.2.1→6.2.2),
`CHANGELOG.md` (+20 lines), `src/server/provenance.ts` (+34 lines, adds
`getSiteDefaultLocale` import + new resolution order), `src/server/provenance.test.ts`
(+92 lines), `src/server/permission-and-provenance.integration.test.ts`
(+1 line), `README.md` (+/-4 lines). Tests pass on this baseline (1586/1586).

**Task 0.** Commit the v6.2.2 work as the baseline before starting any of
the tasks below. This is required because:

- D4 (badge 409 retry) edits `provenance.ts` and would otherwise conflict
  with the in-flight diff.
- A2 references `permission-and-provenance.integration.test.ts` and would
  collide with the +1-line in-flight change.
- The `CHANGELOG.md` for 6.2.3 builds on the 6.2.2 entry already drafted
  in the working tree.

After Task 0 lands, the rest of this plan begins from a clean tree at
`v6.2.2`.

---

## 1. Dependency graph & parallelism

Tasks group into **four parallel lanes** that can run concurrently. A task in
a higher-numbered lane only blocks on tasks within the same lane (or noted
predecessors).

```
Lane A — Elicitation & provenance      Lane B — Heading matcher & docs
  A1 §1 error-code distinctions          B1 §3 tolerant matcher  ┐
  A2 §6 deletion explanation             B2 §8 entity decode     ┘ (same fn — A→B serial)
  A3 §10c elicitation_response source    B3 §9 description notes
                                         B4 §7 heading round-trip fuzz tests

Lane C — Safety pipeline                Lane D — Returns & polish
  C1 §2 byte-equivalent macro suppress   D1 §4  update_page_sections (plural)
  C2 §5 version: "current" support       D2 §4b find_replace mode
                                         D3 §10a drawio diagram handle
                                         D4 §10b badge 409 retry
                                         D5 §11 write-budget UX overhaul
                                            (defaults + rename + agent guide)
```

**Coordination notes:**
- B1 and B2 both edit `confluence-client.ts:1665-1738`. Run B2 first (1-line
  fix), then B1 builds on the entity-decoded text. Single agent, sequential.
- A2 reuses error metadata from A1 (`USER_DECLINED` vs `NO_USER_RESPONSE`).
  Run A1 first.
- D1 (`update_page_sections`) must call into the C1 pipeline once landed; D1
  can start in parallel against today's pipeline and pick up the C1
  improvements transparently when they land.
- C1 changes the elicitation surface for `confirm_deletions`; A2's copy
  changes (deletion explanation in the prompt) only become valuable after C1.
  A2 lands in any order but should reference the C1 result shape.

**Recommended dispatch:** four agents in parallel (one per lane). Lane A
finishes fastest; Lane C is the slowest and most-reviewed.

---

## 2. Version & rollout strategy

- **6.2.3 (patch)** — A1, A3, B2, B3, D3, D4, D5. Pure additive / message-only
  fixes, no behaviour change for existing callers (D5 raises a ceiling but
  existing env overrides still take precedence).
- **6.3.0 (minor)** — B1, B4, C1, C2, A2. New behaviour: tolerant matcher,
  byte-equivalent suppression, `version: "current"`. Each is gated behind
  defensive defaults.
- **6.4.0 (minor)** — D1, D2. New tool surface (`update_page_sections`,
  `find_replace`).

Land in this order so a buggy 6.3.0 can be reverted without losing the safe
6.2.3 fixes. Each version has its own CHANGELOG entry; no batching.

---

## 3. Tasks

For every task: **target files + line ranges**, **recommended model**, the
**change**, **tests**, and a **data-loss risk** line (mandatory per
`feedback_data_loss_review.md`).

---

### A1 — §1 Distinguish elicitation outcomes

**Model:** sonnet
**Files:**
- [src/server/elicitation.ts:28-31](../src/server/elicitation.ts#L28-L31) — error code constants
- [src/server/elicitation.ts:33-40](../src/server/elicitation.ts#L33-L40) — `GatedOperationError`
- [src/server/elicitation.ts:66-84](../src/server/elicitation.ts#L66-L84) — unsupported-client branch
- [src/server/elicitation.ts:128-139](../src/server/elicitation.ts#L128-L139) — outcome-to-message mapping
- [src/server/elicitation.test.ts](../src/server/elicitation.test.ts) — extend coverage

**Change.** Split the single `USER_DENIED_GATED_OPERATION` code into:
- `USER_DECLINED` — explicit `decline` action.
- `USER_CANCELLED` — `cancel` action.
- `NO_USER_RESPONSE` — anything else (timeout, transport error, unknown
  action).

Rename `ELICITATION_UNSUPPORTED` → `ELICITATION_REQUIRED_BUT_UNAVAILABLE` and
extend its message with an actionable hint:
*"This tool requires interactive confirmation but your MCP client does not
expose elicitation. Use `update_page_section` instead, or switch to a client
that supports MCP elicitation (Claude Code ≥ 2.x, Claude Desktop ≥ 0.10)."*

Wire each outcome into `gateOperation()` so the thrown `GatedOperationError`
carries the precise code. Re-export the new codes for callers/tests.

**Tests.** Update `elicitation.test.ts` to assert the four codes. Add a test
that simulates an elicitation timeout (mock the elicit fn to throw) and
verifies the error code is `NO_USER_RESPONSE`, not `USER_DECLINED`.

**Data-loss risk.** None. Pure error-message refactor. Verify no caller
depends on the exact string `"user declined"` (grep — `permission-and-provenance.integration.test.ts`
and `index.test.ts` may match on the message; update assertions).

---

### A2 — §6 Explain what `confirm_deletions` is removing

**Model:** sonnet
**Depends on:** A1 (uses new error codes), and ideally lands after C1 (so the
explanation reflects the post-suppression deletion set).
**Files:**
- [src/server/index.ts:930-960](../src/server/index.ts#L930-L960) — `update_page` gate call
- [src/server/index.ts:1117-1224](../src/server/index.ts#L1117-L1224) — `update_page_section` gate call
- [src/server/elicitation.ts:128-139](../src/server/elicitation.ts#L128-L139) — error-message generator
- [src/server/source-provenance.ts:68-103](../src/server/source-provenance.ts#L68-L103) — `validateSource`

**Change.**

1. Pass a structured `deletionSummary` (e.g.
   `{ tocs: 1, links: 8, images: 0, codeMacros: 0 }`) into `gateOperation`
   for `confirm_deletions` calls. The pipeline can compute this from
   `plan.deletedTokens` before the gate fires (today the gate fires *before*
   the diff plan is materialised — so this requires moving the dry-run plan
   computation ahead of the gate, or accepting that the summary is a forecast
   from the pre-write diff).
2. Render the elicitation prompt as
   *"This update will remove 1 TOC macro and 8 link macros that the new
   markdown does not regenerate. Proceed?"* instead of the bare flag name.
3. When `validateSource` rejects a destructive flag *before* elicitation, the
   thrown error must say so:
   `"confirm_deletions blocked by source policy: source=user_request but
   prompt did not authorise content deletion. Confirm interactively or
   rephrase request."`. Add the `code: "SOURCE_POLICY_BLOCKED"` to the
   thrown `ConverterError`.

**Tests.** Extend `permission-and-provenance.integration.test.ts` with a case
that asserts the deletion summary is rendered. Add a unit test in
`source-provenance.test.ts` for the new error code.

**Data-loss risk.** Low — the change is to *messages*, not to the gate
itself. Verify the pre-gate diff computation doesn't accidentally commit
anything (it must run as a pure plan, not a write). Inspect call sites of
`safeSubmitPage` to ensure the dry-run path remains side-effect free.

---

### A3 — §10c New `elicitation_response` source value

**Model:** haiku
**Files:**
- [src/server/source-provenance.ts:41-53](../src/server/source-provenance.ts#L41-L53) — `sourceSchema` enum
- [src/server/source-provenance.ts:68-103](../src/server/source-provenance.ts#L68-L103) — policy table
- [src/server/source-provenance.test.ts](../src/server/source-provenance.test.ts)
- [doc/destructive-flag-prompts.md](../doc/destructive-flag-prompts.md) — document the new value

**Change.** Add `"elicitation_response"` as a fourth enum value. Treat it
identically to `"user_request"` in the policy table for now (a confirmed
elicitation answer is at least as authoritative as the original prompt). The
distinction is for forensics / audit, not enforcement.

**Tests.** One row in the validation table test. No behaviour change.

**Data-loss risk.** None. Schema-only addition. New enum values are accepted
where old ones were; existing callers are unaffected.

---

### B1 — §3 Tolerant section matcher

**Model:** sonnet
**Depends on:** B2 (entity decode lands first so the match input is stable)
**Files:**
- [src/server/confluence-client.ts:1714-1738](../src/server/confluence-client.ts#L1714-L1738) — `findHeadingInTree`
- [src/server/confluence-client.ts:1665-1683](../src/server/confluence-client.ts#L1665-L1683) — `extractHeadings` (also fix synthetic-counter duplication)
- [src/server/confluence-client.test.ts](../src/server/confluence-client.test.ts)

**Change.** Three coordinated fixes:

1. **`findHeadingInTree`:** after exact match fails, retry with both sides
   stripped of a leading `^\d+(?:\.\d+)*\.\s+` prefix (anchored, escaped
   dots). This makes `"Lesereihenfolge"`, `"1.2. Lesereihenfolge"`, and
   `"1.2 Lesereihenfolge"` all resolve to the same heading.
2. **Ambiguity:** if multiple headings match the stripped form, prefer an
   exact-text match; otherwise return a structured error
   `"Section 'X' is ambiguous; matched N headings: ..."` rather than
   silently picking the first.
3. **`extractHeadings`:** when the synthetic outline counter prefix
   (`"1.2."`) matches the prefix of the stripped heading text, drop the
   synthetic prefix. Output becomes `"  1.2. Lesereihenfolge"` (one
   number, indented), not `"1.2. 1.2. Lesereihenfolge"`. This is a pure
   formatting change; the matcher in (1) handles either form.

**Tests.** Three new cases in `confluence-client.test.ts`:
- match plain `"Lesereihenfolge"` against stored `"1.2. Lesereihenfolge"`.
- match `"1.2. Lesereihenfolge"` against stored `"Lesereihenfolge"`.
- ambiguity error when two H2s share the stripped form.
- `extractHeadings` no longer doubles the prefix when stored text already
  contains the auto-number.

**Data-loss risk.** **Medium.** A tolerant matcher resolving to the *wrong*
heading would route a section update onto unintended content. Mitigations:
(a) only fall back to stripped match if exact match returns 0 hits, (b) fail
loudly on ambiguity rather than guess, (c) preserve `headings_only` output as
the canonical reference so callers can verify before sending. Add a test that
proves an ambiguous stored space (two `Notes` headings, one auto-numbered)
errors instead of writing.

---

### B2 — §8 HTML-entity decode in `extractHeadings`

**Model:** haiku
**Files:**
- [src/server/confluence-client.ts:1665-1683](../src/server/confluence-client.ts#L1665-L1683)
- [src/server/confluence-client.test.ts](../src/server/confluence-client.test.ts)

**Change.** Wrap the existing tag-strip with an entity decode pass. Reuse
the project's existing decoder (search for `decodeEntities` / `he` /
`html-entities` import in the codebase before pulling a new dep — likely
already present for the converter pipeline). One line:

```ts
const text = decodeEntities(match[2].replace(/<[^>]+>/g, "")).trim();
```

**Tests.** One case: stored heading `"Entscheidungen f&uuml;r die GF"` →
output contains `"Entscheidungen für die GF"`.

**Data-loss risk.** None. Output-only formatting fix; the storage-form HTML
is unchanged.

---

### B3 — §9 Tool descriptions mention auto-numbering

**Model:** haiku
**Files:**
- [src/server/index.ts:733-735](../src/server/index.ts#L733-L735) — `get_page` description
- [src/server/index.ts:653-661](../src/server/index.ts#L653-L661) — `create_page` description
- [src/server/index.ts:1120-1123](../src/server/index.ts#L1120-L1123) — `update_page_section` description

**Change.** Append one sentence to each:
*"Note: in Confluence spaces with heading auto-numbering enabled, stored
heading text contains the prefix (e.g. `1.2. Section`); the matcher accepts
either the prefixed or plain form."*

For `create_page`, add: *"If the space has auto-numbering, the page version
may advance silently after creation while post-processing renders the TOC
and number prefixes. Re-read the page before subsequent updates."*

**Tests.** None — copy change only.

**Data-loss risk.** None.

---

### B4 — §7 Heading round-trip fuzz tests

**Model:** sonnet
**Files:**
- [src/server/converter/md-to-storage.ts:985-1024](../src/server/converter/md-to-storage.ts#L985-L1024) — `buildHeadingRenderer`
- New test: `src/server/converter/heading-roundtrip.test.ts`

**Change.** Property-style test that round-trips heading text through
markdown→storage→`extractHeadings` for the following inputs:
- `"TL;DR für die GF"` (the actual reported truncation)
- `"Decision: deploy?"` (colon)
- `"Größenanalyse"` (umlaut)
- `"Range — 1 to 10"` (em-dash)
- `"„Quote" und mehr"` (German quotes)
- `"Why (and how)"` (parentheses)
- `"Foo & Bar"` (ampersand)

For each input, assert that the heading text post-extraction equals the
input (modulo entity decoding from B2). If any input fails, the test fails
loudly — this surfaces the silent-truncation bug for whoever investigates.

**Investigation note.** The truncation root cause was *not* fully traced in
the source feedback. The test is the diagnostic. Likely suspects:
- markdown-it's `inline` parser swallowing tokens around `;`
- a regex in the converter's heading-id slugifier
- Confluence-side auto-numbering rewriting the text
The test will tell us *which* by showing which inputs round-trip and which
don't. If markdown-it is the culprit, the fix is in `buildHeadingRenderer`
(use `rawContent` consistently, never the rendered HTML, when extracting the
heading text). If Confluence is the culprit, the test will only fail when
run against a live tenant — in which case file the bug upstream and document
the workaround.

**Data-loss risk.** **High** if root cause is in our converter — silent
truncation of user-supplied heading text. The test is the guard. If the test
passes locally against the converter, the bug is server-side and we can only
warn about it (B3 description).

---

### C1 — §2 Suppress `confirm_deletions` for byte-equivalent macros

**Model:** opus
**Files:**
- [src/server/safe-write.ts:599-632](../src/server/safe-write.ts#L599-L632) — `computeFingerprint`
- [src/server/safe-write.ts:638-646](../src/server/safe-write.ts#L638-L646) — `buildDeletedTokens`
- [src/server/safe-write.ts:665-694](../src/server/safe-write.ts#L665-L694) — `assertDeletionAckMatches`
- [src/server/safe-write.ts:887](../src/server/safe-write.ts#L887) — `deletedTokens` populator
- [src/server/safe-write.test.ts](../src/server/safe-write.test.ts)

**Change.** Reframe `plan.deletedTokens` as
`{ deleted: TokenId[], regenerated: { oldId, newId, kind }[] }` where
`regenerated` captures (deleted, created) pairs whose post-canonicalisation
XML is byte-equivalent. Equivalence rules per macro kind:

- `<ac:link>`: equal if the resolved page-target (page-id or space+title),
  the link body display text, and the anchor (if any) all match. Order of
  attributes does not matter.
- `<ac:structured-macro ac:name="toc">`: equal if all `ac:parameter`
  children render identically after parameter sort.
- Generic structured macros: equal if `ac:name`, parameter set, and CDATA
  body are equal.
- Plain elements (e.g. `<ac:emoticon>`): byte-equal after attribute sort.

Implement a canonicaliser that takes a token's stored XML and returns a
stable string key. Two tokens with the same key are equivalent.

`assertDeletionAckMatches` checks against the *deleted* set only; the
*regenerated* set never reaches the user-confirmation gate.

**Tests.** New tests in `safe-write.test.ts`:
- Re-submitting the same 8 `<ac:link>` macros (different attribute order)
  produces 0 entries in `deleted` and 8 in `regenerated`. No
  `confirm_deletions` gate fires.
- Removing one `<ac:link>` and rewriting the other 7 produces 1 entry in
  `deleted`. Gate fires for *that* link only, with a description naming the
  removed link.
- Replacing the TOC body parameter (`maxLevel: 3` → `maxLevel: 4`) is *not*
  byte-equivalent: 1 deletion + 1 creation, gate fires.
- Property test: random macro permutation that preserves canonical form is
  always classified as `regenerated`.

**Data-loss risk.** **High.** A buggy equivalence test would let
*genuinely lost* content slip past the gate. Mitigations:
1. Default rules are *strict*: equality requires every meaningful attribute
   to match. Anything the canonicaliser cannot interpret is treated as
   non-equivalent (i.e. counted as deletion + creation, gate fires).
2. Land behind a feature flag (`EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS=true`)
   for one release so users can disable if a corner case appears.
3. Audit-log every `regenerated` pair (count, kinds) so a postmortem can
   reconstruct what was suppressed.
4. Code review by a second pair of eyes before merge — this is the highest-
   risk task in the plan.

---

### C2 — §5 `version: "current"` & `current_version` in conflict errors

**Model:** opus
**Files:**
- [src/server/index.ts:854-1022](../src/server/index.ts#L854-L1022) — `update_page` schema + handler
- [src/server/index.ts:1117-1224](../src/server/index.ts#L1117-L1224) — `update_page_section` schema + handler
- [src/server/index.ts:649-727](../src/server/index.ts#L649-L727) — `create_page` (post-processing wait)
- [src/server/confluence-client.ts:737-745](../src/server/confluence-client.ts#L737-L745) — `ConfluenceConflictError`
- [src/server/index.test.ts](../src/server/index.test.ts) — handler tests

**Change.** Three coordinated changes:

1. **`version` accepts `"current"` or a positive int.** When `"current"`,
   the handler does a server-side `getPage` immediately before the
   submission, uses the returned version, and sends the update. The semantic
   contract is: *"apply this update on top of whatever the latest version
   is right now"* — the caller is explicitly opting out of optimistic
   concurrency. Document this clearly: it is **not** a conflict-resolution
   strategy for races against another writer; it is a "skip the read I'd
   otherwise need" shortcut. If a write lands between our read and submit,
   the API will still 409 and we propagate as before.
2. **`ConfluenceConflictError` includes `currentVersion`.** Extract the
   conflict response body, parse the current version, and attach it. The
   caller can then retry with `version: currentVersion + 0` (we return the
   *current* server version, not the next).
3. **`create_page` post-processing wait.** Optional: add a query param
   `wait_for_post_processing: true` (default `false` for backwards compat)
   that polls the page version once per 250 ms up to 3 s and returns the
   stable version. Most callers want this; default may flip to `true` in a
   later release.

**Tests.** In `index.test.ts`:
- `update_page({ version: "current" })` calls `getPage` once and uses the
  returned version. Mock the API.
- `ConfluenceConflictError.currentVersion` is set when the API returns a
  parseable conflict body.
- `create_page({ wait_for_post_processing: true })` polls and returns
  the stabilised version.

**Data-loss risk.** **Medium.** `version: "current"` deliberately bypasses
optimistic concurrency. A user who relies on the version number as a
"don't overwrite my coworker's changes" guard could lose work if they switch
to `"current"` without thinking. Mitigations:
1. Default remains a positive integer — `"current"` is opt-in.
2. Description text on the parameter spells out the trade-off explicitly.
3. The post-processing wait in (3) makes it safe to use the returned
   version directly without `"current"`, addressing the original pain point
   (post-processing churn) without the concurrency hazard.

---

### D1 — §4 `update_page_sections` (plural)

**Model:** opus
**Files:**
- [src/server/index.ts](../src/server/index.ts) — register new tool
- [src/server/safe-write.ts](../src/server/safe-write.ts) — extend the section-splice path to accept multiple sections
- [src/server/converter/update-orchestrator.ts](../src/server/converter/update-orchestrator.ts) — multi-section diff

**Change.** New tool `update_page_sections` with input
`{ page_id, version, version_message?, confirm_deletions?, sections: [{ section, body }, ...] }`.
Server splices each section into the stored content sequentially, then
submits a single page update with one version bump. Atomicity: either all
sections apply or none (no partial writes — if any section fails to match,
the whole update is rejected before submission).

Re-uses the section-finder from B1 (so it inherits the tolerant matcher) and
the equivalence pipeline from C1 (so cross-section link rewrites don't trip
the deletion gate).

**Tests.** New `index.test.ts` cases:
- Apply 4 sections at once, version bumps from N to N+1 (not N+4).
- One bad section name → entire call rejected, page unchanged.
- Sections with overlapping content (one section's body contains another
  heading) — assert deterministic order and final state.

**Data-loss risk.** **Medium.** Multi-section atomicity must be all-or-
nothing. A naïve implementation that applies sections sequentially and
*partially* commits on failure would silently corrupt pages. Mitigations:
1. Compute all section splices in memory against the source storage XML;
   only submit one final document.
2. If any section's heading is ambiguous or missing, throw before
   submission. No fallback "apply what we can" mode.
3. Test the all-fail-on-one-bad case explicitly.

**Skip / defer if cost is high.** The 30-tool-calls-down-to-12 win the
feedback projects mostly comes from §2 + §3, not from atomic batching. If
this task balloons in scope, ship 6.3.0 with §2/§3/§5 and defer D1/D2 to
6.4.0 — the loss is throughput, not correctness.

---

### D2 — §4b `find_replace` mode

**Model:** sonnet
**Files:**
- [src/server/index.ts](../src/server/index.ts) — extend `update_page_section` (or `update_page_sections` from D1)
- New tests

**Change.** Add an optional `find_replace: [{ find, replace }, ...]` mode to
`update_page_section` that, instead of replacing the section body, applies
literal string substitutions inside the section's storage XML. Replacement
strings can themselves contain Confluence storage syntax (caller's
responsibility — this is *not* markdown).

`find` is a **literal string**, not a regex. If `find` does not appear in
the section, the call fails (no silent no-op).

**Tests.** Replace the bold cross-link pattern from the source feedback —
`"**N. Title**"` → `"**[N. Title](confluence://...)**"` — and assert the
section's other content is unchanged byte-for-byte.

**Data-loss risk.** **Low** because the substitution is literal and scoped
to one section. But: a `find` string that accidentally matches inside an
attribute value or CDATA could corrupt macro syntax. Mitigation: tokenise
first (using the existing tokeniser pipeline), apply the substitution only
to text-token bodies, never to macro internals. Document the limitation.

---

### D3 — §10a `add_drawio_diagram` returns attachment + macro IDs

**Model:** haiku
**Files:**
- [src/server/index.ts:1777-1779](../src/server/index.ts#L1777-L1779) — return statement
- [src/server/index.test.ts](../src/server/index.test.ts) — extend test

**Change.** Add `attachment_id` (Confluence attachment ID) and `macro_id`
(`ac:macro-id` of the inserted `drawio` structured-macro) to the return
value. The attachment ID is already known from the upload step; the macro ID
is generated when constructing the storage XML — emit and capture it.

**Tests.** Existing `add_drawio_diagram` test should be extended to assert
both fields are non-empty strings.

**Data-loss risk.** None. Additive return-shape change. Verify no caller
parses the current return as a fixed schema (grep for `add_drawio_diagram`
return assertions).

---

### D4 — §10b `AI-edited` badge 409 retry

**Model:** sonnet
**Files:**
- [src/server/confluence-client.ts:1440-1452](../src/server/confluence-client.ts#L1440-L1452) — `setContentState`
- [src/server/provenance.ts:127-178](../src/server/provenance.ts#L127-L178) — `markPageUnverified`
- [src/server/provenance.test.ts](../src/server/provenance.test.ts)

**Change.** Pattern after `resolveComment` ([confluence-client.ts:1617-1619](../src/server/confluence-client.ts#L1617-L1619)):
on 409 from `setContentState`, retry up to 2 times with a 200 ms backoff. If
all retries fail, return a warning (existing behaviour) — do *not* surface
the 409 to the tool result.

**Tests.** Mock `setContentState` to fail twice with 409, succeed on third
call. Assert: no warning, badge is set. Mock 3× 409: warning is returned, no
throw.

**Data-loss risk.** None. The badge is metadata; a missed badge is a UX
regression, not data loss. Retries here cannot make the page worse.

---

### D5 — §11 Write-budget UX overhaul

**Model:** sonnet
**Files:**
- [src/server/write-budget.ts](../src/server/write-budget.ts) — defaults, env-var rename, error message rewrite, deprecation warning hook
- [src/server/write-budget.test.ts](../src/server/write-budget.test.ts) — numeric expectations + new alias/deprecation tests
- [src/server/safe-write.ts](../src/server/safe-write.ts) — wire one-shot deprecation warning into the existing tool-result warning channel
- [install-agent.md](../install-agent.md) — new "Write budget" section
- [CHANGELOG.md](../CHANGELOG.md)

**Symptom (added to feedback as §11).** The session built 12 pages with
cross-links across 4 sections each. Even once §2 + §3 collapse the count
from ~30 to ~12 tool calls, a realistic documentation pass — say, 30 pages
with cross-links and TOC tweaks — runs ~60 writes inside a single sitting.
The current 25-per-15-min rolling cap stalls that pass mid-build with a
`WRITE_BUDGET_EXCEEDED` error and a "wait ~9 minutes" message, even though
the agent is plainly doing legitimate, user-requested work. Worse: when the
agent does hit the cap, the error message gives the env var name but no
context about *why* the limit exists or what the user's options are, so the
agent typically dumps the error verbatim and the user is confused.

This task addresses three coupled issues together: the defaults (D5a), the
misleading env var name (D5b), and the agent's lack of guidance for
explaining the limit (D5c).

#### D5a — Raise the two defaults

At [write-budget.ts:42-43](../src/server/write-budget.ts#L42-L43):

```ts
const DEFAULT_SESSION_BUDGET = 250;  // was 100
const DEFAULT_HOURLY_BUDGET  = 75;   // was 25
```

Update the header doc comment to reflect the new numbers and note the
rationale: the cap still catches a runaway loop (an unconstrained agent can
trivially issue 200+ writes/min), but accommodates a multi-page
documentation build at human pace.

#### D5b — Rename `EPIMETHIAN_WRITE_BUDGET_HOURLY` → `EPIMETHIAN_WRITE_BUDGET_ROLLING`

The window has been 15 min since 6.2.0; the env var name no longer matches.
Resolution rules at startup, in priority order:

1. If `EPIMETHIAN_WRITE_BUDGET_ROLLING` is set, use it.
2. Else if `EPIMETHIAN_WRITE_BUDGET_HOURLY` is set, use it **and** record a
   deprecation flag on the singleton.
3. Else use the default (75).

Both names continue to parse; `_HOURLY` is a deprecated alias, not a
removal. Removal scheduled for 7.0.0; track in `doc/design/06-future.md`.

**Surfacing the deprecation warning to the agent.** stderr is invisible to
most MCP clients, so the deprecation must reach the tool result. Mechanism:

- On the first successful `consume()` of the process, if the deprecation
  flag is set, push one warning into the `WarningAccumulator` already
  threaded through `safe-write.ts`. After it fires once, the flag is
  cleared so subsequent writes are silent.
- The warning text targets the agent, not the human:
  > **Deprecated MCP config:** the user's MCP config sets
  > `EPIMETHIAN_WRITE_BUDGET_HOURLY`, which still works but has been
  > renamed to `EPIMETHIAN_WRITE_BUDGET_ROLLING` (the window is 15 min,
  > not 60). Tell the user to update the env-var name in their `.mcp.json`
  > (or equivalent MCP config). The old name will be removed in 7.0.0.

  This phrasing matters: the agent should see "tell the user", not "this
  is wrong" — that nudges the agent into a clear hand-off rather than
  silently swallowing the warning.

- The same guidance is appended to any `WriteBudgetExceededError` whose
  cap was sourced from the deprecated var, so the agent sees it in the
  one place users actually look.

#### D5c — Rewrite the `WriteBudgetExceededError` message and add an agent-guide section

**Error message.** Replace the current terse message at
[write-budget.ts:88-112](../src/server/write-budget.ts#L88-L112) with a
structured, agent-readable explanation. Spec:

```
Write budget exhausted ({scope}): {current} writes in the
{window-description}, limit {limit}.

Why this exists: epimethian-mcp caps writes per session and per
15-minute window as a safety net against runaway agents (loops,
mistakes in long autonomous runs). The cap is not a Confluence rate
limit — it is a local guard.

What to tell the user:
  - Briefly explain that the safety budget has been reached.
  - Confirm whether the work in progress was intentional. If the agent
    is mid-task on user-requested work, the user almost certainly wants
    to raise the cap.
  - If unintentional (loop, retries gone wrong), STOP and ask the user
    before doing anything else.

How to raise or disable the cap:
  - Edit the user's MCP config (typically .mcp.json) and add to the
    "env" block for this server:
        "EPIMETHIAN_WRITE_BUDGET_{SCOPE_UPPER}": "<higher number>"
    Set to "0" to disable this scope entirely.
  - Restart the MCP server (re-open the client) for the new value to
    take effect.
  - For the rolling window, the env var name is
    EPIMETHIAN_WRITE_BUDGET_ROLLING (the legacy name
    EPIMETHIAN_WRITE_BUDGET_HOURLY is still accepted as an alias).

Window opens again in ~{N} min if you wait.
```

The `{scope}` is `"session"` or `"rolling"` (rename from the current
`"hourly"` value — keep the literal `"hourly"` accepted in tests for
backward compat but emit `"rolling"` going forward). Strip `console.error`
from `parseBudget`; route it through the warning channel instead.

**Agent guide section.** Add a new section to
[install-agent.md](../install-agent.md), after "Troubleshooting" and before
"Available Tools":

```
## Write budget (safety cap on writes)

epimethian-mcp enforces two write-rate caps per server process:

- **Session cap** (default 250): total writes since the server started.
- **Rolling cap** (default 75 per 15-minute window): catches bursts.

These are local safety nets, not Confluence limits. They exist because
an autonomous agent in a retry loop or with a bad plan can issue
hundreds of writes very quickly, and most users would rather have a
brief pause to confirm than discover the result an hour later.

### What to do when you (the agent) hit `WRITE_BUDGET_EXCEEDED`

1. **Stop and check.** Was the in-progress work user-requested and
   going as planned? If unsure, ask the user before continuing.
2. **Explain to the user, in your own words:**
   - The safety budget has been hit (which scope, current vs. limit).
   - What the budget is for: a guard against runaway agents.
   - Whether the work-in-progress is legitimate (your judgement).
   - The two ways forward: wait for the rolling window to reopen, or
     raise the cap.
3. **If the user wants to raise the cap**, give them this snippet to
   add to the `env` block of the epimethian-mcp entry in their MCP
   config (`.mcp.json` or equivalent — see Step 4 above for the
   layout):

   ```json
   "EPIMETHIAN_WRITE_BUDGET_ROLLING": "200",
   "EPIMETHIAN_WRITE_BUDGET_SESSION": "1000"
   ```

   Set either value to `"0"` to disable that scope. The user must
   restart the MCP server (re-open the MCP client) for changes to
   take effect.
4. **If the user gets a deprecation warning** about
   `EPIMETHIAN_WRITE_BUDGET_HOURLY`, tell them to rename it to
   `EPIMETHIAN_WRITE_BUDGET_ROLLING` in the same config file. The old
   name still works but will be removed in version 7.

### Operator-side defaults

| Var | Default | Disable |
|---|---|---|
| `EPIMETHIAN_WRITE_BUDGET_SESSION` | 250 | `0` |
| `EPIMETHIAN_WRITE_BUDGET_ROLLING` | 75  | `0` |
| `EPIMETHIAN_WRITE_BUDGET_HOURLY`  | (alias for `_ROLLING`, deprecated) | — |
```

The exact prose can be tightened by the implementing agent, but the
information set must include: purpose, what to tell the user, the
config snippet, restart requirement, deprecation note.

#### Tests

In `write-budget.test.ts`:
- Default values are now 250 / 75.
- `EPIMETHIAN_WRITE_BUDGET_ROLLING` overrides the default.
- `EPIMETHIAN_WRITE_BUDGET_HOURLY` overrides the default *and* sets the
  deprecation flag.
- `_ROLLING` wins over `_HOURLY` when both are set; deprecation flag
  remains *unset* in that case.
- 60 sequential `consume()` calls within a window do not exhaust the
  rolling cap (proves the new ceiling).
- The error message includes the `Why this exists` and
  `How to raise or disable the cap` sections.
- One-shot deprecation: only the first `consume()` after a hot-set of
  `_HOURLY` produces a warning (test via the public `consume()` API
  with a stub warning sink).

Add an `install-agent.test.ts` assertion that the new section heading
exists, so a future doc reshuffle can't silently delete it.

#### Data-loss risk

**None directly.** The budget is a defence against runaway agents, not
against destructive single calls — every write still goes through the
elicitation gate (E4) and provenance checks (E2). Raising the ceiling
means a buggy agent in a retry loop has more rope before the budget
bites; mitigation is that 250/75 are still well below where a legitimate
burst could plausibly land, and operators can tighten via env var. The
agent-guide rewrite explicitly tells the agent to **stop and check**
before recommending a raise — this is the human-in-the-loop guard for
the looser default.

The env-var rename is purely additive (alias, not removal); no operator
config breaks. The deprecation warning is a one-shot per process so it
doesn't pollute every tool result.

---

## 4. Verification & rollout

After each lane completes, run from `/Users/rmyers/repos/dot/epimethian-mcp`:

```bash
npm run check        # tsc + eslint + prettier
npm test             # vitest, ~801+ tests
npm run build
```

**Manual smoke test (per release):**
1. `create_page` against a sandbox page; immediately call `update_page`
   with the returned version. Should not 409 once C2 ships, or should 409
   with `current_version` populated.
2. `update_page_section` with a plain heading name against an
   auto-numbered space. Should resolve once B1 ships.
3. Re-run the original 12-page tree build (or a 3-page subset) and count
   tool calls. Target: ≤ 14 calls (down from ~30) once §2 + §3 land.

**CHANGELOG entries** for each version, in the existing voice (terse, technical,
"why" before "what"). Link the source feedback file from the entry.

---

## 5. Out of scope

- Rewriting the elicitation transport (e.g. queueing, custom timeouts) —
  too invasive for this batch. The error-code split in A1 is the surface
  fix.
- A general "macro equivalence" framework that goes beyond the rules in
  C1 — those rules cover ~100% of the feedback-session deletions; broader
  rules can wait for a real second case.
- Fixing Confluence-side bugs (e.g. server-side heading truncation if B4
  proves the converter is innocent). File upstream and document; do not
  attempt to work around in storage XML.
