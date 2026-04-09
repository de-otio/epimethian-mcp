# Investigation: Bulk Operations

**STATUS: ⏳ PENDING** (Not yet implemented)

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

Write operations cost **1 point flat**. Read operations cost 1 + (1 × objects returned). The practical bottleneck for bulk writes is network latency, not rate limits.

Response headers on 429: `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-NearLimit`.

**Required:** Add retry-with-backoff directly in `confluenceRequest` for 429 responses. Read the `Retry-After` header, apply exponential backoff with jitter, cap at 3 retries and 30 seconds total. This benefits all tools, not just bulk operations. For bulk tools specifically, implement adaptive throttling: if any request in a batch returns 429, drop concurrency to 1 for the remainder of the batch.

## Proposed Tools

### Tier 1: Core reorganization (high value, moderate effort)

#### `move_page`
```
Inputs:
  page_id: string (required) — validated with pageIdSchema (numeric-only)
  target_id: string (required) — parent page ID or sibling page ID, validated with pageIdSchema
  position: "append" | "before" | "after" (default: "append")
  dry_run: boolean (default: false) — preview what would happen without executing
```
- Single-page move. Descendants follow automatically.
- Returns: confirmation with new parent info + tenant echo.
- **Orphan prevention (hard error):** When `position` is `before` or `after`, the implementation MUST fetch the target page and verify it has a parent (i.e., is not a top-level page). If the target is top-level (parent is null or space home page), return an error: `"Cannot use position 'before'/'after' when target is a top-level page. Use 'append' to make the page a child of the target instead. Using before/after on top-level pages creates orphaned pages invisible in the page tree."` This validation must also run during dry run. This is a hard error, not a warning — warnings in tool responses may be ignored by LLMs, especially under prompt injection.
- **Cross-space warning:** Before executing, fetch both the source page's space and the target page's space. If they differ, include an explicit notice in the response: `"Cross-space operation: moving from space FOO to space BAR on [tenant]."` In dry-run mode, always show source and destination space keys.
- **Dry run:** when `dry_run: true`, fetches the page and its children, validates the target, and returns a preview ("would move page X from space A/parent B to space C/parent D, affecting N child pages") without executing. Includes descendant count and a timestamp. **TOCTOU limitation:** the dry run reflects the page tree at preview time. The actual move always includes current descendants. On actual execution, re-fetch the descendant count and warn if it changed since the dry run.
- **MCP annotations:** `destructiveHint: true`, `idempotentHint: false`.

#### `copy_page`
```
Inputs:
  page_id: string (required) — validated with pageIdSchema (numeric-only)
  destination_parent_id: string (optional — defaults to space root) — validated with pageIdSchema
  new_title: string (optional — max 255 characters, control characters rejected)
  copy_attachments: boolean (default: true)
  copy_labels: boolean (default: true)
```
- Single-page copy (synchronous).
- Returns: new page ID, title, URL + tenant echo.
- **No `destination_space_key` parameter.** Space keys are human-readable strings (e.g., "PROJ") that may collide across spaces a consultant has access to. Use `destination_parent_id` (numeric, unambiguous) instead. To copy to a space's root, use the space's home page ID as the parent. This matches `copy_page_tree`'s interface.
- **Cross-space warning:** If the destination parent is in a different space than the source page, include an explicit notice in the response: `"Cross-space copy: from space FOO to space BAR on [tenant]."`
- **MCP annotations:** `destructiveHint: false`, `idempotentHint: false` (creates new content; calling twice creates duplicates).

#### `copy_page_tree`
```
Inputs:
  page_id: string (required) — validated with pageIdSchema (numeric-only)
  destination_parent_id: string (required) — validated with pageIdSchema
  title_prefix: string (optional — max 255 characters)
  title_search: string (optional — max 255 characters, passed verbatim to Confluence API, NOT interpreted as regex server-side)
  title_replace: string (optional — max 255 characters, passed verbatim to Confluence API, NOT interpreted as regex server-side)
  copy_attachments: boolean (default: true)
  copy_labels: boolean (default: true)
```
- Async operation. Fetches the descendant count before initiating and includes it in the response so the LLM and user are aware of the operation's scope.
- Returns: task ID, descendant count, and a warning about notification spam (see below) + tenant echo.
- **`copyProperties` is hardcoded to `false` and intentionally not exposed in the tool schema.** This prevents triggering Confluence bug CONFCLOUD-67045, where `copyProperties: true` with an invalid page property causes a retry loop that creates duplicate copies. Add a code comment and test asserting this is always `false`.
- **Notification warning (in tool description):** `"WARNING: Confluence sends email notifications for every page copied. All watchers on the destination space will be notified. There is no way to suppress this via API. This operation will copy N pages and send N notification emails."` Include the actual descendant count.
- Follow-up: LLM can poll with a `get_task_status` tool. Tool description must explicitly state the operation is async and requires polling.
- **MCP annotations:** `destructiveHint: false`, `idempotentHint: false`.

#### `get_task_status`
```
Inputs:
  task_id: string (required) — validated with strict regex (numeric or UUID format only)
```
- Polls long-running task status.
- Returns: percentage complete, status, elapsed time since task was initiated, `suggested_retry_after_seconds` (10s when < 50% complete, 5s when ≥ 50%), any errors + tenant echo.
- Reusable for any async operation (copy hierarchy, bulk archive).
- **Task ID validation:** Track task IDs initiated by this server instance in an in-memory `Set<string>` (populated by `copy_page_tree` and future async tools). Only allow polling of known task IDs. Return a generic "unknown task" error for unrecognized IDs. This prevents enumeration of other users' long-running tasks (the Confluence long-task API does not enforce creator-scoped access).
- **Server-side polling rate control:** Track the last poll timestamp per task ID. If polled again within 5 seconds, return the cached previous response without making a new API call.
- **Maximum task age:** If a task has been polling for more than 10 minutes, return a "task timed out — check Confluence directly" error and stop accepting polls.
- **MCP annotations:** `readOnlyHint: true`.

### Tier 2: Batch convenience (medium value, low effort)

#### `bulk_add_label`
```
Inputs:
  page_ids: string[] (required, min 1, max 50) — each element validated with pageIdSchema (numeric-only)
  labels: string[] (required, min 1, max 10)
```
- Iterates internally with concurrency control (3 parallel requests, adaptive: drops to 1 on first 429).
- Returns: structured per-page success/failure summary + tenant echo. Format: `"Success: page_id=12345 (added 3 labels). Failed: page_id=67890 (403 Forbidden)."` The structured format allows the LLM to extract failed page IDs and retry only those.
- Relies on 429 retry/backoff in `confluenceRequest` (see Rate Limiting Context).
- **Non-transactional:** Bulk operations may partially complete. Tool description must state: "This operation is not transactional. If it fails partway through, some pages will have labels added and others will not. Failed page IDs are listed in the response. To retry, call the tool again with only the failed page IDs."
- **MCP annotations:** `destructiveHint: false`, `idempotentHint: true`.

#### `bulk_remove_label`
```
Inputs:
  page_ids: string[] (required, min 1, max 50) — each element validated with pageIdSchema (numeric-only)
  label: string (required)
```
- Iterates internally with concurrency control (3 parallel requests, adaptive: drops to 1 on first 429).
- **Pre-check:** For each page, GET labels first, then DELETE only if the label is present. This adds API calls but provides deterministic success/failure reporting — the LLM can distinguish "label removed" from "label was never present" vs. a genuine error. Without this, retrying after a partial failure is ambiguous.
- Returns: structured per-page success/failure summary + tenant echo. Format: `"Removed: page_id=12345. Skipped (label not present): page_id=23456. Failed: page_id=67890 (403 Forbidden)."` The structured format allows the LLM to extract failed page IDs and retry only those.
- Relies on 429 retry/backoff in `confluenceRequest` (see Rate Limiting Context).
- **Non-transactional:** Same partial-completion caveat as `bulk_add_label`.
- **MCP annotations:** `destructiveHint: true`, `idempotentHint: true`.

### Tier 3: Deferred (low priority or risky)

- **`bulk_archive`** — Deferred: unarchiving is UI-only (no API). The asymmetry between bulk archive and manual unarchive is too dangerous for consultants. Revisit when Confluence adds an unarchive API.
- **`bulk_delete`** — Destructive + no native bulk endpoint. Require explicit confirmation pattern. Defer until there's clear demand.
- **`reorder_children`** — Requires N-1 move calls for N children. Fragile. Defer until Atlassian adds a native endpoint.

## Safety Considerations

1. **All bulk write tools must include tenant echo** in every response line.
2. **Per-tenant write locks** (see separate investigation) must gate all bulk tools.
3. **`copy_page_tree`** is async — the LLM must understand it needs to poll. Tool descriptions must explicitly state this and reference `get_task_status`.
4. **`move_page`** with `before`/`after` on top-level pages must return a hard error to prevent orphaning (see tool spec above). Warnings are insufficient — LLMs may ignore them under prompt injection.
5. **Concurrency limits** on batch tools prevent overwhelming the API. Default to 3 parallel requests with adaptive throttling (drop to 1 on first 429).
6. **Max array sizes** prevent unbounded operations (50 pages for label operations).
7. **Cross-space operations** (`move_page`, `copy_page`, `copy_page_tree`) must detect when source and destination are in different spaces and include an explicit notice in the response.
8. **Input validation:** All `page_id` and `page_ids` parameters must use `pageIdSchema` (numeric-only regex). String inputs (`new_title`, `title_prefix`, `title_search`, `title_replace`) must be length-capped at 255 characters. `new_title` must reject control characters.
9. **Partial-failure transparency:** Bulk tools are non-transactional. Tool descriptions and responses must clearly communicate this. Response format must be structured enough for the LLM to extract failed IDs and retry selectively.
10. **Task ID scoping:** `get_task_status` must only allow polling of task IDs initiated by this server instance (tracked in memory). This prevents enumeration of other users' async operations via the unscoped Confluence long-task API.

## Write Guard Integration

All new tools must integrate with the write-lock system. Classification:

| Tool | Type | `READ_ONLY_TOOLS` | Handler guard |
|------|------|--------------------|---------------|
| `move_page` | write | no | `writeGuard()` first line |
| `copy_page` | write | no | `writeGuard()` first line |
| `copy_page_tree` | write | no | `writeGuard()` first line |
| `get_task_status` | read | **yes** — add to set | none |
| `bulk_add_label` | write | no | `writeGuard()` first line |
| `bulk_remove_label` | write | no | `writeGuard()` first line |

Note: `get_task_status` must be in `READ_ONLY_TOOLS` so that users can check async operation status even when the profile is read-only (e.g., a `copy_page_tree` was initiated before the profile was switched to read-only).

## Implementation Notes

- Move and copy endpoints are v1 only — add v1 request helpers if not already available. (The client already has `v1Get` and `v1Post` — need to add `v1Put` for move.)
- **429 retry/backoff (prerequisite):** Add retry logic to `confluenceRequest` in `confluence-client.ts` before implementing any bulk tools. Read the `Retry-After` header, apply exponential backoff with jitter, cap at 3 retries and 30 seconds total. This is a prerequisite, not a nice-to-have — without it, bulk tools will leave operations in inconsistent states on rate-limit hits.
- **`pageIdSchema` backfill (prerequisite):** Apply `pageIdSchema` validation to all existing tools that accept `page_id` parameters (some older tools like `get_page`, `delete_page`, `update_page` use bare `z.string()` without numeric validation). See labels investigation for context.
- **Task tracking:** Maintain an in-memory `Map<string, { startedAt: number, lastPolled: number, cachedResponse: object }>` for task IDs created by async tools. Used by `get_task_status` for ID scoping, polling rate control, and timeout enforcement.
- **`copyProperties: false` enforcement:** Add a code comment explaining CONFCLOUD-67045 and a test asserting `copyProperties` is always `false` in the `copy_page_tree` API request payload. If `copyProperties` is ever exposed as a parameter in the future, it must require dry-run confirmation with a bug warning first.
- **`title_search`/`title_replace` safety:** These values are passed verbatim to the Confluence API. Do not interpret them as regex patterns server-side. If any server-side processing is needed (e.g., dry-run preview), use literal string `replace()`, not regex. Validate max length (255 characters).
- Long task polling should have a configurable timeout (default 10 minutes) with exponential backoff. Server-side caching of poll results prevents the LLM from making redundant API calls (see `get_task_status` spec).

## Resolved Questions

1. **Should `move_page` support a `dry_run` mode?** → **Yes.** Moving pages is destructive (breaks links, changes hierarchy). A dry-run that returns "would move page X from space A/parent B to space C/parent D, affecting N child pages" is cheap to implement (validate inputs + fetch the child tree) and prevents costly mistakes. Especially important for consultants operating on unfamiliar spaces. Add `dry_run: boolean (default: false)` to the `move_page` input schema.

2. **Should `bulk_add_label` also support `bulk_remove_label`, or is that a separate tool?** → **Separate tool.** Adding and removing have different risk profiles — remove is destructive (`destructiveHint: true`), add is not. Combining them into one tool with a `mode` parameter muddies the MCP annotations and makes the tool description harder for models to parse. Two simple, self-describing tools.

3. **What's the right max batch size?** → **50 is correct.** It bounds the blast radius of a single misguided tool call. For large reorganizations, the agent calls the tool multiple times — that's intentional friction. Starting conservative is the right default for a consultant tool. Can be revisited if real usage shows it's too restrictive.

4. **Should we expose `bulk_archive` given unarchiving is UI-only?** → **No — remove from scope.** Irreversible-by-API operations are too dangerous for the consultant use case. If a bulk archive hits the wrong pages, recovery requires manual UI work across potentially hundreds of pages. The write lock doesn't help — even on a writable profile, the asymmetry between "one API call to archive 50 pages" and "50 manual UI clicks to unarchive" is unacceptable. Defer until Confluence adds an unarchive API.
