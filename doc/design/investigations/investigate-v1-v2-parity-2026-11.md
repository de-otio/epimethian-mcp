# Investigation: v1 / v2 Confluence REST parity (2026-11)

**STATUS: site mode run 2026-11-22 (results below); gateway mode not run yet.** A person runs
the probe by hand against the designated test profile and pastes the output below.

**Gateway mode is not live-verified** until both the gateway run of this probe and the
scoped-token check (question 4) have run. Until then every gateway claim in the docs is a
design assumption.

Plan: `plans/next-release-sdk2-and-v2-api.md` section 5.1 (W-INV), with the call inventory in
section 5.4 and the gateway capability table in section 5.3. Until results are in, the
conservative defaults in section 11 of the plan apply: `revert_page` stays on v1 in site mode,
`probeWriteCapability` keeps its v1 call in site mode, and every gateway-table row marked "to be
confirmed" is treated as unavailable.

## Questions this answers

1. For each inventory row with a read: do v1 and v2 return the same status, result count,
   ordering and the fields our schemas read?
2. Historical bodies: is the v2 storage body byte-identical to v1's for each sampled version,
   and does v2 echo `version.number === N`? (Investigation open question 2; gates the
   `revert_page` switch, W-HIST.)
3. Gateway mode (scoped token): which v1 GETs answer 410, and does each v2 read pass with the
   expected granular scope?
4. Scoped-token check: does a scoped token work against a second cloudId (another site the same
   Atlassian account can see) through `https://api.atlassian.com/ex/confluence/{otherCloudId}`?
   Expected: yes. The tenant guard does not rely on the token being bound to one site
   (`doc/design/gateway-mode.md` §9 item 1); a "no" would add a third leg, a "yes" confirms the
   per-customer-account recommendation. Run it read-only (one `GET /spaces?limit=1`), only
   against sites the account owner has approved for the check.

## Method

Script: `scripts/live/v2-parity.mjs` (logic in `scripts/live/v2-parity-lib.mjs`, tests in
`scripts/live/v2-parity.test.mjs`). Opt-in; never run in CI; no test loads credentials.

Run it by hand, one mode at a time, against the designated test profile:

```
# Site mode (Basic auth to the site URL)
node scripts/live/v2-parity.mjs --profile <profile> \
  --pages <id1,id2,id3,id4,id5> --blogposts <id1,id2> --versions 6

# Gateway mode (only with a scoped, read-only token and a sealed cloudId on the profile)
node scripts/live/v2-parity.mjs --profile <profile> --gateway \
  --scopes read:page:confluence,read:space:confluence \
  --pages <id1,id2,id3,id4,id5> --blogposts <id1,id2> --versions 6
```

Ids to choose (plan section 5.1): at least 5 pages (one with macros and tables, one with a
draw.io diagram, one with more than 25 versions, one converted from the legacy editor, one with a
restore in its history) and 2 blog posts.

Safety properties, enforced in code and covered by the tests:

- GET and HEAD only. The request helper throws on any other method before a request is counted
  or sent. Writes are never probed, in either mode.
- Low volume: sequential, a delay of at least 100 ms (default 400 ms) between requests, at most
  150 requests per run (the run refuses to start if its worst case exceeds that), at most 30
  sampled versions in total, and a stop on HTTP 429.
- The credential goes only to the site origin (site mode) or the sealed gateway prefix
  (gateway mode). Redirects are followed by hand and the credential is dropped when a redirect
  leaves that prefix.
- Output is counts, statuses, booleans and short SHA-256 prefixes only. Pages and blog posts
  appear as `p1..` and `b1..` in run order. Bodies, titles, names, space keys and hosts are
  compared in memory and never printed. Progress and the request total go to stderr.
- Gateway mode asks v1 once per row (the question there is "410 or not"); v2 is read for every
  id and sampled version.

Worst-case request count: site mode is 15 + 7 per id + 2 per sampled version, so 5 pages and 2
blog posts with the default 6 versions per id (30 sampled in total) is at most 124. Gateway mode
is 20 + 3 per id + 1 per sampled version, so at most 71 for the same set.

What the script does not cover:

- R6: `POST /users-bulk` is a POST read, so the GET/HEAD-only rule excludes it. Verify it by hand
  if it is needed.
- The minimum granular scope per v2 read. The script records each v2 status and prints the
  scopes the person running declares with `--scopes`; to find a minimum, run gateway mode again
  with a token that has fewer scopes and compare which rows pass. The "Expected v2 scope" column
  is the starting hypothesis from plan section 5.3.
- Token expiry: Atlassian is believed not to expose it through the REST API; confirm by hand.

## Results

### Site mode

Run by hand on 2026-11-22 against the designated test profile, read-only. Items:
5 pages (one with a draw.io diagram, two with 18 and 20 versions, two recently edited
pages with tables and macros) and 2 blog posts. Not covered: a page with more than 25
versions, a page converted from the legacy editor, and a page with a restore in its history.

#### Run summary

- Mode: site
- Date: 2026-11-22
- Items: 5 page(s), 2 blog post(s)
- Requests: 113 of a cap of 150 (GET/HEAD only)
- Versions sampled: 27 (cap 30)
- Run status: complete

#### Parity matrix

| # | Row | v1 call | v2 call | Site: v1 | Site: v2 | Site: parity | Gateway: v1 | Gateway: v2 | Gateway: parity | Expected v2 scope | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 | Attachment list | GET content/{id}/child/attachment | GET /pages\|blogposts/{id}/attachments | 200x7 | 200x7 | count 7/7; fields 7/7; order: samex3, reversedx1, different-orderx3; paging: single-pagex7 | not run in this mode | not run in this mode | - | read:attachment:confluence |  |
| R2 | Attachment download | GET content/{id}/child/attachment/{attId}/data | GET downloadLink (v2 attachment) | 405x1 | 200x1 | - | not run in this mode | not run in this mode | - | read:attachment:confluence |  |
| R3 | Attachment upload | POST content/{id}/child/attachment | none | not probed (write) | not probed (write) | - | not probed (write) | not probed (write) | - | n/a | write; never probed |
| R4 | Attachment new version | POST content/{id}/child/attachment/{attId}/data | none | not probed (write) | not probed (write) | - | not probed (write) | not probed (write) | - | n/a | write; never probed |
| R5 | Version list | GET content/{id}/version | GET /pages\|blogposts/{id}/versions | 200x7 | 200x7 | count 7/7; fields 7/7; order: samex7; paging: single-pagex7 | not run in this mode | not run in this mode | - | read:page:confluence (blog posts: read:blogpost:confluence) |  |
| R6 | Version authors | inline in R5 | POST /users-bulk | - | not probed (POST) | - | - | not probed (POST) | - | read:user:confluence | POST read; not probed by the GET/HEAD-only rule |
| R7 | Historical body | GET content/{id}?version=N&expand=body.storage | GET /pages\|blogposts/{id}?version=N&body-format=storage | 200x27 | 200x27 | hash 27/27; echo 27/27 | not run in this mode | not run in this mode | - | read:page:confluence (blog posts: read:blogpost:confluence) |  |
| R8 | Labels read | GET content/{id}/label | GET /pages\|blogposts/{id}/labels | 200x7 | 200x7 | count 7/7; fields 7/7; order: samex7; paging: single-pagex7 | not run in this mode | not run in this mode | - | read:label:confluence |  |
| R9 | Labels write | POST/DELETE content/{id}/label | none | not probed (write) | not probed (write) | - | not probed (write) | not probed (write) | - | n/a | write; never probed |
| R10 | Content state read | GET content/{id}/state | none | 200x7 | n/a (no v2) | state: state-setx7 | not run in this mode | not run in this mode | - | n/a |  |
| R11 | Content state write | PUT/DELETE content/{id}/state | none | not probed (write) | not probed (write) | - | not probed (write) | not probed (write) | - | n/a | write; never probed |
| R12 | CQL search | GET /search | none | 200x1 | n/a (no v2) | - | not run in this mode | not run in this mode | - | n/a |  |
| R13 | User search | GET /search/user | none (POST /users-bulk by id only) | 200x1 | n/a (no v2) | - | not run in this mode | not run in this mode | - | n/a |  |
| R14 | Write-capability probe | GET user/current/permission/space/{key} | GET /spaces/{id}/operations | 404x1 | 200x1 | - | not run in this mode | not run in this mode | - | read:space:confluence |  |
| R15 | Site locale | GET settings/systemInfo | none | 200x1 | n/a (no v2) | - | not run in this mode | not run in this mode | - | n/a |  |
| R16 | Connection check | GET user/current | GET /spaces?limit=1 | 200x1 | 200x1 | - | not run in this mode | not run in this mode | - | read:space:confluence |  |

#### Historical bodies (R7)

| Item | Version | v1 status | v2 status | v1 sha256 (first 12) | v2 sha256 (first 12) | Byte-identical | v2 echoes version |
|---|---|---|---|---|---|---|---|
| p1 | 1 | 200 | 200 | 0e640c3dc7c8 | 0e640c3dc7c8 | yes | yes |
| p1 | 2 | 200 | 200 | 0e640c3dc7c8 | 0e640c3dc7c8 | yes | yes |
| p1 | 3 | 200 | 200 | c7dfe2de0e4a | c7dfe2de0e4a | yes | yes |
| p2 | 1 | 200 | 200 | d50551c273a7 | d50551c273a7 | yes | yes |
| p2 | 2 | 200 | 200 | d50551c273a7 | d50551c273a7 | yes | yes |
| p2 | 3 | 200 | 200 | 9d49ec6cb912 | 9d49ec6cb912 | yes | yes |
| p2 | 4 | 200 | 200 | 027f2b859f53 | 027f2b859f53 | yes | yes |
| p2 | 5 | 200 | 200 | d1b8e01c26a7 | d1b8e01c26a7 | yes | yes |
| p3 | 1 | 200 | 200 | 553532ed3298 | 553532ed3298 | yes | yes |
| p3 | 7 | 200 | 200 | e0c83b4ded6a | e0c83b4ded6a | yes | yes |
| p3 | 14 | 200 | 200 | 8c6d624d35cb | 8c6d624d35cb | yes | yes |
| p3 | 20 | 200 | 200 | a50eac09bb86 | a50eac09bb86 | yes | yes |
| p4 | 1 | 200 | 200 | 9042807ceb8c | 9042807ceb8c | yes | yes |
| p4 | 7 | 200 | 200 | fb2b1f17b82e | fb2b1f17b82e | yes | yes |
| p4 | 12 | 200 | 200 | 5b6d38b3d2d7 | 5b6d38b3d2d7 | yes | yes |
| p4 | 18 | 200 | 200 | 1ce166d4282a | 1ce166d4282a | yes | yes |
| p5 | 1 | 200 | 200 | badbeb2644d5 | badbeb2644d5 | yes | yes |
| p5 | 2 | 200 | 200 | badbeb2644d5 | badbeb2644d5 | yes | yes |
| p5 | 3 | 200 | 200 | e5b3ba84dfd3 | e5b3ba84dfd3 | yes | yes |
| b1 | 1 | 200 | 200 | d0d1ce7eaf01 | d0d1ce7eaf01 | yes | yes |
| b1 | 2 | 200 | 200 | ce82adde7c71 | ce82adde7c71 | yes | yes |
| b1 | 4 | 200 | 200 | d742fed4b4ec | d742fed4b4ec | yes | yes |
| b1 | 5 | 200 | 200 | 12a213677338 | 12a213677338 | yes | yes |
| b2 | 1 | 200 | 200 | 245d8112c235 | 245d8112c235 | yes | yes |
| b2 | 3 | 200 | 200 | 1d1d4f6785c5 | 1d1d4f6785c5 | yes | yes |
| b2 | 4 | 200 | 200 | bb0d200e7c67 | bb0d200e7c67 | yes | yes |
| b2 | 6 | 200 | 200 | 03c7def9f39b | 03c7def9f39b | yes | yes |

Byte-identical: 27/27 compared. v2 echoed the requested version: 27/27.

### Gateway mode

(Not verified: no scoped token yet. Paste the gateway run here, replacing this line. The table
shape is the same as above.)

## Findings

Site mode (2026-11-22):

- **Historical bodies (R7):** byte-identical 27/27; v2 echoed the requested version 27/27,
  across 5 pages and 2 blog posts, versions 1 to 20. No restored or legacy-converted version was
  in the sample.
- **Attachments (R1):** same count and fields 7/7. Order differs on 4 of 7 items (v1 and v2 sort
  differently). No write depends on list order: lookups match by exact name over the whole
  current list. `get_attachments` output order differs from 7.5.0.
- **Versions (R5):** same count, fields and order 7/7 (v2's default order matches v1, so no
  `sort` parameter is needed; plan finding F6 does not apply on this tenant).
- **Labels (R8):** same count, fields and order 7/7.
- **Download (R2):** v1 `child/attachment/{attId}/data` answers 405; the v2 `downloadLink`
  answers 200.
- **Write-capability probe (R14):** v1 `user/current/permission/space/{key}` answers 404, so
  `probeWriteCapability` always uses its dry-run fallback today. v2 `/spaces/{id}/operations`
  answers 200: a candidate for a later swap (not in 7.6.0).
- **Not checked by this run:** `status=current` on attachment lists and the `status` field
  (added after the probe was written), R6 `users-bulk` (POST).

Decisions:

- `revert_page` stays on the v1 historical read in site mode for 7.6.0. The sample is 27
  versions, not the 30 the plan asks for, and has no restored or legacy-converted version; v1
  still works in site mode, so there is no reason to switch yet. Gateway mode uses v2 with the
  fail-closed checks.
- `probeWriteCapability` keeps its current order (v1 permission call, then the dry-run).

Gateway mode: not run (no scoped token yet). Question 4 (a scoped token against a second
cloudId): not run.

## v2 response-shape assumptions to confirm (W-V2READ, W-HIST)

The 7.6.0 read swaps are written and tested against these shapes (stubbed `fetch` only). Each
must be confirmed by a read-only run before the release ships; a wrong one fails the tool
(closed), it does not return wrong data.

1. **Attachments (R1).** `GET /pages|blogposts/{id}/attachments` items carry `id` (with the `att`
   prefix), `title`, `fileSize`, `mediaType`, `downloadLink` and `version.number` at the top level
   (not under `extensions`), and `_links.next` is either `/wiki/api/v2/...` or an absolute URL on
   the same API. Confirm `version.number` equals what v1 reported (the draw.io tools compare it
   with `expected_version`).
2. **`filename=` filter.** No longer sent on v2: the lookup reads the container's whole current
   attachment list and computes exact and case-only matches itself, so the filter's case
   semantics cannot change the result. Confirm that `status=current` is honoured and that items
   carry `status` (archived files are dropped defensively either way).
3. **Draft blog posts.** v2 attachment and label reads cannot see a never-published blog post
   draft (like `GET /blogposts/{id}` without a status). Attachment reads on drafts therefore stay
   on v1 with `status=draft`; the label read after a write treats a 404 as "no legacy label".
4. **Versions (R5).** `GET /pages|blogposts/{id}/versions` items carry `number`, `createdAt`,
   `message`, `minorEdit`, `authorId`. The default order is not assumed (the client re-sorts and
   reads the whole list when the order is not visibly newest-first); if v2 is oldest-first by
   default, add `sort=-modified-date` to avoid the full read.
5. **Authors (R6).** `POST /users-bulk` with `{"accountIds": [...]}` answers
   `{"results": [{"accountId", "displayName", ...}]}`. A failure or missing id shows the account id.
6. **Labels (R8).** `GET /pages|blogposts/{id}/labels` items carry `id`, `name`, `prefix`
   (`global`, `my`, `team`, `system`), same names and prefixes as v1.
7. **Historical bodies (R7).** `GET /pages|blogposts/{id}?version=N&body-format=storage` answers
   `id`, `title`, `version.number` (echoing N) and `body.storage.{representation, value}` with
   `representation === "storage"`. The reader is fail-closed on all four; `get_page_version` and
   `diff_page_versions` therefore stop working (with a clear error) if any is missing. Record
   whether `version.number` is echoed for every sampled version and for restored versions.
8. **`revert_page`.** Stays on the v1 historical read in site mode until the 30-version table above
   shows byte-identical bodies. Then flip `REVERT_HISTORICAL_SOURCE_SITE` in
   `src/server/historical-source.ts` to `"v2"` (one line; tests cover both values).
