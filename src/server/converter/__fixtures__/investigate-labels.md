# Investigation: Labels

**STATUS: ✅ IMPLEMENTED** (v4.3.0 — `get_labels`, `add_label`, `remove_label`)

## Problem

Confluence labels are a lightweight tagging system used for filtering, tracking, and
organizing pages. AI agents need to read and modify labels to support automated
classification workflows.

## API Capabilities

Labels use the **v1 API** (`/wiki/rest/api/content/{id}/label`).

### Read Labels

```
GET /wiki/rest/api/content/{pageId}/label
```

Response: `{ results: [{ name, prefix, id }], ... }`

### Add Labels

```
POST /wiki/rest/api/content/{pageId}/label
Body: [{ prefix: "global", name: "my-label" }]
```

- Can add multiple labels in a single call (array)
- Label names are normalized to lowercase

### Remove Labels

```
DELETE /wiki/rest/api/content/{pageId}/label/{labelName}
```

One label per call.

## Label Formats

| Format | Example | Notes |
|--------|---------|-------|
| Global | `architecture` | Most common |
| Personal | `~username:private` | User-scoped |
| Team | `team:backend` | Team-scoped |

## Design Decisions

> [!TIP]
> Prefer global labels for AI-generated tags. Personal/team labels require the
> agent to know the authenticated user's ID.

The `add_label` tool accepts an array of label names and adds all of them in a
single API call to minimize latency.

## Edge Cases

- Labels are **case-insensitive** — `Architecture` and `architecture` are the same label
- Label names cannot contain spaces (use hyphens)
- Maximum label length: 255 characters
- Duplicate labels are silently ignored by the API
