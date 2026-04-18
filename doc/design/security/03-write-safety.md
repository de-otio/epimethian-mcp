# Write Safety — Content-Loss Guards

[← back to index](README.md)

Confluence pages are easy to destroy: one bad update can replace 20,000
characters of structured content with an empty body. The guards below make
that outcome require either multiple opt-ins or a genuine bug in the server.

## Guard pipeline

Every write path passes through two stages:

1. **Pre-transform guards** in `safePrepareBody` — evaluated *before* any
   markdown → storage conversion. These apply to user-facing content
   measurements.
2. **Post-transform guards** in `safeSubmitPage` — evaluated *after*
   conversion and just before the HTTP PUT. These catch bugs in the
   converter that would otherwise turn a sane-looking input into
   destructive output.

See `src/server/safe-write.ts` for the implementations and
`src/server/converter/content-safety-guards.ts` for the individual guards.

## Pre-transform guards

Each pre-transform guard returns an `ok: true` result or a named error code
with a human-readable reason.

### Shrinkage guard

- **Trigger:** `oldLen > 200` and `newLen < 0.5 * oldLen`.
- **Error code:** `SHRINKAGE_NOT_CONFIRMED`.
- **Opt-out:** `confirm_shrinkage: true` on `update_page`.
- Catches the common "AI agent rewrites the page as a one-line summary"
  failure.

### Structural integrity guard

- **Trigger:** `oldHeadings >= 3` and `newHeadings < 0.5 * oldHeadings`.
- **Error code:** `STRUCTURE_LOSS_NOT_CONFIRMED`.
- **Opt-out:** `confirm_structure_loss: true`.
- Counts `<h1>`–`<h6>` outside macro code blocks and HTML comments.

### Empty-body rejection

- **Trigger:** `oldLen > 100` and stripped text length `< 3`.
- **Error code:** `EMPTY_BODY_REJECTED`.
- **No opt-out.** Even with both `confirm_*` flags set, a page cannot be
  reduced to an empty body via `update_page`.

### Macro-loss guard

- **Trigger:** `oldMacros > 0` and `newMacros == 0`.
- **Error code:** `MACRO_LOSS_NOT_CONFIRMED`.
- **Opt-out:** `confirm_shrinkage: true` (shared flag — macro loss is
  usually a specialised form of shrinkage).
- Catches cases the shrinkage guard misses: a page made almost entirely of
  macros can be replaced by similar-length plain text and fall under the
  50% threshold.

### Table-loss guard

- **Trigger:** `oldTables > 0` and `newTables == 0`.
- **Error code:** `TABLE_LOSS_NOT_CONFIRMED`.
- **Opt-out:** `confirm_shrinkage: true`.

## Post-transform guards

After markdown has been converted to storage format, before the PUT:

### Whitespace-only rejection

- **Trigger:** converted body is empty or contains only whitespace.
- **No opt-out.** Hard error.

### Catastrophic reduction

- **Trigger:** `oldLen > 500` and `newLen < 0.1 * oldLen` (>90% reduction).
- **No opt-out.** Hard error.
- Threshold deliberately more aggressive than the pre-transform shrinkage
  guard (90% vs 50%) to catch converter bugs specifically — a legitimate
  heavy-rewrite path is expected to produce at least 10% of the original
  length post-conversion.

See `src/server/safe-write.ts:378-409`.

### Content floor guard (`CONTENT_FLOOR_BREACHED`) — no opt-out

Fires *in addition to* 1A, 1B, 1C, 1D, 1E and runs last in the chain so
that the gated guards can still produce their actionable error codes
(`SHRINKAGE_NOT_CONFIRMED`, etc.) when applicable.

- **Length floor:** reject when `newLen < 10% of oldLen` on pages with
  `oldLen > 500`.
- **Text floor:** reject when `newText < 10` visible chars on pages with
  `oldText > 200` visible chars. Stricter variant of the empty-body
  guard (1C), which only catches bodies wiped to <3 visible chars.
- **No opt-out:** fires regardless of `confirm_shrinkage`,
  `confirm_structure_loss`, `confirmDeletions`, or `replace_body`. The
  error message explicitly states *"This limit applies even with
  `confirm_shrinkage: true` / `confirm_structure_loss: true`. To rewrite
  a page this drastically, delete and recreate it."*

Purpose: backstop against prompt-injection chains that talk the agent
into setting every `confirm_*` flag and thereby defeat the gated
guards. The floor guard guarantees the worst case is bounded regardless
of what flags the caller passes. See `plans/security-audit-fixes.md`
Track C (security audit Finding 3) and
`src/server/converter/content-safety-guards.ts`
(`enforceContentFloorGuard`).

## Round-trip safety for markdown view

`get_page(format: "markdown")` returns a **lossy** rendering where macros
become `[macro: name]` placeholders. Feeding that markdown back into
`update_page` would destroy every macro on the page.

The markdown output includes an HTML comment marker:

```html
<!-- epimethian:read-only-markdown -->
```

Any call to `update_page` whose body contains that marker is rejected with a
hard error (no opt-out).

See `src/server/safe-write.ts:601-610`.

## Additive tools

To avoid the "full body replace" path entirely for common edits, two
additive tools are provided:

- `prepend_to_page` — inserts content at the top of the page.
- `append_to_page` — inserts content at the bottom.

These are implemented by computing the new body from the old body plus the
insertion, *then* running the same guards. They cannot produce a shorter
body than the original, so shrinkage/structure guards are effectively no-ops
and the tools are safe to use in read-mostly workflows.

## Lossless revert

`revert_page` fetches the raw storage XML of the target historical version
via the v1 API (which returns it unprocessed) and PUTs it back as-is. No
markdown round-trip, no conversion, no data loss. The shrinkage guard still
runs (with an opt-out) in case the historical version is much smaller than
the current one.

## Version conflicts (optimistic concurrency)

Every `update_page` / `update_page_section` call includes the version number
read earlier. If the server returns 409, the error surfaced to the agent
tells it exactly what to do:

```
Version conflict: page <id> has been modified since you last read it.
Call get_page to fetch the latest version, then retry your update with
the new version number.
```

See `src/server/confluence-client.ts:473-481`.

## Mutation log (opt-in forensics)

Set `EPIMETHIAN_MUTATION_LOG=true` and every write operation appends a JSONL
record to `~/.epimethian/logs/YYYY-MM-DD.jsonl`. Each record contains:

- timestamp, operation name, page ID
- old and new version numbers
- old and new body **lengths and SHA-256 hashes** (first 16 hex chars) —
  lengths and hashes only, never body content
- MCP client label (e.g. "Claude Code")
- confirmShrinkage / confirmStructureLoss flags (for forensics)
- sanitized error message if the operation failed (max 200 chars, first
  line only)

Deliberately **not** logged: page titles (to avoid cross-tenant metadata
leakage in shared log review), credentials, page bodies.

File hygiene:

- Directory `~/.epimethian/logs/` created with mode `0700`.
- Log directory is rejected if it is a symlink (prevents symlink attacks on
  shared Linux hosts).
- Files opened with `O_EXCL` + mode `0600`.
- Logs older than 30 days are auto-deleted on startup.

See `src/server/mutation-log.ts`.
