# Data Preservation Contract

**A page update must never unintentionally remove content from an existing page.**

This document describes the tokenisation mechanism that guarantees lossless round-trip updates via markdown. For the full design, see the investigation [01-data-preservation.md](doc/design/investigations/investigate-confluence-specific-elements/01-data-preservation.md).

## Headline guarantee

When you read a Confluence page via `get_page(format: markdown)`, edit the markdown, and write it back via `update_page`, every macro, embed, and element on the original page is preserved byte-for-byte—even those the converter doesn't know how to represent in markdown.

## How it works

### Reading a page

When you call `get_page(page_id, format: markdown)`, the response includes:

- **Markdown body** with opaque tokens embedded as HTML comments
- **Token reference table** at the top listing what each token represents
- **Sidecar** (structured field) containing the original storage XML for every token

Example response:

```markdown
Tokens: T0001 (info macro), T0042 (drawio diagram)

> [!INFO]
> You can edit this.

<!--epi:T0042-->

Another paragraph here.
```

The token `T0042` represents the original drawio diagram on the page. The sidecar maps:

```json
{
  "T0042": "<ac:structured-macro ac:name=\"drawio\">...</ac:structured-macro>"
}
```

### Updating a page

When you call `update_page(page_id, version, markdown_body, ...)`:

1. The converter fetches the current storage and tokenises it (same process as reading).
2. It compares the tokens in your edited markdown against the pre-edit canonical set.
3. **Tokens you kept** are restored byte-for-byte from the sidecar.
4. **Tokens you removed** are detected as deletions; the update errors unless you set `confirm_deletions: true`.
5. **Tokens you invented** (token IDs not in the sidecar) are rejected as errors.
6. Non-token markdown is converted to storage normally.
7. Everything is composed and submitted.

### Creating a page

When you call `create_page` with a markdown body, there is no prior content, so no tokens are involved. The converter simply renders your markdown to storage.

## Flags

### `confirm_deletions: boolean` (update_page only)

Default: `false`.

When you edit a page and remove tokens (by deleting or not including the token comments), the update is rejected unless you set `confirm_deletions: true`.

Example:

```
Update failed: Removed 1 preserved element:
- T0042 (drawio diagram)

To confirm, re-issue with confirm_deletions: true
```

When you set `confirm_deletions: true`, the removed tokens are logged in the page version message so anyone reviewing history can see what was dropped:

```
"Removed 1 preserved element: T0042 (drawio diagram)"
```

**Recommendation:** Always use `confirm_deletions: true` only when you genuinely want to delete a macro. If you want to keep it, include the token comment in your edited markdown.

### `replace_body: boolean` (create_page and update_page)

Default: `false`.

When `replace_body: true`, the token preservation logic is skipped entirely:

- `create_page`: markdown is converted normally (no difference).
- `update_page`: your markdown completely replaces the page body, and any existing macros are dropped without error.

This is a **loud opt-out**—use it only when you genuinely want a wholesale page rewrite.

When `replace_body: true` on `update_page`, no pre-fetch occurs; your markdown is the source of truth.

## Best practices

### For targeted edits (recommended)

Use `update_page_section` instead of `update_page` with full-body markdown. This is the **safest path**:

```
update_page_section(page_id, section: "Implementation Details", body: "...")
```

This edits only the content under that heading, leaving the rest of the page (and all its macros) untouched.

### For full-page updates via markdown

1. Call `get_page(page_id, format: markdown)`.
2. Copy and keep all token comments (`<!--epi:T####-->`) in place, even if you don't understand them.
3. Edit the non-token content freely.
4. Call `update_page(page_id, version, edited_markdown)` without `confirm_deletions: true` unless you deliberately removed tokens.

### For wholesome rewrites

If you want to start from scratch:

```
update_page(page_id, version, new_markdown, replace_body: true)
```

This is explicit and loud; no preservation logic runs.

## Worked example

Start with a page containing an info panel and a drawio diagram:

```markdown
Tokens: T0001 (info macro), T0042 (drawio diagram)

> [!INFO]
> Warning: this is a prototype.

<!--epi:T0042-->
```

You want to add a paragraph before the info panel. Edit to:

```markdown
Tokens: T0001 (info macro), T0042 (drawio diagram)

This is a new introductory paragraph.

> [!INFO]
> Warning: this is a prototype.

<!--epi:T0042-->
```

Call:

```
update_page(page_id, version, edited_markdown)
```

Result:

- The new paragraph is converted to storage.
- Tokens `T0001` and `T0042` are restored to their original XML byte-for-byte.
- The page is updated; all original macros are preserved.

If you had instead removed the `<!--epi:T0042-->` token and did not set `confirm_deletions: true`, the call would error with a list of what would be deleted, requiring explicit confirmation.

## Known limitations

### Confluence editor rewrites

When a human opens a page in the Confluence editor and saves it, Confluence may rewrite the storage XML (whitespace, attribute order, `ac:macro-id` UUIDs). A subsequent epimethian round-trip will treat the rewritten form as the new canonical. Tokens generated before the human edit will not match the rewritten storage, but this is **not lossy**—the page is preserved; only the XML representation changes.

**Mitigation:** Always re-fetch the page before editing if another user may have modified it.

### Token sidecars in very large pages

Pages with 500+ macros may incur memory overhead. For large pages, prefer `update_page_section` (which operates on a single section and avoids fetching the entire page).

### Tokens inside table cells

HTML comments inside GitHub Flavored Markdown table cells are tested and supported. If a particular markdown renderer fails to round-trip them, the token form may be adjusted (see implementation notes in the codebase).

## See also

- [markdown-cheatsheet.md](markdown-cheatsheet.md) — every supported markdown construct
- [investigation/01-data-preservation.md](doc/design/investigations/investigate-confluence-specific-elements/01-data-preservation.md) — full design details
