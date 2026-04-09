# Investigation: Labels (Get + Add + Remove)

## Problem

Labels are heavily used in Confluence for organizing content, driving macros (e.g., content-by-label), and filtering searches. The official Rovo MCP server has zero label tools. sooperset has get/add but no remove. Epimethian already uses labels internally for the `epimethian-managed` attribution stamp but doesn't expose label management to users.

## API Endpoints

### V1 Endpoints (`/wiki/rest/api`) — recommended for full CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/content/{id}/label` | Get labels on content |
| POST | `/content/{id}/label` | Add labels (accepts array) |
| DELETE | `/content/{id}/label?name={name}` | Remove a label (query param variant) |
| DELETE | `/content/{id}/label/{label}` | Remove a label (path param variant) |

### V2 Endpoints (`/wiki/api/v2`) — GET and POST only

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages/{id}/labels` | Get labels with cursor pagination |
| POST | `/pages/{id}/labels` | Add labels |
| GET | `/labels/{id}/pages` | Get pages by label ID |

V2 does not yet have a DELETE endpoint for labels (CONFCLOUD-76866 open). Use v1 for DELETE.

### Label Object Schema

```typescript
interface Label {
  id: string;        // numeric string
  prefix: "global" | "my" | "team" | "system";
  name: string;      // lowercase, no spaces
}
```

Prefix meanings:
- **global** — visible to all users (standard user-facing labels)
- **my** — personal/favorite labels (per-user)
- **team** — team-level labels
- **system** — internal system labels (don't touch)

### CQL Search by Label

Already supported via existing `search_pages` tool — no new API code needed:
```
label = "architecture"
label IN ("draft", "review")
space = "DEV" AND label = "approved"
```

### Constraints

| Constraint | Detail |
|---|---|
| Max label name length | 255 characters |
| Character restrictions | Auto-lowercased. Spaces converted to hyphens. Alphanumeric, hyphens, underscores only. |
| Archived content | Labels cannot be added/removed on archived pages |
| Permissions | Edit permission required for add/remove. View for get. |
| Prefix for user labels | Always use `"global"` |

## Existing Code to Reuse

**File:** `src/server/confluence-client.ts`

The server already has a working `addLabel` function (line 572-578):

```typescript
async function addLabel(pageId: string, label: string): Promise<void> {
  const cfg = await getConfig();
  await confluenceRequest(`${cfg.apiV1}/content/${pageId}/label`, {
    method: "POST",
    body: JSON.stringify([{ prefix: "global", name: label }]),
  });
}
```

This function:
- Uses v1 API (correct choice — v1 has complete CRUD)
- Is currently private (not exported)
- Is called from `createPage()` and `updatePage()` for `epimethian-managed` attribution
- Errors are swallowed (label addition is non-critical for attribution)

The `confluenceRequest` helper, `getConfig()`, error handling patterns, and `toolResult`/`toolError` helpers are all directly reusable.

## Competitive Landscape

| Operation | sooperset | Rovo (official) | epimethian (current) |
|---|---|---|---|
| Get labels | Yes | No | Internal only |
| Add label | Yes (single) | No | Internal only |
| Remove label | No | No | No |
| Search by label | Via CQL | Via CQL | Via CQL |

## Proposed Tools

### `get_labels`

```
Inputs:
  page_id: string (required)

Output: list of labels with name and prefix
```

Read-only. Use `GET {apiV1}/content/{pageId}/label`.

### `add_label`

```
Inputs:
  page_id: string (required)
  labels: string[] (required, 1-20 labels)

Output: confirmation with list of added labels + tenant echo
```

Write operation. The v1 POST body accepts an array, so multiple labels go in a single request. Must respect write locks.

Implementation: extend the existing `addLabel` function to accept an array, export it, and add proper error handling (don't swallow errors for user-facing calls).

### `remove_label`

```
Inputs:
  page_id: string (required)
  label: string (required)

Output: confirmation + tenant echo
```

Write operation. Use `DELETE {apiV1}/content/{pageId}/label?name={labelName}` (query param variant — safe with `/` characters).

## Implementation Notes

- Use v1 API for all label operations. V1 has complete CRUD. Mixing v1/v2 for one feature adds unnecessary complexity.
- The existing `addLabel` is nearly production-ready — just needs to be exported, accept arrays, and have proper error handling.
- Add a Zod schema for label responses.
- Document that `search_pages` already supports label-based CQL queries — no new search tool needed.
- The `epimethian-managed` label is added automatically on create/update. The user-facing `get_labels` tool should show it (transparency), but document its purpose.

## Effort Estimate

This is the lowest-effort feature in the gap list. The internal `addLabel` function already works. Adding three tools (get, add, remove) requires:
- ~50 lines of new client functions (getLabels, removeLabel)
- ~80 lines of tool registration in index.ts
- Zod schema for label response
- Tests

## Open Questions

1. Should `add_label` prevent adding the `epimethian-managed` label manually (it's system-managed)?
2. Should `remove_label` warn when removing `epimethian-managed`?
3. Should there be a `bulk_add_label` tool that accepts multiple page IDs? (See bulk operations investigation.)
