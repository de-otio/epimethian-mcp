# Investigation: v1 / v2 Confluence REST parity (2026-11)

**STATUS: NOT RUN YET.** The probe is built and tested against stubbed responses only. A person
runs it by hand against the designated test profile, then pastes the output below.

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

Paste the Markdown printed on stdout under each heading. The table below is the template: the
same header the script prints, with every row marked "not run yet".

### Site mode

(Paste the run summary and both tables here. Template:)

### Parity matrix

| # | Row | v1 call | v2 call | Site: v1 | Site: v2 | Site: parity | Gateway: v1 | Gateway: v2 | Gateway: parity | Expected v2 scope | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 | Attachment list | GET content/{id}/child/attachment | GET /pages\|blogposts/{id}/attachments | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:attachment:confluence |  |
| R2 | Attachment download | GET content/{id}/child/attachment/{attId}/data | GET downloadLink (v2 attachment) | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:attachment:confluence |  |
| R3 | Attachment upload | POST content/{id}/child/attachment | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a | write; never probed |
| R4 | Attachment new version | POST content/{id}/child/attachment/{attId}/data | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a | write; never probed |
| R5 | Version list | GET content/{id}/version | GET /pages\|blogposts/{id}/versions | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:page:confluence (blog posts: read:blogpost:confluence) |  |
| R6 | Version authors | inline in R5 | POST /users-bulk | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:user:confluence | POST read; not probed by the GET/HEAD-only rule |
| R7 | Historical body | GET content/{id}?version=N&expand=body.storage | GET /pages\|blogposts/{id}?version=N&body-format=storage | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:page:confluence (blog posts: read:blogpost:confluence) |  |
| R8 | Labels read | GET content/{id}/label | GET /pages\|blogposts/{id}/labels | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:label:confluence |  |
| R9 | Labels write | POST/DELETE content/{id}/label | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a | write; never probed |
| R10 | Content state read | GET content/{id}/state | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a |  |
| R11 | Content state write | PUT/DELETE content/{id}/state | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a | write; never probed |
| R12 | CQL search | GET /search | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a |  |
| R13 | User search | GET /search/user | none (POST /users-bulk by id only) | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a |  |
| R14 | Write-capability probe | GET user/current/permission/space/{key} | GET /spaces/{id}/operations | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:space:confluence |  |
| R15 | Site locale | GET settings/systemInfo | none | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | n/a |  |
| R16 | Connection check | GET user/current | GET /spaces?limit=1 | not run yet | not run yet | not run yet | not run yet | not run yet | not run yet | read:space:confluence |  |

### Historical bodies (R7)

| Item | Version | v1 status | v2 status | v1 sha256 (first 12) | v2 sha256 (first 12) | Byte-identical | v2 echoes version |
|---|---|---|---|---|---|---|---|
| not run yet | | | | | | | |

### Gateway mode

(Not verified: no scoped token yet. Paste the gateway run here, replacing this line. The table
shape is the same as above.)

## Findings

Not run yet. Fill in after the runs:

- Parity counts per row.
- Historical bodies: byte-identical n/N; v2 echoed the version n/N.
- Gateway: v1 GETs that answer 410, and v1 GETs that do not.
- Scope list: the minimum granular scopes per v2 read, and corrections to the list in plan
  section 5.3 item 7.
- Decisions this unlocks: the `revert_page` switch (needs 30/30 byte-identical), the
  `probeWriteCapability` swap, and each "to be confirmed" gateway-table row.
