# Plan: read tools open blog posts

**Status:** proposed.
**Issue:** [#5](https://github.com/de-otio/epimethian-mcp/issues/5)

**Catalyst:** search and `get_recent_changes` return blog posts (labelled
`[blog]`), but no read tool can open one. `get_page` on a blog post id
returns `404 Cannot find a page with id [...]`, which reads as "this does
not exist". `get_comments` returns `400 Invalid input`. An agent handed a
blog URL gets the search excerpt and nothing else.

## TL;DR

Detect the content type on the server. Do not ask the agent for it.

- `get_page` tries `/pages/{id}` first, as it does now. On a 404 it tries
  `/blogposts/{id}`. Page reads cost the same as before. A blog read costs
  one extra request every time: there is no id → type memo, and blog
  bodies are not cached (D6).
- `get_comments` resolves the type first, then calls the matching
  `/pages/...` or `/blogposts/...` comment endpoints.
- The tools that rewrite a page body stay page-only. When one targets a
  blog post id, the agent is told so, not given a bare "not found" (D3).
  Label, status and comment tools are not covered by this change (see
  Out of scope).
- The URL-parser part of the issue is deferred (see "Issue item 2").

## Current state

| What | Where | Blog posts today |
|---|---|---|
| `get_page`, plus `headings_only` / `section` / `format` | `src/server/index.ts:1298` → `getPage` (`src/server/confluence-client.ts:1288`) → `renderPageRead` (`index.ts:353`) | 404: `getPage` calls only `/pages/{id}` |
| `get_comments` | `index.ts:4514` → `getFooterComments` / `getInlineComments` (`confluence-client.ts:2599`, `:2610`) | 400: calls `/pages/{id}/…-comments` |
| Comment replies | `getCommentReplies` (`confluence-client.ts:2626`) | Works already: `/footer-comments/{id}/children` and `/inline-comments/{id}/children` are keyed by comment id, not by container |
| Search and recent changes | `searchContent` (`confluence-client.ts:1642`), `recent-changes.ts:188`, `:379` | Returns blog posts with `type: "blogpost"` |
| v1 readers: `get_labels`, `get_attachments`, `get_page_versions`, `get_page_status` | `/rest/api/content/{id}/…` | Probably work already: v1 `content` does not depend on type. Check them live (see Verification) |
| Space allowlist (writes) | `space-allowlist.ts:100` → `getPage(id, false)` | 404, so the write is refused. This must stay true |
| `url-parser.ts` | `src/server/converter/url-parser.ts` | Pages only. **No production caller.** `md-to-storage.ts:20` stopped importing it. Only its own test uses it |

A related gap: `get_page`'s `page_id` is a bare `z.string()` (`index.ts:1308`),
while `get_comments` uses the numeric `pageIdSchema` (`index.ts:1060`).
`v2Get` builds the request with `new URL(\`${apiV2}${path}\`)`, so a value
such as `../spaces` is path-normalised into a different endpoint. This plan
adds a second path template (`/blogposts/${id}`) to the same input, so it
fixes the validation in the same change.

## What the Confluence v2 API says

Checked against the published OpenAPI spec (`openapi-v2.v3.json`, retrieved
2026-10-15):

- `GET /blogposts/{id}` takes the same query parameters as
  `GET /pages/{id}`: `body-format`, `get-draft`, `status`, `version` and the
  `include-*` flags. The page-only ones are `include-direct-children` and
  the `archived` status, and we use neither. The `id` is `int64`.
- The `BlogPostSingle` fields are a subset of `PageSingle`: no `parentId`,
  `parentType`, `position`, `ownerId` or `lastOwnerId`. `PageSchema`
  (`confluence-client.ts:576`) reads none of these, so it parses a blog
  post as it is.
- On both endpoints a 404 means "not found **or** not permitted to view".
- `GET /blogposts/{id}/footer-comments` and `/inline-comments` take the
  same parameters as their page counterparts, including
  `resolution-status` on inline comments. `limit` has a maximum of 250 on
  both.
- `BlogPostCommentModel` carries `blogPostId` in place of `pageId`.
  `CommentSchema.pageId` is optional (`confluence-client.ts:659`), so blog
  comments parse. Nothing that formats comments reads `pageId`.
- Content ids share one id space across pages and blog posts, so a page
  id and a blog post id never collide.

## Design decisions

### D1. Auto-detect, not a `content_type` parameter

The issue offers both. Auto-detect wins:

- The agent often does not know the type. It got the id from a human, a
  link in another page, or an earlier tool result that it summarised. A
  required parameter makes the agent guess. An optional one with a page
  default brings the same 404 back when the agent leaves it out.
- Pages are the common case, and the fallback runs only after a page 404.
  Page reads keep one request and give the same output.
- The other probe in the issue is rejected: v1 `GET /content/{id}`, which
  returns `type`. It would add a request to **every** read in order to
  speed up the rare one.

### D2. Fall back only on a 404

Only a `ConfluenceNotFoundError` from `/pages/{id}` triggers the
`/blogposts/{id}` attempt. A 401, 403, 429 or 5xx is rethrown unchanged. A
fallback on those would hide auth and rate-limit failures behind a second
error.

When both endpoints 404, the error reads: *"No page or blog post with id X
exists, or this account cannot view it."* This also covers the
"not permitted" meaning of a 404, which the current message hides.

### D3. Body-rewriting writes stay page-only, with a better error

Do **not** change `getPage`'s contract. It still never returns a blog
post. The tools that rewrite a body (update, section, prepend/append,
revert, draw.io) resolve the page through it, and `delete_page` reads
`/pages/{id}` itself, so a blog post id fails before any of those write.

This is **not** "blog posts are read-only". When no `spaces` allowlist is
set, the allowlist check is a no-op, and these tools never request
`/pages`:

- the v1 label and status tools (`/content/{id}/…` accepts any type);
- the comment tools that work from a comment id.

What they do on a blog post is pinned by a test and decided in a follow-up.
Descriptions and docs name the page-only tools; they do not claim all
writes are page-only.

Only the error changes:

- When `getPage` gets a 404 from `/pages`, it makes one metadata
  `GET /blogposts/{id}`.
- If that succeeds, it throws `ContentIsBlogPostError`: *"id X is a blog
  post. This tool works on pages only; blog posts can be read with
  get_page and get_comments."*
- The extra request runs only on a path that already failed.

**Fail-closed rule.** Once `/pages` has returned 404, `getPage` throws,
whatever `/blogposts` returns:

- success → `ContentIsBlogPostError`;
- 404, 403, 429, 5xx, a network error or a parse error → the original 404.

The space allowlist relies on `getPage` throwing to refuse a write whose
space it cannot determine.

**Reaching the agent.** Write tools report errors through
`toolErrorWithContext`, which replaces every not-found with a fixed
generic message. `ContentIsBlogPostError` subclasses
`ConfluenceNotFoundError`, so every existing catch site still treats it
as not-found and fails closed. `toolErrorWithContext` gets a branch for it
**before** the not-found branch and returns its own message. Tests assert
on the text the tool returns, not on the exception the client throws.

### D4. Comments resolve the type before fetching

`get_comments` calls `resolveContentType(id)` first, then the matching
endpoints. It does not try the page endpoints and react to their 400: a 400
`Invalid input` is too vague to base a decision on. For a page the check
costs one metadata GET; for a blog post, two.

### D6. No memo, no blog caching

There is no id → type memo. It would need a size cap, a test reset hook, a
stale-entry branch and tenant keying (the other lookup caches key on the
site URL as well as the id). All of that to save one request per blog
read. As with seeding from search hits, add it only if the cost shows up
in practice.

Blog bodies do not go into `pageCache`. That cache exists for repeated
editing, and blog posts are not edited here. Keeping them out means the
write paths that read the cache never hold non-page content. That stays
true without relying on every write requesting `/pages` first.

### D5. Output: mark blog posts, leave page output unchanged

`formatPage` (`confluence-client.ts:3406`) adds `Type: blog post` after
`ID:`, **for blog posts only**, so page output stays byte-identical and
existing tests and agents see no change. `formatComments` /
`formatCommentThreads` (`index.ts:876`, `:898`) say "Comments on blog post
X" in place of "Comments on page X".

## Issue item 2 (URL parsing): defer, and say so on the issue

`parseConfluenceUrl` has no production caller, and no tool accepts a URL.
Teaching it the `/blog/yyyy/mm/dd/{id}/…` form would change nothing that an
agent sees. The real need is "an agent handed a blog URL can read it", and
D1 meets it: the URL contains the numeric id. The `get_page` description
tells the agent which segment that is.

Revisit this if a tool starts accepting URLs. At that point the parser
returns `contentType` with the ref, and the fallback can be skipped.

## Implementation steps

One PR, in this order. Each step leaves the suite green.

1. **Client: generalise the fetch** (`confluence-client.ts`)
   - Add `export type ContentType = "page" | "blogpost"` and
     `export class ContentIsBlogPostError extends ConfluenceNotFoundError`.
   - Add `getContent(id, includeBody): Promise<PageData & { contentType }>`.
     It runs `getPage`'s existing page logic, page cache included. On a
     `ConfluenceNotFoundError` only, it fetches `/blogposts/{id}` without
     the cache. The read is the probe; there is no separate one.
   - Add `resolveContentType(id)`: metadata `GET /pages/{id}`, then on a
     404 `GET /blogposts/{id}`, following the D2 rules.
   - Both functions reject a non-numeric id before building a path.
   - `getPage` gains the D3 error and the fail-closed rule.
2. **Client: comments.** Add a `type: ContentType = "page"` parameter to
   `getFooterComments` and `getInlineComments`, and choose the path from
   it. Existing callers keep the default. The `createFooterComment` /
   `createInlineComment` writes are not touched.
3. **`get_page`** (`index.ts:1298`)
   - Change `page_id` to `pageIdSchema`.
   - Call `getContent` in place of `getPage`. `renderPageRead` needs no
     change for headings, section or markdown: all three work on the
     storage body, whatever the type.
   - Description: "Read a Confluence page or blog post by ID. … For a blog
     URL (`/wiki/spaces/<KEY>/blog/<yyyy>/<mm>/<dd>/<id>/<slug>`), pass
     `<id>`." It names the body-rewriting tools as page-only and does not
     claim that every write tool is.
4. **`formatPage`**: add the `Type: blog post` line (D5). `PageData` gains
   an optional `contentType`, so `getPage`'s callers are not affected.
5. **`get_comments`** (`index.ts:4514`): `const type = await
   resolveContentType(page_id)`, then pass `type` into both fetchers and into
   the formatters for the header (D5). Description: "…on a Confluence page
   or blog post."
6. **Write-side error** (D3): in `getPage`, plus the
   `ContentIsBlogPostError` branch in `toolErrorWithContext`. Do not touch
   any write handler.
7. **Docs and release** (see below).

`get_page_by_title` is not touched: it looks up `/pages` by title and space
(`confluence-client.ts:1753`), and blog post titles are only unique per
day. That is a separate feature, so leave it.

## Tests

The tests use the stubbed `fetch` pattern already in
`confluence-client.test.ts`, and assert on **request URLs**, not just on
the returned values. A test that only checks the output would pass whether
the server called the right endpoint or the wrong one.

`confluence-client.test.ts`
- Page id: `getContent` makes exactly one request, to `/pages/{id}`, and
  never contacts `/blogposts` (fallback off the happy path).
- Blog id: `/pages/{id}` 404, then `/blogposts/{id}?body-format=storage`.
  The result has `contentType: "blogpost"` and the body.
- A second read of the same blog id repeats both requests, and
  `pageCache` holds nothing for it (D6).
- `/pages/{id}` returns 401, 403, 429 or 500: rethrown, and **no**
  `/blogposts` request (D2).
- Both 404: the error message names both types and the "cannot view" case.
- `getPage` on a blog id throws `ContentIsBlogPostError`, which is also a
  `ConfluenceNotFoundError` (D3).
- `getPage` when `/blogposts` returns 404, 403, 429, 500 or a network
  error: the original pages 404 is rethrown, and `getPage` never resolves
  (the fail-closed rule).
- A non-numeric id: rejected, with no request.
- `getFooterComments` / `getInlineComments` with `type: "blogpost"` hit
  `/blogposts/{id}/…-comments`, and `resolution-status` is still passed.

`index.test.ts` (or a new `blog-post-read.integration.test.ts` next to
`read-fencing.integration.test.ts`)
- `get_page` on a blog id with `headings_only`, with `section`, and with
  `format: "markdown"`: each returns the content, with the `Type: blog
  post` line.
- Blog body and title are fenced exactly like a page's (the same
  `fenceUntrusted` markers).
- Page output is unchanged: the existing `get_page` tests pass without
  edits, and one explicit assertion checks that no `Type:` line appears for
  pages.
- `get_page` with `page_id: "../spaces"` is rejected by the schema and
  makes no request.
- `get_comments` on a blog id: footer and inline comments are returned,
  under the "blog post" header. With `include_replies`, the `/children`
  endpoints are called unchanged.
- `update_page` (and one section write) on a blog id: the **tool output**
  names the blog post, and **no PUT is issued**. This is the guard that
  keeps body rewrites page-only.
- `add_label` on a blog id with no allowlist: pin what it does today,
  pending the follow-up.
- `tool-surface.test.ts` / `output-schema-conformance`: update the
  description snapshots if those tests pin them.

## Verification (live, before merge)

Run on a test instance with one blog post that has a footer comment and
an open inline comment:

1. `search_pages` finds the post. Pass the id from its `[blog]` hit to
   `get_page`, which returns the body.
2. `get_page` with `headings_only`, `section` and `format: "markdown"`.
3. `get_comments` with `type: "all"`, `resolution_status: "open"` and
   `include_replies: true`.
4. `update_page` on the post id: refused with the blog-post message, and
   the post's version is unchanged.
5. `get_labels`, `get_attachments`, `get_page_versions` and
   `get_page_status` on the post id. Record which ones work. Those that fail
   go into the follow-up below. Do not fix them in this PR.
6. `add_label` / `remove_label` and `set_page_status` /
   `remove_page_status` on the post id, with no allowlist. Record what
   happens, and undo any change. The result goes into the follow-up on
   side writes.

## Docs (same PR)

- `doc/user-doc/tools-reference.md`: in `get_page` and `get_comments`,
  "page or blog post", the blog URL → id note, and "blog posts are
  read-only".
- `README.md`: the tool table rows, if they say "page" only.
- `doc/design/03-tools.md`: one paragraph on content-type detection (D1,
  D2, D4). It must not suggest that `read_spaces` or `redact_patterns`
  limit `get_page`: they cover `search_pages` and `get_recent_changes`
  only, as before.
- `CHANGELOG.md`: `## [7.3.0]` (a new capability, so a minor version). Under
  Added: blog post reads. Under Changed: write tools name a blog post id
  when refusing it; `get_page` rejects non-numeric ids.

## Out of scope / follow-ups

- **Writes to blog posts** (issue item 4). If they are added, they go
  through the same `safe-write`, provenance, confirmation and allowlist
  guards. The allowlist resolves the space through `getPage`, so it needs a
  type-aware equivalent first.
- **`get_page_version` and `diff_page_versions`.** On a cache hit,
  `getPageVersionBody` calls v2 `/pages/{id}` for the title
  (`confluence-client.ts:2298`), and `diff_page_versions` calls
  `getPage(page_id, false)` (`index.ts:4903`). Both 404 on blog posts.
  Fixing them is a small change after this PR (use `getContent`, or v1
  only), but it widens the diff and the test surface. File it as its own
  issue.
- **Side writes on blog posts.** Label, status and comment-id tools may act
  on a blog post when no allowlist is set (D3). Decide whether to allow or
  refuse them, using the result of verification step 6.
- **A type memo, or seeding one from search hits** (D6). `searchContent`
  already knows each hit's type. Add either only if the extra request shows
  up in practice.
- **`url-parser.ts` blog form**, as above.

## Open questions

- None that block. Step 5 of the verification can widen the follow-up
  list, but it does not change this design.
