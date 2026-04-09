# Investigation: Bulk Operations

## Problem

Consultants frequently need to reorganize Confluence content — moving pages between spaces, applying labels to sets of pages, copying template hierarchies for new clients, or archiving old content. Currently every operation is single-page, requiring the LLM to loop with individual tool calls. This is slow, token-expensive, and error-prone.

No existing MCP server (official Rovo, sooperset, aashari, or others) offers any bulk or reorganization tools.

## Confluence API Capabilities

### Move Page

**Endpoint:** `PUT /wiki/rest/api/content/{pageId}/move/{position}/{targetId}` (v1 only)

- **Synchronous** — returns immediately
- **Descendants move automatically** with the parent
- **Position values:**
  - `append` — make page a child of targetId
  - `before` / `after` — place as sibling of targetId in specified order
- **Cross-space moves supported** — set targetId to destination space's home page ID, use `append`
- **No bulk endpoint** — each page requires a separate API call
- **Gotcha:** Never use `before`/`after` when targetId is a top-level page (creates orphaned pages invisible in the page tree)

### Copy Page (Single)

**Endpoint:** `POST /wiki/rest/api/content/{id}/copy` (v1)

- **Synchronous** — returns the new page
- **Options:** `copyAttachments`, `copyPermissions`, `copyProperties`, `copyLabels`, `copyCustomContents`
- **Can override:** destination space, page title, body content

### Copy Page Hierarchy (with Descendants)

**Endpoint:** `POST /wiki/rest/api/content/{id}/pagehierarchy/copy` (v1)

- **Asynchronous** — returns a `LongTask` ID
- **Poll status:** `GET /wiki/rest/api/longtask/{taskId}` (returns `percentageComplete`, `status`, `errors`)
- **Options:** same as single copy plus `copyDescendants: true` and `titleOptions` (prefix, search/replace)
- **Known bug (CONFCLOUD-67045):** When `copyProperties: true` and a page has an invalid property, retry mechanism fires repeatedly creating duplicate copies. Workaround: set `copyProperties: false` or cap polling timeout.
- **Sends notifications** for every copied page — no way to suppress via API

### Bulk Label Operations

**No multi-page label endpoint exists.** Must call per-page.

- **Add labels:** `POST /wiki/rest/api/content/{id}/label` (v1) — accepts an array of label objects, so multiple labels can be added to one page in a single call
- **Remove label:** `DELETE /wiki/rest/api/content/{id}/label?name={name}` (v1)
- **Get labels:** `GET /wiki/rest/api/content/{id}/label` (v1)
- **v2 API:** Only GET is available. Write operations requested in CONFCLOUD-76866 (open)

### Bulk Archive

**Endpoint:** `POST /wiki/rest/api/content/archive` (v1)

- **Asynchronous** — accepts an array of page IDs, returns a `LongTask` ID
- **Reversible** (unlike delete)
- **Pages must not already be archived**

### Bulk Delete

**No batch delete endpoint.** Must call per-page: `DELETE /wiki/api/v2/pages/{id}`

### Page Reordering

- No dedicated "set position" or "reorder children" endpoint
- Must use the move endpoint with `before`/`after` position — reordering N children requires N-1 move calls
- Feature request CONFCLOUD-40101 open since 2016

### Long-Running Task API

- `GET /wiki/rest/api/longtask/{taskId}` — poll for async operations
- Returns: `percentageComplete`, `status`, `errors`, `additionalDetails`
- Used by: copy hierarchy, bulk archive

## Rate Limiting Context

Confluence Cloud uses a points-based model:

| Plan | Quota |
|------|-------|
| Free | 65,000 pts/hour |
| Standard | 100,000 + 10 × users pts/hr |
| Premium | 130,000 + 20 × users pts/hr |
| Enterprise | 150,000 + 30 × users pts/hr |

Write operations cost **1 point flat**. Read operations cost 1 + (1 × objects returned). The practical bottleneck for bulk writes is network latency, not rate limits. Still, implement exponential backoff with jitter on 429 responses.

Response headers on 429: `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-NearLimit`.

## Proposed Tools

### Tier 1: Core reorganization (high value, moderate effort)

#### `move_page`
```
Inputs:
  page_id: string (required)
  target_id: string (required) — parent page ID or sibling page ID
  position: "append" | "before" | "after" (default: "append")
```
- Single-page move. Descendants follow automatically.
- Returns: confirmation with new parent info + tenant echo.
- Validates position/target combinations to prevent orphaning.

#### `copy_page`
```
Inputs:
  page_id: string (required)
  destination_space_key: string (optional — defaults to same space)
  destination_parent_id: string (optional — defaults to space root)
  new_title: string (optional)
  copy_attachments: boolean (default: true)
  copy_labels: boolean (default: true)
```
- Single-page copy (synchronous).
- Returns: new page ID, title, URL + tenant echo.

#### `copy_page_tree`
```
Inputs:
  page_id: string (required)
  destination_parent_id: string (required)
  title_prefix: string (optional)
  title_search: string (optional)
  title_replace: string (optional)
  copy_attachments: boolean (default: true)
  copy_labels: boolean (default: true)
```
- Async operation. Returns task ID immediately.
- Sets `copyProperties: false` by default to avoid the duplicate-copy bug.
- Follow-up: LLM can poll with a `get_task_status` tool.

#### `get_task_status`
```
Inputs:
  task_id: string (required)
```
- Polls long-running task status.
- Returns: percentage complete, status, any errors.
- Reusable for any async operation (copy hierarchy, bulk archive).

### Tier 2: Batch convenience (medium value, low effort)

#### `bulk_add_label`
```
Inputs:
  page_ids: string[] (required, max 50)
  labels: string[] (required, max 10)
```
- Iterates internally with concurrency control (5 parallel requests).
- Returns: per-page success/failure summary + tenant echo.
- Implements retry with backoff on 429.

#### `bulk_archive`
```
Inputs:
  page_ids: string[] (required, max 100)
```
- Uses the native async bulk archive endpoint.
- Returns: task ID for polling.
- Safer alternative to bulk delete (reversible).

### Tier 3: Deferred (low priority or risky)

- **`bulk_delete`** — Destructive + no native bulk endpoint. Require explicit confirmation pattern. Defer until there's clear demand.
- **`reorder_children`** — Requires N-1 move calls for N children. Fragile. Defer until Atlassian adds a native endpoint.

## Safety Considerations

1. **All bulk write tools must include tenant echo** in every response line.
2. **Per-tenant write locks** (see separate investigation) should gate all bulk tools.
3. **`copy_page_tree`** and **`bulk_archive`** are async — the LLM must understand it needs to poll. Tool descriptions should explicitly state this.
4. **`move_page`** with `before`/`after` on top-level pages should warn or error to prevent orphaning.
5. **Concurrency limits** on batch tools prevent overwhelming the API. Default to 5 parallel requests.
6. **Max array sizes** prevent unbounded operations (50 pages for label, 100 for archive).

## Implementation Notes

- Move and copy endpoints are v1 only — add v1 request helpers if not already available. (The client already has `v1Get` and `v1Post` — need to add `v1Put` for move.)
- Long task polling should have a configurable timeout (default 5 minutes) with exponential backoff.
- `copy_page_tree` should document the notification spam issue in tool description so users are aware.

## Open Questions

1. Should `move_page` support a `dry_run` mode that shows what would happen without executing?
2. Should `bulk_add_label` also support `bulk_remove_label`, or is that a separate tool?
3. What's the right max batch size? 50 pages keeps the operation bounded but may be too small for large reorganizations.
4. Should we expose `bulk_archive` given that unarchiving is only available through the UI (no API)?
