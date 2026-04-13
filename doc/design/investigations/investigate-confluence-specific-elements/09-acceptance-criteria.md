# Acceptance criteria for the implementation

[← Back to index](README.md)

## Data preservation (mandatory)

- **No-loss invariant**: for any existing page P with storage S, `update_page(P, get_page(P, format=markdown).markdown)` produces a page whose storage is byte-identical to S (accounting only for the Confluence-side version-bump metadata).
- Every `<ac:>`/`<ri:>` element in S that is preserved by the caller (token present in their submitted markdown) is restored byte-for-byte from the sidecar — never re-derived.
- Every `<ac:>`/`<ri:>` element in S that is *not* preserved by the caller (token absent) is logged in the version message as an explicit deletion.
- Default behaviour: any deletion of a preserved element triggers an error unless `confirm_deletions: true` is set.
- Token IDs cannot be invented by the caller; unknown tokens in submitted markdown → error.
- Round-trip property test: 1000+ randomised real-page samples; assert byte-identical preservation.
- Token reordering (moving a preserved macro to a different position) is supported and lossless.

## Functional

- `create_page` and `update_page` accept GFM markdown and produce visually-correct pages with all standard elements (headings, lists, tables, links, code with syntax highlighting, blockquotes, images, task lists).
- All five named panels (`info`, `note`, `warning`, `tip`, `success`) are emitted as `<ac:structured-macro>` from `> [!TYPE]` syntax.
- Generic panels, expand, layout/columns, ToC, status, mention, date, page link, anchor, emoticon, Jira issue work via the documented directive/container syntax.
- Allowlisted raw `<ac:...>`/`<ri:...>` blocks pass through unchanged; non-allowlisted raw macro blocks → error pointing at supported syntax.
- Pasted Confluence URLs in markdown links are auto-rewritten to `<ac:link>`.

## Security

All items from [06-security.md](06-security.md) covered:

- CDATA injection regression test passes (literal `]]>` inside code blocks).
- Attribute injection regression test passes (`<`, `&`, `"`, `'`, newlines inside panel/expand/status/mention titles and labels).
- Raw HTML in markdown is disabled by default (`html: false`); enabling it requires explicit `allow_raw_html: true` and is logged.
- Confluence base URL parsing uses host equality after canonicalisation; regression test for spoofing variants (`atlassian.net.attacker.com`, port-suffix tricks, percent-encoding, `userinfo@host`).
- Account-ID format is validated against the documented Atlassian format before emission into `ri:account-id`.
- Filenames containing `../` are rejected.
- Macro allowlist for raw passthrough is a source-file constant, not runtime config.
- Input size cap (1 MB markdown) and `maxNesting` limit enforced.
- Token IDs scoped per `(page_id, version)`; forged tokens → error.
- Error messages refer to tokens by ID only, never by content.

## Performance

- 100 KB markdown body converts in <50 ms (p95) on a current MacBook (M-series).
- Tokenise + diff + restore for a 100 KB storage body completes in <100 ms (p95).
- Pathological input (deep nesting, many tokens) within 1 MB cap completes in <500 ms (p95) or rejects cleanly with a size/nesting error.

## Backward compatibility

- Existing callers passing raw storage format directly continue to work unchanged.
- Existing pages produced by the old `toStorageFormat()` are not affected (no migration needed; new writes go through the new path).
- The `add_drawio_diagram` tool continues to function; pages containing drawio macros round-trip losslessly via tokens.
- `update_page_section`, `set_page_status`, `add_label`, and other write tools that compose with `create_page`/`update_page` continue to function; regression test for each.
- `writeGuard`/read-only mode rejects markdown writes the same way it rejects storage writes.
- Attribution footer (`stripAttributionFooter`/`buildAttributionFooter`) interacts cleanly with the new converter; regression test.

## Documentation and tests

- `doc/markdown-cheatsheet.md` exists with copy-paste examples for every supported element.
- `doc/data-preservation.md` documents the tokenisation contract for tool callers (including the `confirm_deletions` flag and the `replace_body` opt-out).
- Unit tests cover one representative input per element with golden-file output assertions.
- Round-trip property tests as above (1000+ samples).
- Fuzz tests against malformed markdown inputs (deep nesting, unbalanced fences, invalid UTF-8, control characters).
- Real-world page samples from `entrix-network`'s `generate_confluence_page` output and from existing `epimethian-mcp/doc/design/investigations/*.md` files used as round-trip fixtures.
- CHANGELOG entry flags this as a behaviour change for callers that relied on the old `<p>`-wrap output (SemVer **major** at minimum, given the change in interpretation of the `body` parameter).
- Tool description for `update_page` updated to recommend `update_page_section` for targeted edits as the safest path.
