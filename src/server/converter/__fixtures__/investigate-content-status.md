# Investigation: Content Status

**STATUS: ✅ IMPLEMENTED** (v4.5.0 — `get_page_status`, `set_page_status`, `remove_page_status`)

## Problem

Confluence Cloud supports **content status** — a badge that appears at the top of a page
indicating its lifecycle state (e.g. "Draft", "In Review", "Obsolete"). AI agents need to
read and update page status as part of automated workflows.

## API Details

### Get Status

```
GET /wiki/api/v2/pages/{id}
```

The `status` field in the response contains the current content status label.

### Set / Update Status

```
PUT /wiki/api/v2/pages/{id}
Body: { "status": "current", "title": "...", "version": { "number": N } }
```

Note: `status` values must be one of the defined labels for the space.

### Remove Status (reset to "current")

Set `status: "current"` in the PUT body.

## Status Lifecycle

```
Draft → In Review → Approved → Published
   ↓                              ↓
Obsolete ←───────────────────────
```

## Implementation Notes

1. Status is updated via the same PUT endpoint as title/body updates.
2. Custom status labels must be configured in the Confluence Space Settings first.
3. The v2 API is preferred for all status operations.

> [!INFO]
> The `current` status is the default state and has no visible badge in the UI.
> All other status values show as coloured badges.

## Test Cases

| Input | Expected |
|-------|----------|
| `set_page_status("Draft")` | Page shows "Draft" badge |
| `set_page_status("current")` | Badge removed |
| `remove_page_status()` | Equivalent to setting "current" |
| Invalid status name | API returns 400 |
