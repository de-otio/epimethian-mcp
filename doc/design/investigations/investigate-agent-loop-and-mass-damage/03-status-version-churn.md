# 3. Version churn via `set_page_status`

[← back to index](README.md)

`src/server/index.ts:1510-1540`:

The tool description itself warns:

> WARNING: Each call creates a new page version even if the status is
> unchanged — do not call repeatedly.

The warning is behavioural. The handler does **not**:
- Compare the requested `name`/`color` to the current status before
  writing.
- Dedupe same-input calls within a session.

## Attack / accident shape

An agent in a retry loop (or a misbehaving "mark this reviewed" task)
can write 1 000 no-op status updates, each producing a new Confluence
version. Original page content is unharmed, but:
- Version history balloons (Confluence retains all versions indefinitely
  by default on Cloud).
- Any per-version billing, storage, or audit downstream is polluted.
- The "show me what changed on this page lately" view becomes useless.

## Possible mitigation

Cheap fix: `set_page_status` handler calls `getContentState(pageId)`
first; if `(name, color)` match, return success without writing. The
GET costs a network round-trip but the dedup is worth it.
