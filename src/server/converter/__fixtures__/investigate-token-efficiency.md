# Investigation: Token Efficiency

**STATUS: ✅ ADDRESSED** (via `headings_only`, `section`, `max_length` parameters)

## Problem

Confluence pages can be very large — architecture docs, runbooks, decision logs — and
returning the full body on every `get_page` call wastes LLM context tokens and slows
response time.

## Strategies

### 1. Headings-only mode

```
get_page(page_id, headings_only=true)
```

Returns only the page's heading outline. Typical response: 200–500 tokens instead of
5,000–50,000. Use this to preview structure before reading the full body.

### 2. Section extraction

```
get_page(page_id, section="Architecture Overview")
```

Returns only the content under a specific heading. Ideal for targeted edits.

### 3. Length cap

```
get_page(page_id, max_length=4000)
```

Truncates the body at approximately `max_length` characters. A trailing note indicates
truncation occurred.

## Token Budgets (rough estimates)

| Content type | Approximate tokens per KB |
|--------------|--------------------------|
| Storage XML | 600–800 tokens/KB |
| Markdown view | 300–400 tokens/KB |
| Headings only | 50–100 tokens/page |

## Benchmarks

A typical Entrix architecture page (10 KB storage XML):

- Full body: ~7,000 tokens
- Headings only: ~80 tokens
- Section (one heading): ~500 tokens

> [!TIP]
> Always use `headings_only=true` on first access to map a large page. Then fetch
> only the section you need to edit. This is the most token-efficient workflow.

## Caveats

- `section` matching is **case-insensitive** but requires an exact heading string.
- Truncation via `max_length` may cut mid-paragraph; use with caution for edits.
- `headings_only` does not return body content — do not use for editing.

## Related

See also: `update_page_section` for the write-path equivalent of section-targeted access.
