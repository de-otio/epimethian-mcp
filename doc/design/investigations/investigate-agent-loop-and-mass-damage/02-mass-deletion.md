# 2. Mass deletion (`delete_page`)

[← back to index](README.md)

`src/server/index.ts:700-728` and
`src/server/confluence-client.ts:756-759`:

```ts
export async function deletePage(pageId: string): Promise<void> {
  await v2Delete(`/pages/${pageId}`);
  pageCache.delete(pageId);
}
```

- One HTTP DELETE to `/wiki/api/v2/pages/{id}`, no payload, no
  confirmation, no pre-flight check for child count or outgoing links.
- The pattern
  `list_pages(space_key=X) → for p: delete_page(p.id)` walks a whole
  space in two-tool-call shape with zero friction.
- The mutation log (if enabled) captures the delete; recovery relies on
  Confluence's trash, whose retention is a tenant-level setting and
  whose bulk-restore UX is poor (pages are restored one at a time).

## Noteworthy sub-findings

- **Descendants are not surfaced.** Confluence's v2 delete trashes the
  page; whether descendants are also trashed or orphaned depends on
  whether `status=trashed` is used or hard-deletion occurs. The tool
  description does not surface this to the agent, and the server does
  not fetch `get_page_children` before deletion. An agent asked to
  "delete this obsolete index page" can trash the root of a whole
  documentation tree with one call.
- **No version-style optimistic lock.** `update_page` requires a
  `version` parameter; `delete_page` does not. Re-running an agent with
  a stale context can delete pages that were subsequently edited by a
  human.
- **`destructiveHint: true, idempotentHint: true`** is the only
  MCP-level signal. Claude Code and similar clients surface that to
  users, but the agent can still call it autonomously in an
  auto-approve mode.

## Possible mitigations

- **Require `version` on `delete_page`** (like `update_page`): "I last
  saw this page at version N; delete only if it is still at N." Blocks
  the stale-replay case.
- **Child-count preview**: call `get_page_children` internally before
  deletion; reject if > 0 without `confirm_has_descendants: true`.
- **Session delete budget**: a hard cap (e.g. 3) on deletes per session
  unless the user flips a high-watermark env var.
- **Trash instead of hard-delete**: verify the v2 endpoint's
  `status=trashed` behaviour; expose a separate `permanent_delete` path
  if needed.
