# Plan: add an attachment *download* tool

**Status:** implemented in 6.10.0. The open questions below are answered in
the code: v2 `/attachments/{id}` won (it is keyed by attachment id and
returns `pageId`, which the space-allowlist check needs), and `downloadLink`
is resolved against `cfg.url` for all three shapes it has been observed in.
Verified end-to-end against a live instance, not just stubbed `fetch`.

**Catalyst:** an agent needed a document template that is stored as a
Confluence attachment on a wiki page. It could find the page, and
`get_attachments` told it the file existed, its media type and its size —
but there is no tool that returns the bytes. The agent had to abandon the
task and ask the human to download the file by hand.

The gap is narrow and the fix is small: the server can *list* attachments
and *upload* them, but not *fetch* them. Attachment payloads are one of the
few kinds of Confluence content the MCP cannot reach.

## TL;DR

Add one read-only tool, `download_attachment`, that fetches an attachment's
bytes and **writes them to a local file**, returning the path rather than
the content. Mirror `add_attachment` in reverse: that tool takes a path and
uploads; this one takes an id and saves.

The response must not carry the file inline. Attachments are routinely
megabytes of binary; base64 in a tool result would blow up the agent's
context for no benefit, and the agent's own file tools can read the saved
file afterwards if it needs to.

## Current state

| Capability | Tool | Client function | Location |
|---|---|---|---|
| List attachments | `get_attachments` | `getAttachments` | `src/server/index.ts:3205`, `src/server/confluence-client.ts:1278` |
| Upload an attachment | `add_attachment` | `uploadAttachment` | `src/server/index.ts:2969`, `src/server/confluence-client.ts:1339` |
| **Download an attachment** | **missing** | **missing** | — |

Two useful facts about what already exists:

1. **The download URL is already parsed and then thrown away.**
   `AttachmentSchema` at `src/server/confluence-client.ts:601` declares
   `_links: z.object({ download: z.string().optional() })`. The v1 list
   response carries a ready-made download path for every attachment;
   `getAttachments` returns it in `AttachmentData`, and the `get_attachments`
   handler ignores it when formatting output.

2. **Attachments live on the v1 API.** The comment at
   `src/server/confluence-client.ts:225` records that v1 is used for CQL
   search and attachments because there is no v2 equivalent. That was true
   when written; v2 has since grown `/attachments/{id}`, which is worth
   checking before committing to v1 (see Open questions).

### Why the obvious workarounds fail

Worth recording so the next person does not retry them:

- **`get_page` with the attachment id does not work.** Attachment ids from
  `get_attachments` have the form `att<digits>`. Passing that to `get_page`
  returns `400 INVALID_REQUEST_PARAMETER … Expected type is long`; stripping
  the `att` prefix and passing the digits returns `404`. The page endpoint
  is simply the wrong endpoint, and the error messages do not say so.
- **There is no CLI escape hatch.** The CLI (`src/cli/index.ts`) exposes
  `setup`, `permissions` and `fix-legacy-links` only. An agent blocked on
  this cannot shell out.

## Proposed tool

### Name

`download_attachment`. It pairs readably with `add_attachment` and says
plainly that a file lands on disk. (`read_attachment` was considered and
rejected: "read" suggests content comes back in the response, which is
exactly what this tool must not do.)

### Input schema

```ts
{
  attachment_id: z.string()
    .describe("Attachment ID from get_attachments, e.g. att12345678"),
  output_path: z.string().optional()
    .describe(
      "Absolute path to write to, under the working directory. " +
      "Defaults to the attachment's own filename in the working directory."
    ),
  overwrite: z.boolean().default(false)
    .describe("Replace an existing file at the destination"),
}
```

Accepting `page_id` + `filename` as an alternative addressing mode is
possible but not recommended for a first cut; one unambiguous key is easier
to validate and to document.

### Output contract

On success, a short text result naming what was saved and where:

```
Downloaded: <title> (<mediaType>, <n> bytes)
Saved to: /abs/path/to/file
```

On failure, route through `toolErrorWithContext` with
`{ operation: "download_attachment", resource: `attachment ${attachment_id}`, profile: config.profile }`,
matching `add_attachment` at `src/server/index.ts:3023`.

### Read-only classification

This is a **read**. It must therefore:

- carry `annotations: { readOnlyHint: true }`, like `get_attachments`;
- **not** call `writeGuard(...)`, so it keeps working in read-only profiles;
- **not** consume write budget (`src/server/write-budget.ts`).

Note the asymmetry worth thinking about: the tool writes to the local
filesystem while being a read against Confluence. The read-only posture
governs the *remote* side. Say so in the tool description so nobody
"fixes" it later by adding a write guard.

## Implementation steps

1. **Client function** in `src/server/confluence-client.ts`, next to
   `getAttachments` (~line 1288):

   ```ts
   export async function downloadAttachment(
     attachmentId: string
   ): Promise<{ title: string; mediaType?: string; data: Buffer }>
   ```

   Resolve the attachment's metadata and download path, then fetch the
   bytes. Use `confluenceRequest` (`src/server/confluence-client.ts:838`)
   so the 401/403/404 error mapping to `ConfluenceAuthError` /
   `ConfluencePermissionError` / `ConfluenceNotFoundError` comes for free.

   One wrinkle: `confluenceRequest` passes `cfg.jsonHeaders`, which sets
   `Content-Type: application/json`. That is harmless on a GET, but the
   response must be consumed with `await res.arrayBuffer()`, never
   `res.json()`. If the download endpoint turns out to redirect to a
   pre-signed media URL, follow the redirect **without** the `Authorization`
   header, since forwarding credentials to a different host is a real
   leak; check `res.redirected` and the final URL's origin.

2. **Register the tool** in `src/server/index.ts`, next to `get_attachments`
   (~line 3205). Follow the `add_attachment` handler for the path-safety
   shape (`src/server/index.ts:3005-3015`).

3. **Add `"download_attachment"` to `KNOWN_TOOLS`** in
   `src/server/tool-allowlist.ts:27`. A test enforces that every registered
   tool appears there, so skipping this breaks CI — which is the intended
   behaviour, not an obstacle.

4. **Consider the space allowlist.** `add_attachment` calls
   `checkSpaceAllowed({ pageId: page_id })`; `get_attachments` does not.
   A download moves content out of Confluence and onto local disk, so it
   belongs with the former rather than the latter. This needs a page id,
   which the attachment metadata should supply. Decide explicitly and
   record the decision in the handler as a comment.

5. **Docs.** `CONTRIBUTING.md` requires updating
   `doc/user-doc/tools-reference.md` for any new tool.

6. **Changelog** entry, matching the existing style in `CHANGELOG.md`.

## Security requirements

These are not optional extras; an attachment is attacker-influenced data in
any wiki with more than one author.

1. **The filename is untrusted input.** The attachment title comes from
   whoever uploaded it. When `output_path` is omitted and the title is used
   to build the destination, validate it with `isValidAttachmentFilename`
   from `src/server/converter/filename-validator.ts:36`, which already
   rejects separators, control characters, `..` segments and leading dots.
   Reject rather than sanitise, so behaviour is predictable.

2. **Confine writes to the working directory.** Reuse the check
   `add_attachment` performs at `src/server/index.ts:3005-3015`: resolve the
   path, `realpath` the working directory, and require the destination to be
   inside it. Apply this to the *parent directory* of the destination, since
   the file itself does not exist yet.

3. **Do not follow symlinks at the destination.** A pre-existing symlink at
   `output_path` would redirect the write outside the working directory even
   when the path string looks fine. `src/shared/safe-fs.ts` already has
   `verifyDirChain` and an `O_NOFOLLOW` capability flag
   (`SAFE_FS_HAS_O_NOFOLLOW`); write through an `O_NOFOLLOW | O_EXCL` open
   rather than a plain `writeFile`.

4. **Refuse to overwrite by default.** `overwrite: false` plus `O_EXCL`
   gives this for free and prevents an agent clobbering a local file by
   guessing a path.

5. **Cap the size.** Fetch the metadata first and refuse above a ceiling
   (10 MB is a reasonable default) with an error naming the actual size, so
   the agent can decide rather than silently filling the disk. Make the
   ceiling a constant, not a magic number.

6. **Never log the bytes or the auth header.** `sanitizeError` exists for
   this; error paths must not echo response bodies of binary downloads.

## Testing

Follow the conventions in `src/server/confluence-client.test.ts`: env vars
set via `vi.hoisted` before module evaluation, keychain and test-connection
mocked, `fetch` stubbed per case.

Cases that should exist:

- Happy path: metadata fetched, bytes written, returned path correct.
- Attachment id not found maps to `ConfluenceNotFoundError`.
- 403 maps to `ConfluencePermissionError`.
- Hostile filename (`../../etc/passwd`, `foo/bar`, a leading dot, a control
  character) is rejected and nothing is written.
- `output_path` outside the working directory is rejected.
- Destination is an existing symlink: rejected, target untouched.
- Existing file with `overwrite: false`: rejected; with `true`: replaced.
- Oversized attachment: rejected before the body is fetched.
- Read-only profile: the tool still works (guards against someone adding a
  write guard later).
- `tool-allowlist` invariant test passes with the new name registered.

## Open questions

1. **v1 or v2?** v1 `/content/{pageId}/child/attachment` is already wired up
   and its `_links.download` is already in the schema, but it addresses by
   page, not by attachment id. v2 exposes `/wiki/api/v2/attachments/{id}`,
   which matches the proposed input schema directly and returns a
   `downloadLink`. Verify the v2 shape against a live instance before
   choosing; the comment at `confluence-client.ts:225` asserting "no v2
   equivalent" predates v2's attachment endpoints and should be corrected
   either way.

2. **How is `downloadLink` rooted?** The v1 `_links.download` value is a
   path, not an absolute URL, and is relative to the instance's `/wiki`
   base rather than to `cfg.apiV1`. Confirm empirically and build the URL
   from `cfg.url`, not by string-concatenating onto an API base.

3. **Should `get_attachments` surface the download path?** Adding it to the
   listing output would let an agent see at a glance that a file is
   retrievable. Cheap, but it lengthens a listing that is already verbose;
   the id is sufficient once this tool exists.

4. **Text extraction.** A separate, larger feature: returning the *text* of
   a PDF or Office attachment rather than the bytes. Explicitly out of scope
   here. If it is ever added, the extracted text is untrusted third-party
   content and must go through the same `<<<CONFLUENCE_UNTRUSTED>>>` fencing
   that page bodies use (`src/server/converter/untrusted-fence.ts`).

## Verification before calling it done

The one check that actually proves the feature works is an end-to-end
download against a real instance: list attachments on a page, download one,
and confirm the saved file's bytes match the original — compare a hash, not
just the size. Unit tests with a stubbed `fetch` cannot catch a wrong URL
base, a mishandled redirect, or a response consumed as JSON.
