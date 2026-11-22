# Edit-mode font-size quirk: candidate solutions

**Companion to:** [edit-mode-font-size-quirk.md](./edit-mode-font-size-quirk.md)
**Status:** investigation notes; nothing implemented
**Date:** 2026-05-01

## Re-framing the diagnosis

The companion doc lists two co-existing theories for the size delta:

1. The editor's CSS treats nested `<p>` (inside `<li>`, `<td>`, `<th>`,
   `<ac:rich-text-body>`) tighter than top-level `<p>`.
2. Natively-typed paragraphs carry ADF marker metadata
   (e.g. `data-renderer-mark`, `local-id`) that imported storage doesn't, and
   the editor styles "imported" paragraphs a notch tighter.

Inspection of the converter says these aren't equally load-bearing. Panel
bodies are emitted by us with an explicit `<p>` wrapper today
([md-to-storage.ts:669](../../src/server/converter/md-to-storage.ts#L669)
for `:warning[…]` directives,
[md-to-storage.ts:215](../../src/server/converter/md-to-storage.ts#L215)
for the `[!TYPE]` GitHub-alert path). The server doesn't have to rewrap
those — they already arrive wrapped. Yet the symptom is reported in panel
bodies all the same.

That means the size delta cannot be explained purely by "who emits the inner
`<p>`". Both natively-typed panel bodies and our panel bodies end up as
nested `<p>` in storage, and they still render at different sizes in the
editor. The metadata theory (2) is the one carrying weight; the CSS-nesting
theory (1) is a contributing factor at most.

This re-framing matters because the rejected fixes in the companion doc
target theory (1) (strip the inner `<p>`; inject `style`/`class`). The fix
that targets theory (2) — forging ADF marker attrs — was rejected with
hedged language ("*may* be stripped, *risks* breaking") rather than a
measurement. Worth a probe before that door is closed.

## Candidate solutions

### S1. Probe whether ADF marker attrs survive a save round-trip

**Cost:** ~30 minutes. **Risk:** none (read-only experiment on a scratch page).

The companion doc's option 3 was rejected on the assumption that forged
`data-renderer-mark` / ADF marker attributes get stripped by the storage
validator. That assumption hasn't been measured. Run a probe:

1. Create a scratch page via `create_page` with hand-crafted storage that
   includes:
   - `<li><p data-renderer-mark="true">X</p></li>`
   - `<li><p ac:local-id="forged-id-1">Y</p></li>`
   - `<td><p data-renderer-mark="true">Z</p></td>`
   - `<ac:rich-text-body><p data-renderer-mark="true">W</p></ac:rich-text-body>`
2. Read back via `get_page` and diff against what was submitted.
3. If anything survives, open the page in the editor and visually compare
   sizes against natively-typed text.

**If attrs survive AND the size delta closes:** ship as a converter change.
Tight lists/cells get a known-safe ADF marker injected at emit time, no
extra API calls, no schema changes.

**If attrs survive but the delta doesn't close:** we've ruled out the
metadata theory and can confidently focus on theory (1) or accept the
quirk.

**If attrs are stripped:** promote the companion doc's "may be stripped"
to "is stripped" with a concrete pointer to the probe page, and close the
door on this approach.

### S2. Submit ADF via Confluence's own storage→ADF converter

**Cost:** ~1 hour for the probe leg; multi-day for full implementation if
the probe is positive. **Risk:** opt-in flag, doesn't disturb default path.

The companion doc's option 4 (author via ADF instead of storage) was
rejected as "a much larger change" because it implies writing a markdown→ADF
converter. There's a cheaper variant: keep `markdownToStorage` exactly as
today, then before publishing route the storage through Confluence's own
`/wiki/rest/api/contentbody/convert/atlas_doc_format` endpoint and submit
the result with `body: { representation: "atlas_doc_format", value: ... }`.

We don't write a converter. Atlassian's server does the conversion. The
question is whether the resulting ADF carries the editor metadata that
natively-typed pages do, or whether the server's storage→ADF
normalization is lossy in the same way the storage submit path appears to
be.

**Probe leg (~1 hour):**

1. POST a representative storage body to
   `/wiki/rest/api/contentbody/convert/atlas_doc_format`.
2. Save the ADF result.
3. Open a scratch page in the editor, type a paragraph, save, fetch the
   page in `body.atlas_doc_format` form.
4. Diff (1) against the typed-paragraph ADF in (3). If the marker
   attributes are present in (3) but absent in (1), this approach won't
   help.

**Implementation leg (only if probe is positive):**

- Today every write path uses `representation: "storage"`. Sites:
  [confluence-client.ts:961](../../src/server/confluence-client.ts#L961),
  [confluence-client.ts:1036](../../src/server/confluence-client.ts#L1036),
  [confluence-client.ts:1638](../../src/server/confluence-client.ts#L1638),
  [confluence-client.ts:1642](../../src/server/confluence-client.ts#L1642),
  [confluence-client.ts:1666](../../src/server/confluence-client.ts#L1666),
  [confluence-client.ts:1696](../../src/server/confluence-client.ts#L1696).
- A `use_adf: true` flag on write tools selects an alternate publish
  branch: `markdownToStorage → /contentbody/convert → POST atlas_doc_format`.
- Token-preservation, diff machinery, `safePrepareBody`, and
  `get_page`/`diff_page_versions` continue to operate on storage —
  only the final submission changes format.
- Adds one extra API round-trip per write. Probably acceptable; users opt
  in.
- Confirm whether `body.atlas_doc_format` works on the v1 endpoints we
  use today, or whether write paths need to migrate to v2
  (`/api/v2/pages`).

This is option 4 from the companion doc minus the converter-rewrite cost.
If the probe says ADF metadata is preserved, this becomes the cheapest
real fix.

### S3. Read-modify-write probe

**Cost:** ~5 minutes. **Risk:** almost certainly negative; included for
completeness.

After `create_page`, immediately `update_page` with the storage we read
back. Hypothesis: a second save through the same pipeline causes the
server to settle the page into a more "natively-styled" form. Same code
path → same output is the most likely outcome, but the probe is cheap and
rules out an entire class of "magic round-trip" speculation.

## Recommended order of operations

The companion doc's order — "document the quirk → investigate ADF →
empirical confirmation" — buries the cheapest unblocking work behind the
most expensive. Reorder:

1. **Empirical confirmation of the diagnosis.** Open one of the
   affected pages in two themes and in the legacy editor; observe whether
   the size delta survives both. This is the companion doc's "what we
   *might* do later" item 3 — it should run first because S1 and S2
   target different theories, and confirmation tells us which to chase.
2. **Run S1.** Cheapest probe. Either kills theory (2) or hands us a
   near-zero-cost fix.
3. **Run S2's probe leg only.** Don't start the implementation leg until
   the probe says the metadata is preserved.
4. **Decide.** Based on (2) and (3): ship S1 if attrs survive *and* close
   the delta; ship S2 as an opt-in flag if convert produces useful
   metadata; otherwise document the quirk and stop.
5. **Document the quirk in `README.md` regardless.** This is the
   companion doc's option 1 from "what we might do later", and shouldn't
   wait for the technical investigation. A user encountering the size
   delta should find a one-paragraph explanation, not file a bug.

S3 is optional throughout — run it whenever convenient as a sanity check.

## What this analysis doesn't change

- Option 1 of the companion doc (strip inner `<p>`) stays rejected. The
  server adds it back; verified.
- Option 2 (inject `style`/`class`) stays rejected. Storage validator
  strips them; verified empirically per the companion doc.
- Option 5 (tell users to retype) stays rejected.
- The companion doc's option 4 (build MD→ADF natively) stays correctly
  rejected on cost grounds. S2 is its cheaper cousin and should be
  attempted first.

## Open questions

- Does Confluence Cloud's `/contentbody/convert/atlas_doc_format` exist
  and behave as documented for our auth scope? (Cheap to verify with one
  curl.)
- Does `body.atlas_doc_format` work on the v1 endpoints we use, or only
  v2?
- Is the editor's storage→ADF render path the same code as
  `/contentbody/convert/atlas_doc_format`, or does it carry additional
  metadata that the convert endpoint doesn't synthesize? Determines
  whether S2 can possibly help.
