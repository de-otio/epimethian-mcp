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

## v6.0.0 additions

Sourced from
`doc/design/investigations/investigate-agent-loop-and-mass-damage/` and
`doc/design/investigations/investigate-prompt-injection-hardening/`.

### Input body size cap — `INPUT_BODY_TOO_LARGE` (Track A3)

`safePrepareBody` rejects `body > 2 MB` before any conversion work.
Normal pages are well under 100 KB; the cap catches pathological
markdown pastes that would waste CPU and memory on conversion before
the HTTP layer rejected them anyway.

### Byte-identical update short-circuit (Track A1)

`safeSubmitPage` compares the normalised submit body against the
normalised previous body (both routed through `normalizeBodyForSubmit`
for parity). Byte-identical updates skip the HTTP PUT and synthesise
the response — zero version churn for agent loops that re-submit
their own read-back unchanged. No mutation-log record (nothing
mutated).

### `set_page_status` dedup (Track A2)

The handler calls `getContentState` first; identical `(name, color)`
returns success with a "no-op: status unchanged" suffix without PUT.
Kills the most prolific version-churn vector.

### `update_page_section` section-not-found is `isError: true` (Track A4)

Previously a text-only "section not found" message that agents
monitoring `isError` treated as success. Now surfaces the structured
flag.

### Tightened `looksLikeMarkdown` (Track A5)

Inline `**bold**` and `[text](url)` patterns are no longer strong
markdown signals — required at least one line-anchored structural
pattern (heading, fenced code, GFM table separator, list marker,
GitHub alert, Pandoc container, setext underline). Fixes a round-
trip corruption where plain XHTML bodies containing inline links
were misclassified as markdown and re-converted.

### `delete_page` requires `version` (Track B1)

Mirrors `update_page`'s optimistic-concurrency check. Stale-context
replays from long-running agent sessions cannot delete pages that
were edited since the agent last read them. Opt-out for one release
via `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true`.

### Per-session canary + write-path echo detector — `WRITE_CONTAINS_UNTRUSTED_FENCE` (Track D3)

Every `fenceUntrusted` fence embeds `<!-- canary:EPI-${uuid} -->` on
its own line before the close fence. `safePrepareBody` rejects any
write whose body contains the canary or the fence markers
themselves. Catches agents that paste a read response verbatim into
a write — which would propagate any injection payload riding along
with the original read.

### Unicode sanitisation inside `fenceUntrusted` (Track D1)

Applied to tenant-authored content before the ASCII fence-escape
step:

- NFKC normalisation — fullwidth `＜` → ASCII `<`.
- Strip Unicode tag characters (U+E0000–U+E007F).
- Strip bidi controls (U+202A–U+202E, U+2066–U+2069).
- Strip zero-width joiners / non-joiners / spaces and word joiner.
- Strip C0 controls except `\t`, `\n`, `\r`.
- Strip DEL and C1 controls.

Closes: fullwidth-bracket fence spoofing, tag-character
steganography, RTL-override obfuscation, ANSI escape injection into
terminal-visible logs.

### Injection-signal scanning + fence attribute (Track D2)

Before fencing, tenant content is scanned for:

- Named Epimethian tools (whole-word match).
- Named destructive flags (`confirm_shrinkage`,
  `confirm_structure_loss`, `confirm_deletions`, `replace_body`).
- Instruction-style framing (`IGNORE ABOVE`, `NEW INSTRUCTIONS`,
  `<|im_start|>`, `SYSTEM:`, …).
- References to the fence strings themselves.

Fires populate `injection-signals=<comma-list>` on the fence header,
emit the `[INJECTION-SIGNAL]` stderr line, and correlate into the
mutation log as `precedingSignals` on subsequent writes.

### `source` parameter on destructive tools (Track E2)

Optional enum on `update_page`, `update_page_section`,
`revert_page`, `delete_page`, `create_page`:

```
source: "user_request" | "file_or_cli_input" | "chained_tool_output"
```

`chained_tool_output` paired with any destructive flag is rejected
unconditionally (`DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT`). Omitted
`source` is inferred as `user_request` and logged as
`inferred_user_request`. Strict mode via
`EPIMETHIAN_REQUIRE_SOURCE=true` makes omission a hard error.

### Elicitation (HITL) on gated operations (Track E4)

`delete_page`, `revert_page`, and `update_page` with any destructive
flag request user confirmation via MCP elicitation (2025-06-18
spec). Unsupported clients default to **refuse**
(`ELICITATION_UNSUPPORTED`). Opt-out via
`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`.

### Write budget — `WRITE_BUDGET_EXCEEDED` (Track F4)

In-process sliding-window counter:

- Session total: 100 writes per process lifetime (default).
- Hourly window: 25 writes per rolling hour (default).

Exceeding either cap rejects the write before the HTTP call. Raise
via `EPIMETHIAN_WRITE_BUDGET_SESSION=<n>` /
`EPIMETHIAN_WRITE_BUDGET_HOURLY=<n>`; set either to `0` to disable
that scope.

### Per-tool + per-space profile allowlists (Tracks F2, F3)

Profile registry (`~/.config/epimethian-mcp/profiles.json`) now
accepts:

```jsonc
{
  "settings": {
    "acme-triage": {
      "allowed_tools": ["get_page", "search_pages", "create_comment"],
      "spaces": ["TRIAGE"]
    }
  }
}
```

`allowed_tools` / `denied_tools` (mutually exclusive) gate
registration at startup. `spaces` gates every write-path handler —
`space_key` inputs are matched directly; `page_id` inputs resolve
the page's space via a cached metadata fetch (5-min TTL). Unknown
tool names abort startup with `InvalidToolAllowlistError`. Out-of-
allowlist writes throw `SpaceNotAllowedError`.
