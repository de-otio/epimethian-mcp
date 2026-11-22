# Plan: write tools for blog posts

**Status:** proposed.
**Issue:** feature request, not yet filed. Issue #5 put writes out of scope
and asked that, if they are added, they get "the same guards as page
writes".
**Depends on:** [read-blog-posts.md](read-blog-posts.md), with the fixes from
its review folded in: one shared content-type resolver, an error class for
"this id is a blog post", and no blog bodies in `pageCache`.

**Catalyst:** once #5 lands, an agent can find and read a blog post but not
publish or edit one. An agent asked to publish a post today creates a page
instead, which lands in the page tree, not the space's blog.

## TL;DR

Two stages, two PRs or more. Stage A makes the existing write path
consistent about content type. Stage B adds the tools on top of it.

- **Stage A, groundwork.**
  - The space allowlist learns to resolve a blog post's space.
  - `resolve_comment` and `delete_comment` get the space check they lack
    today, for pages as much as for blog posts.
  - The side writes (labels, status, attachments, comment replies) get one
    stated rule for blog posts, instead of "allowed without an allowlist,
    refused with one".
- **Stage B, the tools.** `create_blog_post` and `update_blog_post`, as
  separate tools, not a flag on the page tools.
  - Creation makes a **draft** by default.
  - Publishing is an explicit request, always confirmed by the user, and a
    batch token never covers it. Publishing a blog post sends email to
    people who never asked to watch the space; a page edit does not.
  - Updates run the full `update_page` pipeline: content-safety guards,
    version pin, provenance, confirmation for destructive changes, write
    budget, mutation log, attribution.
- Out of scope: deleting, reverting, and section or append edits to blog
  posts. Each is a follow-up once B has been used.

## What the Confluence v2 API says

From the published OpenAPI spec (`openapi-v2.v3.json`, retrieved 2026-10-15):

- **`POST /blogposts`** (`BlogPostCreateRequest`):
  - `spaceId` is required.
  - `status` is `current` (the default) or `draft`. `title` is required
    unless the post is a draft.
  - `body` takes the storage representation only.
  - `createdAt` sets the post's date. That date decides the
    `/blog/yyyy/mm/dd/` URL and the post's place in the blog feed.
  - There is no parent, no position and no `root-level` parameter, unlike
    `POST /pages`.
- **`PUT /blogposts/{id}`** (`BlogPostUpdateRequest`):
  - Required: `id`, `status`, `title`, `body`, and `version` (`number`,
    `message`), the same as `PageUpdateRequest`.
  - It has no `parentId` or `ownerId`, and `createdAt` can be changed.
  - `spaceId` cannot move a post to another space.
  - Setting `status: current` on a trashed post restores it without
    changing its content. Setting `current` → `draft` deletes any existing
    draft.
- **`DELETE /blogposts/{id}`**: moves a published post to the trash. A
  discarded draft is deleted permanently. Purging needs `purge=true` and the
  space's `manage/content` permission.
- **Notifications.** Neither write takes a parameter that suppresses
  notifications; `version` carries only `number` and `message`. Atlassian's
  documentation describes three ways a new post reaches people:
  - [space watchers](https://support.atlassian.com/confluence-cloud/docs/watch-pages-spaces-and-blogs/);
  - the narrower "watch new blog posts" setting on a space;
  - the account-wide ["all blog posts"](https://support.atlassian.com/confluence-cloud/docs/subscribe-to-email-notifications/)
    subscription. It emails a user about **every** new post they are
    allowed to view, in spaces they don't watch.

  Publishing a post is therefore a broadcast. Whether creating a *draft*
  notifies anyone is not documented. Live verification step 2 settles it,
  and Stage B's draft-first design depends on the answer.

## Current state of the write path

From an inventory of `src/server/` (2026-10-15). "Page-specific" means the
step calls `getPage`, builds a `/pages/` path, or is scoped by page id in a
way that rejects a blog post.

| Step | Where | Page-specific? |
|---|---|---|
| `writeGuard` | `index.ts:759` | No. It checks the tool name only |
| Space allowlist, by page id | `space-allowlist.ts:100` → `getPage` | **Yes.** It does nothing when no allowlist is set (`:153`) |
| Space allowlist, by space key (`create_page`) | `index.ts:1244` | No |
| Duplicate-title check on create | `safe-write.ts:1727` → `getPageByTitle` → `/pages?title=` | **Yes** |
| Content-safety guards (`safePrepareBody`) | `safe-write.ts:1348-1650` | No. They work on the body only |
| Version pin, `validateSource` | `index.ts:1708`, `:1719` | No |
| Confirmation token | `confirmation-tokens.ts:60-83` | It binds `tool`, `cloudId`, an id and a version. The id field is named `pageId`, but nothing checks the type. A token minted by one tool cannot be used by another |
| Batch token | `batch-tokens.ts:520` | It is scoped to the `page_ids` it was minted for |
| Write budget | `safe-write.ts:1821` | No |
| Raw writers | `confluence-client.ts:1346` (`POST /pages`), `:1442` (`PUT /pages/{id}`) | **Yes.** Only `safe-write.ts` may import them (`no-direct-raw-writer.test.ts`) |
| 409 handling | `confluence-client.ts:1457` re-reads `/pages/{id}` | **Yes** |
| Outcome-unknown marks, `pageCache` | `page-cache.ts`, `confluence-client.ts:927-938` | They are keyed by id, which is safe because pages and blog posts share one id space |
| Mutation log | `mutation-log.ts:39-49` | **Yes.** `operation` accepts page tool names only |
| Attribution label, "unverified" status | `confluence-client.ts:2470`, `:2566` (v1 `/content/{id}/…`) | No. They work for any content type |

Side writes, by whether a blog post id reaches Confluence:

| Tool | No allowlist | With an allowlist |
|---|---|---|
| `add_label`, `remove_label`, `set_page_status`, `remove_page_status`, `add_attachment` | Reaches it (v1 `/content/{id}/…`) | Refused: `getPage` 404s |
| `add_drawio_diagram` | **Uploads the attachment, then fails** at `getPage` (`index.ts:3547` before `:3583`) | Refused |
| `create_comment`: reply, or top-level footer comment | Reaches it. A reply is keyed by the parent comment. A top-level footer comment sends `pageId`, which a blog post probably rejects | Refused |
| `resolve_comment`, `delete_comment` | Reaches it | **Reaches it.** These two never call the space check (`index.ts:4697`, `:4734`) |

## Stage A: groundwork

### A1. Comment tools get the space check (security, ship first)

`resolve_comment` and `delete_comment` are the only write tools that never
call `checkSpaceAllowed`. With a `spaces` allowlist set, an agent can
resolve or delete a comment in **any** space it can read, by comment id.
Reads are not limited to the allowlist, so it can obtain those ids. This is
true for pages today. It does not depend on blog posts.

Fix: fetch the comment (`GET /footer-comments/{id}` or
`/inline-comments/{id}`, which `resolve_comment` already does), take its
container from `pageId` or `blogPostId`, and run the space check on that
container. If the container cannot be found, refuse the write, as the
allowlist does elsewhere. Do nothing when no allowlist is set, so behaviour
without one is unchanged.

This is small, independent of everything else here, and closes a real gap.
Ship it as its own PR, before #5.

### A2. The allowlist resolves blog posts

Replace `getPage(pageId, false)` in `resolvePageSpace` with a call that
knows the type: `resolveContentSpace(id) → { type, spaceKey }`, built on the
read plan's resolver. Two rules stay as they are:

- A space that cannot be resolved means the write is refused.
- Every write keeps its own page-only checks. A2 changes which space the
  allowlist sees, not which writes are allowed.

After A2, a profile with an allowlist judges a blog post by its space, as a
profile without an allowlist already does in effect.

### A3. One rule for side writes on blog posts

Labels, status, attachments and comment replies on a blog post are, from
Confluence's side, the same operations as on a page. Confluence's own
permissions decide whether they are allowed. **Recommendation: allow them,
and make A2 the reason they are allowed consistently.** Blocking them would
add a type check to six tools in order to forbid something users already do
in the UI. The alternative is to refuse blog post ids in those tools. The
maintainer decides before A ships (see Open questions).

Either way:

- Tool descriptions and `tools-reference.md` say "page or blog post" where
  the tool accepts both.
- Starting a new footer comment on a blog post needs `blogPostId` in the
  request. If the rule is "allow", add it here and use the read plan's
  resolver to pick the field. If not, refuse with the blog-post error.

### A4. Order of the draw.io upload (found while inventorying; small)

`add_drawio_diagram` uploads the attachment before it reads the page, so a
failed page read leaves an orphaned attachment. This happens with any id
that `getPage` cannot read, not only blog posts. Read the page first. It is
a one-line move with one test. Include it in A or file it separately.

## Stage B: the tools

### B1. Separate tools, not a `content_type` flag

`create_blog_post` and `update_blog_post`:

- **The inputs differ.** A blog post has no parent and no position, and
  it can have a date. A flag on `create_page` would leave `parent_id`
  meaning nothing in one mode.
- **The risk differs.** Publishing is a broadcast (see the API section).
  With separate tools an operator can allow page writes and still deny
  blog publishing, through the per-profile tool allowlist
  (`tool-allowlist.ts`), without new configuration.
- **The descriptions stay honest.** An agent reads "Publish a blog post;
  this notifies readers" on the tool it is about to call.

Both go into `WRITE_TOOLS` and `KNOWN_TOOLS`. `tool-surface.test.ts:413`
enforces the second.

### B2. `create_blog_post`: draft by default, publishing confirmed

Inputs: `space_key`, `title`, `body` (storage or markdown, as
`create_page`), `publish: boolean = false`, and `source`.

- **`publish: false`** (default): `POST /blogposts` with `status: draft`.
  The result says it is a draft, gives the id, and says how to publish.
  It needs no confirmation, the same as `create_page`.
- **`publish: true`**, or publishing an existing draft through
  `update_blog_post`: **always** goes through `gateOperation`, the same
  elicitation or soft confirmation that destructive writes use. The prompt
  names the space and the title, and says that publishing notifies readers.
  - A `batch_token` never satisfies it. `authorise_destructive_writes`
    stays limited to pages.
  - A `source` of `chained_tool_output` is refused, as it is for
    destructive flags. A post that a prompt injection talked the agent into
    must not reach every reader's inbox.
- **`createdAt` is not exposed.** Backdating a post changes its URL and its
  place in the feed, which also hides when it was really posted. Add it only
  if someone needs it, and then behind the same confirmation.
- **No duplicate-title check before writing.** Blog titles need only be
  unique per space per day, so the page check (`getPageByTitle`) does not
  apply. Rely on Confluence's error and pass it on. Live verification
  step 4 records what that error looks like.
- **Attribution:** the version message is `Created by … (via Epimethian …)`,
  as for pages. The `epimethian-edited` label and the "unverified" status go
  through v1 `/content/{id}`, which accepts blog posts. Live verification
  confirms that.

If step 2 of the live verification shows that creating a draft does notify
people, the design does not change. Creating a post of either kind is then
confirmed, and `publish` only chooses the status.

### B3. `update_blog_post`: the full `update_page` pipeline

Inputs: `blog_post_id`, `title`, `body`, `version`, `publish?`, the same
destructive flags as `update_page`, `confirm_token`, and `source`. It runs
the steps `update_page` runs, in the same order:

1. Version pin, the space allowlist (through A2), `validateSource`.
2. Read the current body through the read plan's `fetchContent("blogpost")`.
3. `safePrepareBody` with the current body, so every content-safety guard
   runs: shrinkage, structure, macros, tables, invented tokens, deletion
   acknowledgement, and the untrusted-fence echo.
4. If a destructive flag is set: a confirmation token or `gateOperation`.
   No batch token, as in B2.
5. Write budget, then the raw write.
6. Mutation log, cache invalidation, outcome-unknown handling, 409
   handling, attribution.

`publish: true` on a draft is the publish step from B2, with B2's
confirmation. Setting a published post back to a draft is not supported:
Confluence then deletes any existing draft, and nobody has asked for it.

### B4. Make `safe-write` work for both types without copying it

The pipeline lives in `safe-write.ts`. Do not copy it for blog posts:

- Generalise the raw writers to `_rawCreateContent(type, …)` and
  `_rawUpdateContent(type, …)`, with the path chosen from the same map
  the read plan adds. The page writers become wrappers, so callers of
  `update_page` do not change.
- Have the 409 re-read call `/blogposts/{id}` for a blog post.
- Add `create_blog_post` and `update_blog_post` to the mutation log's
  `operation` union. Rename its `pageId` field only if that stays a small
  change. The id is valid either way.
- Extend `no-direct-raw-writer.test.ts` to the new writers.
- The confirmation token keeps its `pageId` field. It holds a content id,
  and the `tool` binding already stops a token from one tool being used by
  another. Add a comment saying so; a rename is not worth the churn.

## Tests

Assert on request method, URL and body, not only on the result.

**Stage A**
- `resolve_comment` / `delete_comment` with an allowlist:
  - a comment on a page outside the allowlist is refused, and **no
    PUT/DELETE is sent**;
  - a comment inside it goes through;
  - an unresolvable container is refused;
  - without an allowlist, the requests are the same as before.
- The allowlist with a blog post id: an allowed space goes through, a
  disallowed space is refused, an unresolvable one is refused.
- With a `/pages` 404 and a `/blogposts` 500, the space check refuses the
  write; it does not treat the post as unknown and let it through.
- Each side-write tool, with a blog post id: what it does matches the A3
  decision. Cover both "no allowlist" and "allowlist".
- `add_drawio_diagram` with an id that cannot be read: no upload is sent.

**Stage B**
- `create_blog_post`:
  - by default: `POST /blogposts` with `status: "draft"`, and no
    confirmation is asked for;
  - `publish: true` with no confirmation: refused with
    `SOFT_CONFIRMATION_REQUIRED` and **no POST**;
  - a batch token alone: refused, no POST;
  - `source: chained_tool_output` with `publish: true`: refused, no POST;
  - the request never contains `createdAt`, `parentId` or `subtype`.
- `update_blog_post`:
  - each content-safety guard fires on a blog post body. Run the guard
    cases from the `update_page` suite against a blog post fixture rather
    than writing new ones;
  - a stale version gives a conflict, and the re-read goes to
    `/blogposts/{id}`;
  - a page id is refused with no PUT, and so is a blog post id given to
    `update_page`;
  - the mutation log records `update_blog_post`, and the write budget is
    consumed once.
- A profile tool denylist containing `create_blog_post`: the tool is not
  registered, and `create_page` still is.
- `tool-surface.test.ts`, `permission-and-provenance.integration.test.ts`
  (`WRITE_TOOLS` completeness) and `output-schema-conformance` cover the
  new tools.

## Live verification (before merging B)

Use a test space and two test users. User 2 watches the space and has the
"all blog posts" email subscription on.

1. Stage A: with an allowlist that excludes the test space, try
   `delete_comment` on one of its comments. It is refused and the comment
   survives.
2. `create_blog_post` with the default. Record whether user 2 gets any
   notification. **The draft-first design depends on this step.**
3. Publish the draft through `update_blog_post`. The confirmation is shown,
   and user 2 is notified.
4. Create a second post with the same title on the same day. Record what
   Confluence returns.
5. Update the published post, including one change that should trip a
   content-safety guard. The guard fires, and the post's version is
   unchanged.
6. Confirm that the attribution label and the "unverified" status are on
   the post.

## Docs

- `doc/user-doc/tools-reference.md`:
  - a "Blog posts" section with both tools and the note that publishing is
    a broadcast;
  - each side-write tool says whether it accepts blog posts (A3);
  - the comment tools say they obey the space allowlist (A1).
- `doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md`:
  record A1 and A2.
- `README.md`: tool table.
- `CHANGELOG.md`: A1 under Security in the release it ships in. B in a
  minor release under Added.

## Out of scope / follow-ups

- **Deleting a blog post.** Deletion moves the post to the trash, so it can
  be undone, but `delete_page` has its own confirmation design. Copy that
  design when someone asks for it.
- **Reverting a blog post.** `getPageVersionBody` already falls back to v1
  for any content type (`confluence-client.ts:2307-2316`). The cache-hit
  path still calls `/pages` (`:2298`), and the read plan lists that as a
  follow-up.
- **Section, append and prepend edits to blog posts.** They reuse B4's
  writers. Add them when `update_blog_post` has been used enough to show
  they are needed.
- **`createdAt`**, as discussed in B2.

## Open questions

1. **A3: allow or refuse side writes on blog posts?** The recommendation is
   to allow them. The maintainer decides before Stage A ships.
2. **Draft first.** Is a two-step create-then-publish acceptable for an
   agent that has been told to "publish this"? The alternative is
   `publish: true` in one call, with the same confirmation. The design
   supports both. Only the default is in question.
