# 5. Comment pollution

[← back to index](README.md)

`src/server/index.ts:1623-1768`:

- `create_comment` prepends an "AI-generated" prefix to every comment
  body (good — makes them identifiable at a glance).
- `sanitizeCommentBody` (`confluence-client.ts:1308-1316`) strips
  `<ac:structured-macro>`, `<script>`, `<iframe>`, `<embed>`, `<object>`.
- No per-page, per-session, or per-thread comment-count budget.
- `delete_comment` is irreversible and not version-gated.

## Attack / accident shape

An agent writing a "review every page in the space and leave a
suggestion comment" task has no upper bound. 500 pages × 3 comments =
1 500 comment emails to the page watchers. The deliberately visible
prefix helps humans clean up afterwards, but only if they notice.

Dual concern: `delete_comment` loops can wipe the conversation history
of a whole page with no recovery path. Unlike pages, comments have no
Confluence trash / restore flow.

## Possible mitigation

Same structural fix as findings [1](01-mass-creation.md) and
[2](02-mass-deletion.md): session budget + burst detection. Comments
are lower stakes than pages but the scale and notification cost make
them a realistic spam vector.
