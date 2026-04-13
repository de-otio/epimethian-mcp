# Investigation: Comments (Inline + Footer)

**STATUS: ✅ IMPLEMENTED** (v4.4.0)

## Problem

AI agents need to participate in Confluence collaboration workflows — reading comments,
leaving feedback, resolving discussions. Without comment support, agents can read and
write page bodies but cannot interact with the discussion layer.

## Comment Types

**Footer comments** — standard comment thread at the bottom of a page. Flat or threaded,
not tied to specific text.

**Inline comments** — anchored to a specific text selection. Support resolution workflow
with states: `open`, `reopened`, `resolved`, `dangling`.

## API Endpoints

Base path: `/wiki/api/v2`

### Footer Comments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages/{id}/footer-comments` | List footer comments |
| POST | `/footer-comments` | Create a footer comment |
| DELETE | `/footer-comments/{id}` | Delete a comment |

### Inline Comments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages/{id}/inline-comments` | List inline comments |
| POST | `/inline-comments` | Create an inline comment |
| PUT | `/inline-comments/{id}` | Resolve/reopen |

## Implementation Notes

1. Use v2 API for all comment operations.
2. Footer and inline comments have separate endpoints.
3. The `resolutionStatus` field drives the resolve workflow.

> [!WARNING]
> Inline comments become "dangling" if the anchored text is deleted. Always handle
> the `dangling` state gracefully.

## Test Matrix

- [x] Create footer comment
- [x] Create inline comment
- [x] Resolve comment
- [x] Delete comment
- [ ] Reply threading
