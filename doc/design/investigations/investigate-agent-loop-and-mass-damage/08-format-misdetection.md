# 8. Format misdetection in `looksLikeMarkdown`

[← back to index](README.md)

`src/server/confluence-client.ts:1642-1678`:

The detector:
1. Strips fenced code blocks.
2. If any `<ac:…>` or `<ri:…>` tag remains → **storage format**.
3. Else, if any strong markdown signal fires (ATX heading, table
   separator, fenced code, `[text](url)`, `**bold**`, etc.) →
   **markdown**.
4. Else, if the body starts with `<…>` → storage; otherwise → markdown.

## Risk surface

Step 3 includes the inline patterns `/\*\*[^*]+\*\*/` and
`/\[[^\]]+\]\([^)]+\)/`. These are **very** forgiving. A body of pure
Confluence storage like:

```html
<p>See the <a href="https://example.com/foo">example</a> for details.</p>
<p>This section is <strong>critical</strong> — please review carefully.</p>
```

contains no `<ac:>` or `<ri:>` tags, no line-anchored markdown
structure, but *does* match `[example](https://example.com/foo)` as a
"markdown link" pattern. Detector verdict: `markdown`. The
mixed-input guard (`detectMixedInput` in `safe-write.ts`) only fires
when both `<ac:>` tags **and** line-anchored structural markdown are
present; plain-HTML + inline-link pattern slips through.

Result: the storage body is fed into `markdownToStorage`, which:
- Re-interprets `<a href=…>example</a>` as already-storage, but the
  surrounding paragraph structure may be lost.
- Strips whatever markdown-it decides isn't valid GFM.

This is a real corruption vector, though it requires a caller that
submits plain XHTML (no `<ac:>`) as the `body` to `update_page`. It is
more likely to hit the token-aware path (currentBody has tokens) where
`planUpdate` runs, but `planUpdate`'s behaviour on "markdown" that is
actually storage is not characterised in the investigation write-ups I
reviewed.

## Repro target for verification

Write a test that:
1. Constructs a storage body with no `<ac:*>` tags but with `<a href>`
   or `<strong>` containing `[…](…)` or `**…**` text.
2. Calls `update_page`.
3. Asserts that either (a) the body round-trips byte-for-byte, or
   (b) the mixed-input guard fires with a clear error.

Adding the inline patterns to the mixed-input detector would catch
this (they were explicitly excluded — see the comment at
`safe-write.ts:398-401` — because "too easy to occur incidentally
inside HTML attribute values"; the opposite direction of the same
tradeoff applies here).

## Possible mitigation

Three non-exclusive options:

1. **Tighten `looksLikeMarkdown`**: require *line-anchored* markdown
   signals for the markdown verdict; drop `**bold**` and `[text](url)`
   from the strong-signal list. Follow the strictness already applied
   in `detectMixedInput`.
2. **Symmetric mixed-input rejection**: if the body passes
   `looksLikeMarkdown` **and** contains any `<a`, `<strong>`, `<em>`,
   `<h1>`–`<h6>`, `<p>`, `<table>` tags at top level, reject as mixed.
3. **Explicit `body_format` parameter**: add an optional
   `body_format: "auto" | "markdown" | "storage"` (default `"auto"`)
   so callers can disambiguate. `auto` keeps the existing heuristic.

Option 1 alone is probably enough and is a drop-in change.
