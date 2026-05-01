# Investigation: Bulk Operations

**STATUS: ⏳ PENDING** (Not yet implemented)

## Problem

Consultants frequently need to reorganize Confluence content — moving pages between spaces,
applying labels to sets of pages, copying template hierarchies for new clients, or archiving
old content. Currently every operation is single-page, requiring the LLM to loop with
individual tool calls. This is slow, token-expensive, and error-prone.

## Confluence API Capabilities

### Move Page

**Endpoint:** `PUT /wiki/rest/api/content/{pageId}/move/{position}/{targetId}` (v1 only)

- **Synchronous** — returns immediately
- **Descendants move automatically** with the parent
- **Position values:**
  - `append` — make page a child of targetId
  - `before` / `after` — place as sibling of targetId in specified order
- **Cross-space moves supported**

### Copy Page (Single)

**Endpoint:** `POST /wiki/rest/api/content/{id}/copy` (v1)

- **Synchronous** — returns the new page
- **Options:** `copyAttachments`, `copyPermissions`, `copyProperties`, `copyLabels`

## Recommendations

| Operation | Approach | Notes |
|-----------|----------|-------|
| Move single page | `move` endpoint | synchronous |
| Copy hierarchy | `pagehierarchy/copy` | async, poll |
| Bulk label | loop with `add_label` | no bulk API |

## Code Example

```typescript
async function movePage(pageId: string, targetId: string): Promise<void> {
  await confluenceRequest(
    `/wiki/rest/api/content/${pageId}/move/append/${targetId}`,
    { method: "PUT" }
  );
}
```

## Decision

> [!NOTE]
> This feature is deprioritized until the core page read/write tools are stable.

Out of scope for v1.
