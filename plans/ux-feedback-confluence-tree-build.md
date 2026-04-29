# UX Feedback: Building a 12-page Confluence tree with cross-links and diagrams

Source: live session 2026-04-28. Built a 12-page German-language page tree
(jambit personal space, parent ID 88048037) with cross-references and
draw.io diagrams. The build worked but was slower and more confusing than
it should have been. This document captures the friction points and
proposes concrete changes.

Pain points are ordered by impact. The two highest-leverage changes are
called out at the end.

## 1. The "user declined" error message is misleading when no user was prompted

**Symptom.** Four `update_page` calls with `confirm_deletions: true` came
back as `"update_page was not executed — user declined."`. The user
confirmed they were never asked. An LLM caller looking at the result has
no way to distinguish active denial from the elicitation channel being
unavailable, and lost trust ensued.

**Root cause.** [src/server/elicitation.ts:131][el131] returns
`"user declined"` for the `decline` action. The same path is reached
when:

- the MCP client doesn't support elicitation
- the elicitation request times out or errors before the user sees it
- the elicitation returns `cancel` / unknown action
- a server-side policy rejects the call before elicitation is even attempted

For an LLM caller, all of these look identical to a user actively
pressing "no".

**Proposed change.**

- Distinguish the codes in `GatedOperationError`: `USER_DECLINED`,
  `USER_CANCELLED`, `ELICITATION_UNAVAILABLE` /
  `NO_USER_RESPONSE`.
- Wire messages should match: e.g. `"no user response received (client
  may not support elicitation)"` or `"elicitation timed out"` instead
  of `"user declined"`.
- When `clientSupportsElicitation()` returns false at
  [index.ts:111][idx111], don't pretend a user said no — return a
  distinct `ELICITATION_REQUIRED_BUT_UNAVAILABLE` error with an
  actionable hint, e.g. *"set this flag in your project's
  `settings.local.json` allow rules, or use `update_page_section`
  instead"*.

[el131]: ../src/server/elicitation.ts
[idx111]: ../src/server/index.ts

## 2. `confirm_deletions` triggers on cosmetic re-rendering of the same content

**Symptom.** The `Quellen` page had 8 internal Confluence URLs in its
markdown. Re-submitting the *same URLs* in a new section body produced
"8 ac:link macros deleted" and required `confirm_deletions: true`. The
replacement macros were functionally identical — same href, same
anchor, same display text. Nothing was actually being lost.

**Root cause.** Token preservation is by token ID, not semantic
equivalence. Any link rewrite produces a fresh ID even when the
resulting macro is identical.

**Proposed change.** In [safe-write.ts][sw] where deletions are tallied,
treat a deletion+creation pair as a no-op when the resulting macro is
byte-equivalent to the deleted one (or, for `<ac:link>`, when
`href` / page-target / display-text all match). Keep `confirm_deletions`
strict for genuine semantic deletions (TOC removed entirely, link
removed entirely), but suppress it for "rewriter regenerated equivalent
macro". This eliminates the most common false-positive that pushed the
session toward many small section updates.

[sw]: ../src/server/safe-write.ts

## 3. The auto-numbered heading prefix in `findHeadingInTree` is undocumented and causes silent matching failures

**Symptom.** Calling
`update_page_section(section: "Lesereihenfolge")` returned
`"Section not found"` even though `headings_only` output contained
`Lesereihenfolge`. Discovery cost: 1 retry + 1 `get_page` for headings
+ reading the source.

**Root cause.** The Confluence space has heading auto-numbering enabled,
so the *stored* heading text becomes `"1.2. Lesereihenfolge"`.
[`findHeadingInTree:1724`][match] does
`heading.text.trim().toLowerCase() !== headingText.toLowerCase()`
— exact match. The `headings_only` output then shows
`"1.2. 1.2. Lesereihenfolge"` (synthetic outline number + stored text
that already contains the same number), which is genuinely confusing —
most callers will strip both numbers and fail.

**Proposed change (any one, ordered by preference):**

1. **Tolerant matcher.** In `findHeadingInTree`, after exact match
   fails, retry with the heading text stripped of a leading
   `^\d+(\.\d+)*\.\s+` prefix on either side. This makes
   `section: "Lesereihenfolge"`, `"1.2. Lesereihenfolge"`, and (if
   levels are unambiguous) plain text all resolve to the same heading.
2. **Fix `extractHeadings` to detect duplication.** When the synthetic
   counter prefix (`1.2.`) matches the prefix of the stored text, drop
   the synthetic one. The output becomes `"  1.2. Lesereihenfolge"`,
   which is unambiguous.
3. **Document the quirk.** Mention in tool descriptions that auto-
   numbered Confluence spaces require the prefix in the section
   parameter. (Lowest effort, but doesn't help LLMs that haven't read
   the description carefully.)

The combination of (1) and (2) would have saved a full round trip per
page in this session.

[match]: ../src/server/confluence-client.ts

## 4. No batch / multi-section update tool

**Symptom.** Each page that needed cross-links in 4 sections required
4 sequential `update_page_section` calls (each waits on the previous
version). The session ran 18 section updates across 4 waves; the waves
couldn't go faster because version increments serialise within a page.

**Proposed change.** Add `update_page_sections` (plural) that takes a
list `[{section, body}, ...]` and applies them atomically to a single
page, producing one version bump. Would have collapsed 4 waves to 2.

Also useful: a `find_replace` mode
(`{find: "**N. Title**", replace: "**[N. Title](confluence://...)**"}`)
for the very common cross-link-pass workflow. Saves having to resend
the full body of a section just to swap a few links.

## 5. Initial page version is unstable for several seconds after `create_page`

**Symptom.** `create_page` returned version 1; immediately calling
`update_page` with `version: 1` was rejected. Reading the page showed
it had silently advanced to version 4 — invisible post-processing
(link rewriter, TOC render, provenance badge) had bumped it. An extra
`get_page` per page was needed to discover the real version.

**Proposed change (any of these solves it):**

- Make `create_page` block until post-processing completes.
- Have `update_page` / `update_page_section` accept
  `version: "current"` (or `version: -1`) meaning *"use the latest
  version atomically; fail with conflict only on actual concurrent
  edits since I last read"*. The MCP can resolve "version: current"
  server-side without the LLM having to dance.
- In conflict errors, include `current_version: N` in the error body
  so the caller can retry with the right number without a second read.

## 6. Source-policy on `confirm_deletions` is too eager and the error explains nothing

**Symptom.** The very first `update_page` with `confirm_deletions: true`
was rejected (manifesting as "user declined" — see §1). The user's
request was *"add cross-references"*, which the policy didn't recognise
as authorising the implicit deletion-and-recreation of TOC / `ac:link`
macros. Switching to `update_page_section` worked.

**Root cause.** The policy treats `confirm_deletions` as fully
destructive, equal to `replace_body` / `confirm_shrinkage`. But
`confirm_deletions` is a much narrower acknowledgement — it just means
*"the rewriter will turn over some token IDs"*. Once §2 is fixed, this
is even more lopsided.

**Proposed change.**

- Once §2 lands, the elicitation gate for `confirm_deletions` only
  fires when *real* semantic deletion is happening. That alone fixes
  most of the friction.
- For the cases where it still fires, the elicitation prompt to the
  user should say what's being deleted in human terms — *"This will
  remove 1 TOC macro and 8 link macros that the new markdown does not
  regenerate"* — not just the flag name.
- If [`validateSource`][src-prov] blocks before elicitation even runs,
  the error message should say so explicitly:
  `"confirm_deletions blocked: source=user_request but the user's
  prompt did not authorise content deletion. To proceed, confirm
  interactively or rephrase request."`. The LLM caller then knows
  whether to retry or pivot.

[src-prov]: ../src/server/source-provenance.ts

## 7. Special characters truncate during heading conversion

**Symptom.** A page was created with `## TL;DR für die GF`. After
Confluence auto-numbering / post-processing, the heading became
`"1.1. TL;DR"` — the `" für die GF"` portion was silently dropped.
Cause not fully traced; likely a markdown→storage converter or
auto-numbering interaction with `;` or a German char after it.

**Proposed change.** Add a fuzz/property test for round-tripping
headings with: semicolons, colons, German umlauts, em/en-dashes,
German typographic quotes („"), parentheses, and ampersands. Whatever
is truncating them is silent data loss and worth catching.

## 8. `headings_only` output uses HTML entities

**Symptom.** Headings come back as
`"1.5. Entscheidungen f&uuml;r die Diskussion in der GF"`. To use that
string as the `section` parameter the caller has to decode
`&uuml;` → `ü`. The matcher does case-insensitive exact comparison,
so the decode has to be exactly right.

**Root cause.** [`extractHeadings` (confluence-client.ts:1665)][eh]
strips tags via regex but leaves entities.

**Proposed change.** Wrap `match[2].replace(/<[^>]+>/g, "")` with an
HTML-entity decode pass. One-line fix; the `headings_only` output
then mirrors what callers will type.

[eh]: ../src/server/confluence-client.ts

## 9. Tool descriptions don't warn about Confluence auto-numbering

**Symptom.** Three of the issues above (§3, §5, §7) trace back to a
Confluence space-level setting (auto-numbering) that the tool
descriptions never mention.

**Proposed change.** Add a one-paragraph *"Note on auto-numbered
spaces"* to the descriptions of `get_page` (headings_only mode),
`update_page_section`, and `create_page`. Three sentences, zero code
change, prevents most of the matching pain for any caller who reads
docs.

## 10. Lower-priority but worth tracking

- **`add_drawio_diagram` returns no handle.** It worked great, but the
  return value doesn't include an attachment ID or macro ID. A
  follow-up *"remove or replace diagram X"* would be hard to mechanise.
  Consider returning the attachment filename + the inserted macro
  element ID so subsequent edits are programmatic.
- **`'AI-edited' status badge` 409 in success output.** The Quellen
  update result included a 409 conflict on the badge update — the
  badge update appears to race with the page update. Fine here, but
  409 noise in success output looks alarming. Either retry the badge
  transparently or label it clearly as non-fatal.
- **Provenance for tool-internal acks.** If you ever need to
  distinguish *"user acknowledged via elicitation"* from *"tool callee
  assertion"*, the `source` field needs a fourth value, e.g.
  `elicitation_response`. Right now `user_request` covers two distinct
  things (the literal prompt + the user's elicitation answer).

## Highest-leverage two changes

If only two ship, ship:

- **§2** — suppress `confirm_deletions` for byte-equivalent macro
  regeneration.
- **§3** — tolerant section matcher with auto-numbering prefix.

Together they would have collapsed this session's work from roughly 30
tool calls to ~12 and removed both classes of confusing failures.
