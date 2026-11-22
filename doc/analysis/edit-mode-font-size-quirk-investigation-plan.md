# Plan: pinpoint the edit-mode font-size quirk and identify the exact fix

**Companion to:**
[edit-mode-font-size-quirk.md](./edit-mode-font-size-quirk.md),
[edit-mode-font-size-quirk-solutions.md](./edit-mode-font-size-quirk-solutions.md)
**Status:** plan only; nothing executed
**Date:** 2026-05-01

## Goals

1. Decide which of the two diagnoses in the original analysis is the
   actual cause of the size delta:
   - **D1 (CSS):** the editor styles nested `<p>` smaller than top-level `<p>`.
   - **D2 (metadata):** the editor styles imported paragraphs (regardless of
     nesting) smaller because they lack ADF marker metadata.
2. Identify the exact change to ship (or confirm that the right answer is
   "document and stop"). The fix must be tied to the cause by a measurement,
   not a hypothesis.
3. Produce a permanent, reproducible artefact of the investigation
   (probe pages, storage dumps, ADF dumps, screenshots) so future agents
   don't re-run guesswork.

## Non-goals

- Building an MD→ADF converter from scratch (companion doc option 4 — too
  expensive; only revisit if S2 fails *and* the symptom escalates).
- Fixing anything in view-mode rendering (not affected).
- Rewriting `safePrepareBody`, the diff pipeline, or the token-preservation
  logic. The investigation is allowed to add an opt-in publish branch but
  must not perturb the default path until a fix is chosen.

## Setup (one-time)

1. **Scratch space.** Use the user's personal Confluence space
   (`~rmyers`) only. No customer tenants. The example page from the
   original report (`890142725`) is a usable starting reference.
2. **Probe page template.** Hand-author one canonical markdown body that
   exercises every context the symptom is reported in:

   ```md
   Top-level paragraph for baseline comparison.

   - Bullet item with **bold** and `code`.
   - Second bullet item.

   1. Numbered item one.
   2. Numbered item two.

   | Col A | Col B |
   |-------|-------|
   | Cell 1 | Cell 2 |

   :warning[Panel body with **bold** and a [link](https://example.com).]

   :::info
   Multi-line panel body.

   With a second paragraph.
   :::
   ```

   Save this as `doc/analysis/fixtures/edit-mode-font-size-probe.md` so
   every phase uses the identical input.
3. **Capture tooling.** A small script
   (`doc/analysis/fixtures/capture.sh` or similar) that, given a page id,
   dumps `body.storage`, `body.atlas_doc_format`, and `body.editor` into
   timestamped files. Read-only. No mutation.
4. **Naming.** Probe pages use a fixed prefix
   (`edit-mode-font-probe-<phase>-<n>`) so they're trivially findable and
   cleanable later.

Confidentiality reminder: scratch pages and dumps must stay in `~rmyers`;
nothing in this investigation should reference or use customer tenants.

## Phase 0 — bound the problem (cheap, parallelizable)

**Goal:** confirm the symptom is real and characterize where it appears.
Without this, every later experiment is chasing a possibly-imagined delta.

| # | Experiment | Model | Output |
|---|---|---|---|
| 0.1 | Publish the probe markdown via `create_page`. Open in latest editor. Photograph the size delta against a typed paragraph above the imported content. | manual | screenshot |
| 0.2 | Publish a second copy and open in the **legacy editor** (if accessible on this Cloud site). Photograph again. | manual | screenshot |
| 0.3 | Toggle the workspace theme (light/dark and any alternate themes available) on the page from 0.1. Photograph at each setting. | manual | screenshots |
| 0.4 | View-mode check: publish, open the published page (not the editor). Photograph all four contexts (paragraph, list, table, panel). | manual | screenshot |

0.1 / 0.2 / 0.3 / 0.4 are independent and can run in any order.

**Pass criteria for Phase 0:**

- 0.1 reproduces the reported delta in at least one context
  (list / table cell / panel body).
- 0.4 confirms view mode is unaffected (matches the original report).

**Routing:**

- If 0.1 fails to reproduce: stop the investigation. The symptom may
  have been fixed server-side. Update the original analysis with the
  new observation and close out.
- If 0.2 (legacy editor) does **not** show the delta: the cause is in
  the new editor's CSS or ADF render path (favors D1/D2). Continue.
- If 0.2 *does* show the delta: the cause is upstream of editor choice;
  it's in the storage we submit. Continue, but D2 is somewhat less
  likely (legacy editor is unlikely to use ADF marker attrs).
- If 0.3 changes the magnitude of the delta across themes: theme CSS is
  a contributor. The fix may need to be CSS-targeted; D1 is in play.

**Artefacts:** all screenshots, plus storage dumps from `get_page` for
each probe page, saved under `doc/analysis/fixtures/phase-0/`.

## Phase 1 — localize the cause (sequential, depends on Phase 0)

**Goal:** decide between D1 (CSS) and D2 (metadata) by measurement.

### 1.1 — Storage shape audit

Run `get_page` on the Phase 0 probe pages and confirm the original doc's
claim that the server rewraps `<li>X</li>` → `<li><p>X</p></li>` etc.
Diff against the converter output (run `markdownToStorage` on the same
input).

- Already strongly evidenced by the original analysis; this is a
  re-verification, not a discovery step.
- **Pass:** rewrite happens as documented.
- **Fail:** rewrite has changed since the original report — the symptom
  may have a different cause now. Update the analysis and re-plan.

### 1.2 — Capture the typed-paragraph reference

In the editor, open one of the Phase 0 probe pages and **type fresh
content** in each context:

- A new paragraph above the imported content.
- A new bullet at the end of the imported list.
- A new row at the end of the imported table.
- A new line inside the imported `:::info` panel.

Save. Then `get_page` and capture both `body.storage` and
`body.atlas_doc_format` (if available on this site).

Diff the typed content against the imported content within each context.
The diff is the cause candidate.

**Three possible outcomes:**

- **A. Typed and imported are byte-identical in storage.** D1 wins:
  the delta is pure CSS, not metadata. Storage is not the right level
  to fix it. Skip to Phase 2 S2 only (ADF submission may bypass the CSS
  rule entirely).
- **B. Typed has marker attributes on `<p>` (e.g. `data-renderer-mark`,
  `local-id`, `ac:local-id`) that imported lacks.** D2 wins. Note the
  exact set of attributes. Continue to Phase 2 S1.
- **C. Typed differs in some other structural way** (different
  element, different macro form, different nesting). New diagnosis;
  re-plan.

**Routing:** outcome of 1.2 determines which of S1 / S2 to probe in Phase 2.

### 1.3 — ADF body comparison (only if `body.atlas_doc_format` is exposed on read)

If outcome 1.2.B happens, also pull `body.atlas_doc_format` for both the
imported and typed content. Confirm whether the missing storage-level
attributes correspond to a missing ADF node attribute (e.g. ADF
`paragraph` nodes carry attrs that storage maps to `data-renderer-mark`).
This anchors the fix in the actual ADF schema rather than in
reverse-engineered storage attrs.

## Phase 2 — test the candidate fix (parallelizable)

Phase 2 runs *only the experiments routed to by Phase 1*. Don't run
both arms unless 1.2 was ambiguous.

### S1 — Forge ADF marker attrs in storage (run if Phase 1 routed to D2)

**Goal:** measure whether the attributes identified in 1.2 / 1.3
survive a save round-trip when we emit them ourselves.

| # | Experiment | Model | Output |
|---|---|---|---|
| 2.S1.1 | Build a hand-crafted storage body that mirrors the probe page but injects the attrs from 1.2 onto every nested `<p>` (in `<li>`, `<td>`, `<th>`, `<ac:rich-text-body>`). Submit via raw `create_page` (bypass converter — see 2.S1.4). | sonnet | probe page |
| 2.S1.2 | `get_page` the result. Diff submitted vs stored. Note which attrs survived and which were stripped. | sonnet | diff |
| 2.S1.3 | If anything survived, open in editor and photograph the size delta against typed content. | manual | screenshot |
| 2.S1.4 | Bypass mechanism: temporarily allow raw HTML through `markdownToStorage` (`allowRawHtml: true`, already supported per [md-to-storage.ts:1114-1120](../../src/server/converter/md-to-storage.ts#L1114-L1120)) for this single probe call only. **Do not commit this code path.** | sonnet | none |

**Pass criteria:**

- One or more attrs survive the storage validator.
- With those attrs present, the size delta is visibly closed (or
  meaningfully reduced) in the editor.

**Routing:**

- **Both pass:** S1 is the fix. Proceed to Phase 3 with a converter
  change: emit the surviving attr(s) on every nested `<p>` we generate.
  Touch points are bounded — list/table use markdown-it defaults, so
  we'd add custom renderers for `list_item_open` and the table cell
  rules; panels are already wrapped at
  [md-to-storage.ts:669](../../src/server/converter/md-to-storage.ts#L669)
  and [md-to-storage.ts:215](../../src/server/converter/md-to-storage.ts#L215).
- **Attrs survive but delta doesn't close:** D2 was the wrong
  diagnosis. The attrs we copied weren't load-bearing. Fall through
  to S2.
- **Attrs are stripped:** D2 dies as a fix vector. Fall through to S2.

### S2 — Submit ADF via Confluence's storage→ADF converter (run if Phase 1 routed to D1, or if S1 fails)

**Goal:** measure whether routing storage through Confluence's own
`/contentbody/convert/atlas_doc_format` endpoint produces an ADF body
that, when submitted, renders without the size delta.

| # | Experiment | Model | Output |
|---|---|---|---|
| 2.S2.1 | Verify `/wiki/rest/api/contentbody/convert/atlas_doc_format` exists and is callable with our auth scope. One curl. | sonnet | API response |
| 2.S2.2 | POST the Phase 0 probe storage to that endpoint. Save the ADF result. | sonnet | ADF dump |
| 2.S2.3 | Diff 2.S2.2 against the typed-content ADF captured in 1.3 (if available). Are the marker attrs present in the converted ADF? | sonnet | diff |
| 2.S2.4 | Determine whether `body.atlas_doc_format` is accepted on the **v1** create/update endpoints we currently use ([confluence-client.ts:961, 1036, 1638, 1642, 1666, 1696](../../src/server/confluence-client.ts#L961)), or whether v2 (`/api/v2/pages`) is required. One curl per endpoint variant. | sonnet | findings |
| 2.S2.5 | If any submission path accepts ADF: publish the probe ADF that way. Open in editor, photograph the size delta. | manual | screenshot |

2.S2.1 / 2.S2.4 are independent of each other and of 2.S2.2 / 2.S2.3 —
fan them out in parallel.

**Pass criteria:**

- 2.S2.1 returns ADF.
- 2.S2.4 identifies at least one submission path that accepts ADF
  without a v2-migration prerequisite (or the v2-migration cost is
  bounded and acceptable).
- 2.S2.5 shows the size delta closed when published as ADF.

**Routing:**

- **All pass:** S2 is the fix. Proceed to Phase 3 with an opt-in
  `use_adf: true` flag on write tools. Storage path remains the
  default; ADF path is gated.
- **2.S2.1 fails (endpoint absent or unauthorized):** S2 is dead.
  Fall through.
- **2.S2.5 fails (ADF submission produces the same delta):** the
  server's storage→ADF conversion is lossy in the way we feared.
  Building MD→ADF natively is the only remaining technical fix, and
  the cost-benefit per the original analysis says don't. Fall
  through to "document and stop".

### S3 — Read-modify-write (run unconditionally as sanity check)

**Goal:** rule out the cheap "magic round-trip" hypothesis.

| # | Experiment | Model | Output |
|---|---|---|---|
| 2.S3.1 | After Phase 0 publish, immediately `update_page` with the storage we just read back (no edits). Open in editor. Photograph. | manual | screenshot |

**Expected:** no change. Cheap to confirm.

## Phase 3 — decide and ship

Single decision point. Inputs: outcomes of Phase 1 and Phase 2.

| Phase 1 outcome | Phase 2 outcome | Action |
|---|---|---|
| D2 (metadata diff) | S1 closes delta, attrs survive | Implement S1: emit surviving attrs from converter. Add regression test that verifies the attrs are present after `markdownToStorage` and that a round-trip through the API preserves them on the probe page. |
| D2, but S1 attrs stripped | S2 closes delta | Implement S2 as opt-in `use_adf: true` flag. Default path unchanged. Document the flag in `README.md`. |
| D1 (pure CSS) | S2 closes delta | Same as above (S2 opt-in). |
| D1 | S2 fails | Document the quirk in `README.md`. Close investigation. |
| D2 | Both S1 and S2 fail | Document the quirk in `README.md`. Close investigation. |
| Inconclusive Phase 1 | n/a | Loop back to Phase 0 with a tighter probe; do not implement. |

**Independent of the technical decision:** document the quirk in
`README.md` and `install-agent.md`. This is the original analysis's
"cheapest mitigation" and shouldn't wait for the technical investigation
to finish.

Any code change shipped from Phase 3 must also pass the user's standard
data-loss review (`feedback_data_loss_review`): walk every write path
touched and confirm no scenario can drop user content. The S1 path is
purely additive (extra attrs on existing elements); S2 introduces a new
publish branch and warrants closer review.

## Decision tree (compact)

```
Phase 0: reproduce + characterize
  ├─ no repro → STOP, update doc
  └─ repro → Phase 1

Phase 1: storage shape audit + typed-vs-imported diff
  ├─ A: byte-identical → D1 → Phase 2 S2 only
  ├─ B: marker-attr diff → D2 → Phase 2 S1 (then S2 if S1 fails)
  └─ C: structural diff → STOP, re-plan

Phase 2 S1 (if D2):
  ├─ attrs survive AND delta closes → SHIP S1
  ├─ attrs survive, delta stays → fall through to S2
  └─ attrs stripped → fall through to S2

Phase 2 S2 (if D1, or S1 failed):
  ├─ ADF submission closes delta → SHIP S2 as opt-in flag
  └─ ADF submission fails or endpoint unavailable → DOCUMENT-AND-STOP

Phase 2 S3 (always, cheap):
  └─ rules out free magic-round-trip fix
```

## Failure modes and abort conditions

- **Probe page can't be created** (auth, space permissions): abort and
  re-check setup. Don't fall back to a customer tenant.
- **`body.atlas_doc_format` is not exposed on read** for this Cloud
  site: 1.3 and parts of 2.S2 become impossible. Note the limitation;
  S2 may still be viable but unmeasurable up-front.
- **Symptom reproduces inconsistently across runs:** the delta is being
  caused by something dynamic (recent edit timestamp, user preference,
  feature-flag rollout). Capture the variation, then stop — chasing a
  flaky CSS rule isn't worth the engineering time.
- **Server behavior changes mid-investigation** (Confluence rolls out
  an editor change): re-run Phase 0 to re-establish baseline. Don't
  trust earlier captures.
- **Total elapsed effort exceeds ~1 working day** without a clear
  cause: stop, document, ship the README note, and accept the quirk.
  The original analysis is correct that this is cosmetic and edit-mode
  only; investigation cost has a low ceiling.

## Artefacts

By end of investigation, `doc/analysis/fixtures/edit-mode-font-size/`
should contain:

- `probe.md` — the canonical input markdown.
- `phase-0/` — screenshots and storage dumps for repro / theme / editor
  variants.
- `phase-1/` — storage dumps and typed-vs-imported diffs.
- `phase-2-s1/` — forged-attr storage submissions, return diffs,
  screenshots.
- `phase-2-s2/` — convert-endpoint outputs, ADF submission attempts,
  screenshots.
- `findings.md` — single-page conclusion: which diagnosis won, which
  fix shipped (if any), what was ruled out and why.

`findings.md` is the durable artefact. The original analysis and this
plan should be updated to point at it once the investigation closes.

## Parallelization summary (per `feedback_parallel_plans`)

- **Phase 0:** all four experiments parallel (one main agent or human
  driver coordinating; sub-agents can fetch pages and dump storage
  concurrently). Sonnet for capture, Opus for synthesis at end of phase.
- **Phase 1:** strictly sequential (1.1 → 1.2 → 1.3); each step's
  output decides whether the next runs.
- **Phase 2:** S1, S2, S3 run in parallel where their preconditions
  hold. S2's sub-experiments (2.S2.1, 2.S2.4) parallel within S2.
- **Phase 3:** single decision step; Opus.
