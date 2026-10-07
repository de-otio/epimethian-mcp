# Plan: update an existing attachment, and a draw.io diagram in place

**Status:** accepted, being implemented for 7.2.0. Tracks GitHub issue #3.
Revised 2026-10-07 after a security review and the read-only part of the
P0 probe; see "Security review" and "P0 answers".

**Progress (2026-10-07):** implemented, reviewed and committed locally on
`master`; version bumped to 7.2.0. The W6 reviews found no blockers; their
should-fix items (page step checked before the upload, an unreadable new
diagram refused, the upload logged before the version re-read, a per-file
inflate limit, uploads counted against the write budget) are fixed and
tested. Full suite green (2906 tests), build clean, no new type errors.
Not yet pushed or released.

Remaining, in order:
1. With the maintainer's per-invocation OK (public repo):
   `git push origin master`, `git push origin v7.2.0` (after `git tag v7.2.0`),
   then `gh release create v7.2.0 --repo de-otio/epimethian-mcp --title
   "7.2.0 - update attachments and draw.io diagrams in place"` with the
   CHANGELOG section as notes. The `publish.yml` workflow publishes to npm.
2. When npm shows 7.2.0: `epimethian-mcp upgrade`, restart the MCP server,
   and check `get_version`.
3. Optional, with the maintainer's OK for that run: the E2E checks below
   (the write questions P0 #3, #4 and #6 are still open).

**Catalyst:** an agent revised an existing draw.io diagram, checked the new
XML cell by cell against the live attachment, and then had no way to publish
it. `add_attachment` and `add_drawio_diagram` only create attachments.
When a file with that name already exists, Confluence answers
`400 Cannot add a new attachment with same file name as an existing
attachment`. Uploading under a new name orphans the old file and leaves every
macro that points at it stale. The only fix today is a manual upload in the
UI, followed by a hand edit of the macro's pinned `revision`.

## TL;DR

Three changes, plus one unrelated bug fix found in the same session:

1. **`add_attachment` gains `overwrite`** (default `false`). When it is set and
   the name exists, the tool uploads a new version of that attachment. It
   returns the attachment id and the new version number. Optional
   `expected_version` refuses if someone else uploaded in between.
2. **New tool `update_drawio_diagram`.** It uploads new XML (inline or from
   `file_path`) as a new version of an existing diagram attachment. Then, in
   one page version, it raises the pinned `revision` of every `drawio` macro
   on that page that shows this diagram. The rest of the body stays byte for
   byte the same. It refuses when no attachment of that name exists.
3. **`get_attachments` shows each attachment's version.** No hash: Confluence
   does not expose one, and computing it would mean downloading every file.
4. **Bug fix (separate commit):** `get_version` reports a stale "update
   available" record left by an older install, such as "v6.10.0 → v6.10.1"
   while running v7.1.0. The `upgrade` tool trusted the same record, so it
   would have installed v6.10.1 over v7.1.0: a downgrade. (Done: 45e3535.)

Upload first, then the page edit. The page edit is a pure function of the
body (raise one parameter in the matching macros). If the page moved on in
between, the tool can safely recompute it once on the fresh body. If the
page step still fails, the result says exactly what state was left behind
(attachment at vN, page still showing vN−1). That state is stale but safe.

## Current state

| Capability | Where | Gap |
|---|---|---|
| Upload | `uploadAttachment`, `src/server/confluence-client.ts:2152` | POST `/content/{id}/child/attachment` only creates; no version in result (`UploadResultSchema`, `:676`) |
| List | `getAttachments`, `confluence-client.ts:1860`; `AttachmentSchema`, `:615` | No `version`; no lookup by filename (a scan of the first `limit` would miss a name on a page with many files) |
| Download | `getAttachmentMetadata` / `downloadAttachmentBytes`, `:1927` / `:1978` | Fine; reuse for the shrinkage guard (10 MB cap) |
| Page-side write guard | `guardPageSideWrite`, `:942`; `parseWriteResponse`, `:959`; `WriteOutcomeUnknownError`, `:988` | Reuse as is: no blind retry of a POST |
| `add_attachment` handler | `src/server/index.ts:3198` | cwd/realpath check is inline; extract it so the new tool shares it |
| `add_drawio_diagram` handler | `index.ts:3257` | Writes `revision=1` / `contentVer=1`; appends `.drawio` to the name |
| Destructive-flag gating | `listDestructiveFlagsSet`, `src/server/source-provenance.ts:119`; `validateSource`; `gateOperation` + `maybeConsumeConfirmToken` (pattern: `revert_page`, `index.ts:4595`) | Has no attachment flags |
| Tool lists | `WRITE_TOOLS`, `index.ts:713`; `KNOWN_TOOLS`, `src/server/tool-allowlist.ts:29`; `tool-surface.test.ts` | Add the new tool |
| Update notice | `get_version`, `index.ts:4840`; `getPendingUpdate`, `src/shared/update-check.ts:155` | Returns the persisted `pendingUpdate` without checking it against the running version |

## Design

### Client (W1)

```ts
// Exact, case-sensitive title match. Sends v1 `?filename=` (narrow server-side)
// AND re-checks title equality locally, so a prefix or fuzzy server match
// can never select the wrong file. Returns null when absent.
findAttachmentByName(pageId, filename): Promise<AttachmentInfo | null>
//   GET /content/{pageId}/child/attachment?filename=…&expand=version

// New version of a known attachment.
//   POST /content/{pageId}/child/attachment/{attachmentId}/data
// Multipart: file, comment?, minorEdit (see P0 #4). Through guardPageSideWrite
// + sendGuarded("transfer"), never retried. Response parsed with
// parseWriteResponse; accepts both the bare-object and `{results:[…]}` shapes
// (P0 #3).
uploadAttachmentVersion(pageId, attachmentId, bytes, filename, comment?)
  : Promise<{ id: string; title: string; version: number; fileSize?: number }>

interface AttachmentInfo { id; title; version: number; fileSize?; mediaType? }
```

- `AttachmentSchema` gains an optional `version: { number }`.
  `getAttachments` requests `expand=version`.
- `uploadAttachment` also returns `version` (1 for a new file) when the
  response carries it.
- We use the `{attachmentId}/data` endpoint, not `PUT /child/attachment`
  (which creates or updates). An update must never create a file, and the
  endpoint keyed by id enforces that on the server as well.

### Pure core (W2): `src/server/drawio-macro.ts`

```ts
interface DrawioMacroRef {
  start: number; end: number;          // offsets of the whole macro
  diagramName: string;                 // entity-decoded
  pageIdParam?: string;
  revision?: { value: string; start: number; end: number };   // offsets of the text value
  contentVer?: { value: string; start: number; end: number };
  hasContentId: boolean;
}
findDrawioMacros(storage: string): DrawioMacroRef[]

bumpDrawioRevision(storage: string, opts: {
  diagramName: string; pageId: string; newRevision: number; bumpContentVer: boolean;
}): {
  body: string;
  updated: number;                     // macros changed
  alreadyCurrent: number;              // revision already ≥ newRevision
  skipped: { reason: "other-page" | "no-revision-param" | "revision-ahead"; diagramName: string }[];
}
```

Rules:
- Match only `<ac:structured-macro ac:name="drawio" …>`. The attribute order
  may vary and other attributes may appear. `inc-drawio` (an embed from
  another page) is never touched.
- Compare `diagramName` after decoding XML entities on both sides. The value
  must be identical: no trimming and no case folding.
- A macro whose `pageId` parameter names another page shows that page's
  attachment. Skip it (`other-page`).
- Only the text value of `revision`, and of `contentVer` when
  `bumpContentVer` is set, is replaced. The edits are spliced by offset from
  right to left. **Every byte outside those value spans is unchanged.**
- A missing `revision` parameter is reported, not inserted (P0 #2 decides
  whether to insert it).
- A `revision` higher than `newRevision` means a newer upload happened
  elsewhere. Skip it and report it; never lower a revision.

### Gating and safety policy

| Call | Gate |
|---|---|
| `add_attachment` with `overwrite: false` (default) | Unchanged |
| `add_attachment` with `overwrite: true` | `overwrite` joins `listDestructiveFlagsSet`; `validateSource`, then confirm_token/`gateOperation` as in `update_page` |
| `update_drawio_diagram` | `validateSource(source, ["update_drawio_diagram", …flags])` always (the tool *is* an overwrite; `validateSource` only blocks when the list is non-empty, so the tool name goes in it, as `delete_page` does); the elicitation gate only when `confirm_shrinkage` is set (see below) |

Why the two tools differ: `add_attachment` is a create tool that agents call
casually, and a flag that turns it into a replace on any file type (PDFs,
spreadsheets) warrants a prompt. `update_drawio_diagram` names its intent,
refuses to create, keeps the old version in Confluence's history, and works
like an ungated `update_page`. That is the recommendation; see Decisions.

**Diagram shrinkage guard** (the attachment counterpart of
`confirm_shrinkage`):
- The tool downloads the current version, if it is under the 10 MB cap, and
  counts the `<mxCell` elements in the old and new XML.
- If the new XML has fewer than half as many cells, the tool refuses unless
  `confirm_shrinkage: true` is set. That flag is then gated like any other
  destructive flag.
- A compressed `<diagram>` payload (deflate+base64) is inflated before
  counting. If it cannot be inflated, or the old file is over the cap, the
  guard is skipped and a note appears in the result. It never blocks silently
  and never passes silently.

**Input validation:** the new XML must start with `<mxfile` or
`<mxGraphModel`, after optional leading whitespace and an XML declaration.
This catches uploading the wrong file. It is not a schema check.

### `update_drawio_diagram`

```ts
{
  page_id: z.string(),
  diagram_name: z.string(),            // exact attachment title / macro diagramName; NO ".drawio" appended
  diagram_xml: z.string().optional(),
  file_path: z.string().optional(),    // exactly one of xml / file_path; same cwd+realpath rule as add_attachment
  expected_version: z.number().int().positive().optional(),
  version_message: z.string().max(500).optional(),
  confirm_shrinkage: z.boolean().default(false),
  source: …, confirm_token: …,         // as on the other destructive tools
}
```

Order of operations:
1. `writeGuard`, `checkSpaceAllowed`, `validateSource`. Resolve and read
   `file_path`, or take the inline XML. Run the mxfile sanity check. Compute
   the SHA-256 of the bytes.
2. `findAttachmentByName`. If it returns null, refuse:
   `No attachment named "…" on page …`, listing up to 10 `.drawio` and
   `application/vnd.jgraph.mxfile` names on the page as hints. If
   `expected_version` is set and does not match, refuse and show both
   versions.
3. `getPage(page_id, true)`. Plan the macro bump with
   `newRevision = current + 1` (dry run). Run the shrinkage guard and the
   gate.
4. `uploadAttachmentVersion`. Take the **returned** version as the truth. If
   it is not `current + 1`, someone else uploaded in between: the result says
   so, and the bump uses the returned number.
5. If the dry run matched no macro, stop. Report that the page was not
   modified and name the `inc-drawio` caveat.
6. Otherwise run `bumpDrawioRevision` on the body from step 3, then
   `safePrepareBody` (scope `full`) and `safeSubmitPage` with the page
   version from step 3. The version message defaults to
   `Updated diagram: <name> (attachment v<n>)`. On a version conflict, re-read
   the page, recompute the bump on the fresh body and submit **once** more.
   A second conflict fails with a partial-state message.
7. Add the attribution label and the unverified badge, as `add_drawio_diagram`
   does.

The result lists the attachment id, the old and new attachment versions, the
SHA-256 of the uploaded bytes, the macros updated, skipped and already
current, and the old and new page versions. It ends with the tenant echo.

**Partial-state messages:** these cases must never read as "nothing
happened".
- Upload `WriteOutcomeUnknownError`: no page step; tell the caller to run
  `get_attachments` and check the version before retrying.
- Upload succeeded, page step failed: the message names the new attachment
  version, says the page still shows the old revision, and gives the exact
  recovery (re-run the tool: the attachment step uploads one more version,
  which is harmless, or edit `revision` with `update_page_section`).

### `add_attachment` with `overwrite`

- With `overwrite: false`, the tool keeps today's behaviour (create). When
  Confluence returns the duplicate-name 400, the error now ends with: `Pass
  overwrite: true to upload a new version, or use update_drawio_diagram for a
  diagram shown on the page.`
- With `overwrite: true`, the tool calls `findAttachmentByName`. If the
  attachment exists, it runs `expected_version` (optional), then
  `uploadAttachmentVersion`. If not, it creates the file as before. The
  result says which of the two happened.
- The result always includes `version: N`.
- `add_drawio_diagram` is unchanged apart from its 400 message, which now
  points at `update_drawio_diagram`.

### `get_version` stale notice (W4)

`pendingUpdate` lives in a state file that every installed copy shares. A
record written by v6.10.0 survives an upgrade to v7.1.0. Fix it in
`getPendingUpdate()`: drop the record (and clear it from the file) when
`pending.current` is not the running `__PKG_VERSION__`, or when
`pending.latest` is not newer than the running version. Test: a record for
an older `current` is not reported and is cleared, and a valid record still
is.

## Unknowns: P0 live probe

Unit tests stub `fetch`, so they cannot settle these. Read-only questions
come first. Write questions need the maintainer's permission for each run
and go **only** to a scratch page in the personal space (`~…`).

| # | Question | Kind | Drives |
|---|---|---|---|
| 1 | What does a UI-created draw.io diagram look like? Attachment title (with or without `.drawio`), media type, a sibling `.png` preview attachment, and the full macro parameter set (`contentId`?) | read | Name matching; whether a stale PNG matters |
| 2 | Is `revision` the attachment version? What is `contentVer`: the attachment version, or the version of a draw.io custom-content object referenced by `contentId`? | read + one write | **`bumpContentVer` default.** If it tracks custom content, raising it could break rendering, so leave it alone |
| 3 | Response shape of `POST …/child/attachment/{id}/data` (bare object vs `results[]`; `version.number` present?) | write | W1 schema |
| 4 | Is the `minorEdit` form field required on that endpoint? Does `false` send watch notifications? | write | Multipart fields |
| 5 | Is `?filename=` an exact, case-sensitive match? | read | Local re-check (kept regardless) |
| 6 | After a bump, does the page render the new revision in the browser? Is an `inc-drawio` on another page stale? | write + visual (Chrome) | Done criterion; the caveat text |

P0 runs before W1's schema is final. W2 can start at once with
`bumpContentVer` as a parameter; P0 #2 only sets its default.

**P0 answers (read-only part, 2026-10-07, about 12 GET requests):**

1. **Two kinds of macro exist.** Diagrams made by `add_drawio_diagram`
   (and the agent-made ones in the catalyst) have `diagramName`, `pageId`,
   `contentVer` = `revision` = 1, no `custContentId`, an attachment with
   media type `application/octet-stream`, and no `.png` sibling. A diagram
   saved in the draw.io editor has `custContentId` (a draw.io custom-content
   object), `mVer`, `contentVer` = `revision` = attachment version (4 in the
   sample), media type `application/vnd.jgraph.mxfile`, a `<name>.png`
   preview at the same version, and editor drafts named `~<name>.tmp` and
   `~drawio~<account>~<name>.tmp`. An older editor macro has no `contentVer`
   but does have the `.png` preview.
2. **`contentVer` tracks `revision`** in every sample, but on editor
   diagrams it sits next to `custContentId`, and the renderer may read the
   custom-content object rather than the attachment. Raising `revision`
   alone there could leave the page showing the old diagram, and a stale
   `.png` preview could do the same. **Decision:** the tool supports only
   diagrams with no `custContentId`/`contentId` on any matching macro and no
   `<name>.png` sibling attachment, and refuses the rest *before any write*,
   telling the user to edit those in the draw.io editor. On a supported
   macro, `contentVer` is raised together with `revision` when it is present
   and equal to the old `revision` value (they move together in every
   sample); otherwise it is left alone. Relaxing the refusal needs the write
   probe below.
3. *Not probed (needs a write).* The client accepts both response shapes.
4. *Not probed (needs a write).* Send `minorEdit=false` so watchers are
   notified (security review M7).
5. **`?filename=` is case-insensitive but not a prefix match:**
   `Example.drawio` returned `example.drawio`, and
   `example` returned nothing. The exact local re-check is therefore
   required. A case-only mismatch is refused with a "did you mean" hint.
6. *Not probed (needs a write and a browser).* `inc-drawio` embeds carry
   their own `pageId`/`diagramName` and no `revision`, so the tool never
   touches them; the docs name the possible staleness.

The write questions (3, 4, 6) stay open for the E2E run, which needs the
maintainer's permission for that run.

## Security review (2026-10-07)

A `security-reviewer` pass over this plan and the code it touches. Every
finding is accepted. Where these rules differ from the text above, they win.

| Sev | Finding | Change |
|---|---|---|
| High | **H1.** `validateSource` blocks only when the flag list is non-empty, so "always" was a no-op | Pass `["update_drawio_diagram", …flags]`, and `["overwrite"]` for `add_attachment` (gating table updated) |
| High | **H2.** `add_attachment` uploads any file under cwd (`.env`, `.git/config`), reads it whole with no cap, and re-opens it by path after `realpath` | `resolveUploadPath` + `readUploadFile`: refuse dot-segments under cwd (as `download_attachment` does), open with `O_NOFOLLOW`, `fstat` the handle, require a regular file of at most 10 MB, read from the handle. Applies to `add_attachment` too (a behaviour change, listed in the changelog) |
| Med | **M1.** Inflating a compressed `<diagram>` payload is a zip bomb | `inflateRawSync(…, { maxOutputLength: 64 MB })`; over the limit → guard skipped *with a note*; count with `indexOf`, not a regex |
| Med | **M2.** Regex macro parsing matches examples inside CDATA (code macros) and comments | Mask `<![CDATA[…]]>` and `<!-- … -->` with same-length filler before scanning; skip a match that contains a nested `<ac:structured-macro`; splice only values matching `^\d+$`; decode the five named entities and numeric references; `indexOf` scanning, no backtracking regex |
| Med | **M3.** Tenant text unfenced (hint names, response titles, `get_attachments`) | Fence hint names and `get_attachments` titles; echo the caller's `diagram_name`, never the response title; reject control characters in `diagram_name` |
| Med | **M4.** "On a version conflict" was too broad | Rebase once only on `ConfluenceConflictError`. Unexpected-conflict, approval-required and outcome-unknown errors stop with the partial-state message. If the fresh body is already current, skip the PUT |
| Med | **M5.** Attachment uploads are not mutation-logged | Log an `update_attachment` record (page, attachment id, old → new version, SHA-256, source, outcome) |
| Med | **M6.** The shrinkage download should confirm the container | Refuse unless the attachment's `pageId` is `page_id` |
| Med | **M7.** A silent overwrite hides a coerced agent | `minorEdit=false`, so watchers are notified |
| Low | **L1.** Residual risk of the gating choice | Stated in Decisions: an injected instruction can replace a same-size diagram without a prompt; history, the mutation log, notifications and the unverified badge are the backstops |
| Low | **L2.** XML handling | Never parse with an XML parser; the sanity check rejects `<!DOCTYPE` and `<!ENTITY` |
| Low | **L3.** State-file record | Done in 45e3535: the record must be valid semver and newer, or it is dropped |
| Low | **L4.** Name into URL | `URLSearchParams` encodes it; the name is never written into the macro |

## Contracts (fixed before the lanes start)

The signatures in the Design section, plus:

```ts
// source-provenance.ts
listDestructiveFlagsSet({ …, overwrite?: boolean })      // pushes "overwrite"

// shared helper extracted from add_attachment (W3)
resolveUploadPath(file_path: string): Promise<string>    // realpath, under cwd, else throws
```

## Workstreams

```
P0 probe (read part) ──┐
W2 pure core ──────────┼─► W3 handlers (3 commits) ─► W6 review ─► E2E
P0 ─► W1 client ───────┘   W5 docs (parallel with W3)
W4 get_version fix ── independent, any time
```

At most two agents run tests at the same time. Each agent does one scoped
run at a time: `npx vitest run --maxWorkers=2 <files>`.

### P0 · orchestrator (Opus), with the user
- **Tenant:** only the profile set as `CONFLUENCE_PROFILE` in the local,
  gitignored `.mcp.json`. Check its host before the first call. Never write
  the profile name or host into this repo; it is public.
- **That tenant is a production wiki.** Use about 15 requests, all small and
  hand-run. Use no loops and no CI.
- **Writes:** before any upload, ask the maintainer and list what will be
  created. Use one scratch page in the personal space, and delete it
  afterwards with confirmation.
- Record the answers in this file before W1 starts.

### W1 · Sonnet, high: client
- In `confluence-client.ts`: `findAttachmentByName`,
  `uploadAttachmentVersion`, `version` on `AttachmentSchema`, `expand=version`
  in `getAttachments`, and `version` from `uploadAttachment`.
- Tests in `confluence-client.test.ts`:
  - exact-match re-check (the server returns a near-miss → `null`);
  - the URL encodes a filename with spaces and unicode;
  - both response shapes parse;
  - a 2xx with an unparseable body → `WriteOutcomeUnknownError`;
  - a timeout after send → unknown, never retried;
  - the multipart fields include the comment and `minorEdit`.

### W2 · Sonnet, high: pure core
- New `src/server/drawio-macro.ts` plus tests. Use fast-check with fixed
  seeds.
- Properties:
  - outside the replaced value spans, the output equals the input byte for
    byte;
  - `bump(bump(x)) == bump(x)`;
  - a body with no matching macro is returned unchanged (`===`);
  - a revision is never lowered;
  - `inc-drawio` and other macros are never modified (fuzz with them
    interleaved);
  - attribute order and whitespace variants are found.
- Examples:
  - entity-encoded names (`&amp;`);
  - two macros for the same diagram;
  - a macro with a different `pageId`;
  - a missing `revision`;
  - `contentVer` present or absent, with `bumpContentVer` on and off;
  - a name that is a prefix of another name (`a.drawio` vs `a.drawio.bak`).
- Shrinkage helpers: `countMxCells(xml)` with compressed-payload inflation,
  and `looksLikeDrawioXml(text)`.

### W3 · Opus, high: handlers and wiring (after W1 and W2)
- **Commit 1, `get_attachments`:** add a `vN` column. Fence the titles if
  they are not fenced yet (they are tenant text: check against the T5 rule
  in `search_pages`).
- **Commit 2, `add_attachment overwrite`:**
  - add the `overwrite` and `expected_version` parameters;
  - add the `overwrite` flag to `listDestructiveFlagsSet`, plus the gate;
  - extract `resolveUploadPath`;
  - improve the duplicate-name error.
- **Commit 3, `update_drawio_diagram`:** the tool as specified above.
  - Register it with `destructiveTool("Update draw.io diagram")` and
    `describeWithLock(withDestructiveWarning(…))`.
  - Add it to `WRITE_TOOLS`, `KNOWN_TOOLS` and `tool-surface.test.ts`.
  - Add an integration test modelled on
    `update-page-sections.integration.test.ts`:
    - happy path (one upload, then one page PUT whose body differs only in
      the revision);
    - missing attachment → no write at all;
    - `expected_version` mismatch → no write;
    - shrinkage refusal, and acceptance when confirmed;
    - `source=chained_tool_output` → `SOURCE_POLICY_BLOCKED`;
    - zero matching macros → upload only;
    - page 409 → one rebase, then success;
    - two 409s → a partial-state message that names the attachment
      version;
    - upload `WriteOutcomeUnknownError` → no page call;
    - read-only profile → not registered.

### W4 · Sonnet, medium: `get_version` stale notice (independent)
`src/shared/update-check.ts` plus `update-check.test.ts`, as above. Ship it
as its own commit; the fix can go out in a patch release ahead of the
feature.

### W5 · Sonnet, medium: docs (parallel with W3)
- `doc/user-doc/tools-reference.md`, `doc/design/03-tools.md`, the tool list
  and count in `README.md`, and `CHANGELOG.md`.
- In `install-agent.md`, a short recipe: revise a diagram with
  `download_attachment`, edit it, then `update_drawio_diagram`.
- In `doc/destructive-flag-prompts.md`, add `overwrite` and the diagram
  `confirm_shrinkage`.
- Name the `inc-drawio` caveat plainly: an embed on other pages may stay
  stale until someone saves the diagram in the editor.

### W6 · review
- The `test-critic` agent reviews the W1–W3 tests.
- An Opus/high data-loss review of the full diff covers every case in the
  assessment below. Each case needs a test, or a written reason why none is
  possible.
- Findings are fixed by the agent that owns the lane.

### E2E · orchestrator, with the user
These checks use the same tenant and the same limits as P0, and every write
needs permission for that run. The target is one scratch page in the
personal space.
1. Run `add_drawio_diagram` (v1).
2. Run `update_drawio_diagram` with changed XML. The attachment goes to v2,
   the page revision to 2, and the browser (Chrome) shows the new diagram.
3. Re-run with `expected_version: 1` and confirm the refusal.
4. Run `add_attachment` with `overwrite: true` on a text file twice, and
   confirm v1 → v2.
5. Run `get_attachments` and confirm the versions it shows.
6. Delete the scratch page, after confirming with the maintainer.

Lane agents never call a live tenant. Fixtures stay neutral
(`example.com`, `DOCS`/`TEAM`, `example.drawio`). Nothing is pushed or
published without asking.

## Model and effort summary

| Task | Model | Effort |
|---|---|---|
| P0, E2E, full-suite run | orchestrator (Opus) | – |
| W1 client, W2 pure core | Sonnet | high |
| W3 handlers, gating, partial-state paths | Opus | high |
| W4 `get_version` fix | Sonnet | medium |
| W5 docs | Sonnet | medium |
| W6 data-loss review | Opus | high |
| W6 test critique | test-critic agent | – |

## Data-loss and safety assessment

| Risk | Mitigation |
|---|---|
| Wrong attachment overwritten (prefix or fuzzy server match, case) | Exact local title re-check; update refuses to create; `expected_version` |
| Concurrent UI edit of the diagram overwritten | `expected_version`; the returned version is checked against `current + 1` and a mismatch is reported. A TOCTOU window remains between the check and the POST (the endpoint has no If-Match), but the prior version stays in history |
| Agent replaces a rich diagram with a stub | mxfile sanity check; cell-count shrinkage guard with gated `confirm_shrinkage` |
| Macro rewrite corrupts the page body | Offset splice of value spans only; byte-identity property test; the body still goes through `safePrepareBody` / `safeSubmitPage` content guards and the mutation log |
| Page edited between read and write | Bump recomputed on the fresh body (pure, parameter-only) exactly once; never a blind PUT of a stale body |
| Upload outcome unknown | No retry, no page step; explicit "check before retrying" message |
| Upload succeeded, page write failed | Stale, not lost: the macro still pins the old revision. The message names both versions and the recovery |
| Revision lowered or another page's macro edited | Never lower; skip a macro whose `pageId` differs; `inc-drawio` never touched |
| `contentVer` misread breaks rendering | Default decided by P0 #2; E2E browser check |
| Prompt injection sets `overwrite` | Destructive-flag warning, `validateSource`, gate; `chained_tool_output` blocked |
| `file_path` reads outside the workspace | Shared `resolveUploadPath` (realpath under cwd) |
| Cross-tenant write | Unchanged `checkSpaceAllowed`, tenant echo in every result |

## Out of scope (follow-ups)

- Refreshing `inc-drawio` previews on other pages. The preview state is
  owned by the draw.io app; record this as a caveat.
- Regenerating the `.png` preview attachment, if P0 #1 finds one.
- `batch_token` support for the new tool. Add it if a fan-out use case
  appears.
- Content hashes in `get_attachments` (this would need a download per file).

## Decisions (open, for the maintainer)

1. **Gating:** gate `add_attachment overwrite:true` with an elicitation
   prompt, and gate `update_drawio_diagram` only when `confirm_shrinkage` is
   set (recommended, and implemented). The alternative is to gate the new
   tool on every call, as `revert_page` does. Residual risk (security review
   L1): an injected instruction can replace a diagram of similar size with
   attacker content without a prompt. The backstops are the attachment's
   version history, the mutation log, watcher notifications
   (`minorEdit=false`), the unverified badge, and the `chained_tool_output`
   block.
2. **`authorise_destructive_writes`:** not in this change (recommended).
3. **Release:** W4 as a patch (7.1.1). The feature as a minor release
   (7.2.0), or folded into the planned 7.2.0 additive reads.
