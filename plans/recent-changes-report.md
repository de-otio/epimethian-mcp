# Plan: recent-changes report (`get_recent_changes`)

**Status:** implemented in 7.1.0. The additive reads planned for 7.1.0 in
`plans/field-session-findings-2026-10.md` moved to 7.2.0.

**Catalyst:** a user wants to ask the agent "give me a concise report of all
the Confluence pages that changed in the last X hours". Today that takes one
`search_pages` call, then `get_page_versions` and `diff_page_versions` for
every hit. The search output has no time or editor, the result list is
silently capped at one request, and nothing in the tool descriptions points
the agent at this recipe. With 30 changed pages it costs about 60 calls, and
a truncated list looks the same as a complete one.

## TL;DR

Two phases, both read-only:

1. **Enrich `search_pages`** (small, ships on its own): each hit gains its
   last-modified time, current version and last editor, and the result says
   when more hits exist. This takes away most of the per-page round trips for
   any "what changed" question.
2. **Add `get_recent_changes`**: one call takes a time window and returns a
   compact report, one line per page, grouped by space, with an explicit
   complete/truncated marker. A `detail` level picks how much extra work it
   does: `list` (search only), `versions` (edits and editors in the window),
   or `summary` (plus a condensed section-level diff for the first N pages).

The efficiency comes from three choices: the search request expands version
metadata so that `list` needs no per-page calls; per-page work runs through
the existing concurrency cap (`settleInChunks` + the process-wide
`Semaphore`, 6 in flight); and diffs are capped and reuse the versioned body
cache.

## Current state

| Capability | Where | Gap |
|---|---|---|
| CQL search | `search_pages`, `src/server/index.ts:2875`; `searchPages`, `src/server/confluence-client.ts:1536` | One request, no cursor paging, no `expand`; output drops time, version and editor |
| Read scoping and redaction | `resolveReadScope`, `src/server/read-scope.ts:38`; `scopeCql`, `src/server/cql-scope.ts` | Applies to `search_pages` only |
| Version list | `get_page_versions`, `src/server/index.ts:4069`; `getPageVersions`, `src/server/confluence-client.ts:1933` | Fine; v1 returns `by.displayName`, `when`, `number` |
| Version diff | `diff_page_versions`, `src/server/index.ts:4172`; `computeSummaryDiff` | Fine; verbose for a multi-page report |
| Bounded fan-out | `settleInChunks`, `src/server/request-policy.ts:220`; `DEFAULT_MAX_CONCURRENCY = 6` | Reuse as is |
| Tenant echo | `tenantEcho(config)`, `src/server/index.ts:914` | Reuse so the report names the tenant it covers |

`PageSchema` (`confluence-client.ts:575`) carries `version.number` but no
`when` or `by`. The search response has both once
`expand=content.version` is passed (to be confirmed in P0).

## Design

### Phase 1: enrich `search_pages`

- The client requests `expand=content.space,content.version` and follows
  `_links.next` until `limit` hits are collected or there are no more pages.
  It returns `{ hits, more }`.
- Per hit, the server-authored line outside the fence becomes:
  `- ID: 123, Space: DOCS, Modified: 2026-10-06T08:12:00.000Z, v14`.
  The timestamp is re-rendered by the server from the parsed time (the later
  of `lastModified` and `version.when`), so response text never reaches the
  unfenced line; an unparseable time is left out. The editor's display
  name is tenant text, so it goes **inside** the fence, as
  `Last editor: …`, next to the title.
- When `more` is true, add a final line: `More results exist. Raise limit or
  narrow the query.`
- Cap `limit` at 200 (today it is unbounded) and keep the default of 25.

### Phase 2: `get_recent_changes`

**Input schema**

```ts
{
  hours: z.number().positive().max(720).optional()
    .describe("Window length in hours, counted back from now (max 720 = 30 days)"),
  since: z.string().datetime({ offset: true }).optional()
    .describe("Window start as ISO 8601 with offset; alternative to hours"),
  spaces: z.array(z.string()).optional()
    .describe("Space keys to include (default: the profile's read_spaces, else all)"),
  all_spaces: z.boolean().default(false),           // same semantics as search_pages
  include_blogposts: z.boolean().default(true),
  detail: z.enum(["list", "versions", "summary"]).default("list"),
  limit: z.number().int().min(1).max(200).default(50),
  max_diffs: z.number().int().min(1).max(25).default(10), // summary only
}
```

Exactly one of `hours` or `since` must be set. `since` must be in the past
and no more than 720 hours ago.

**Window, without timezone traps.** CQL interprets absolute dates in the
*Confluence user's profile timezone*, not in UTC. To avoid that, the server
always sends a relative bound, `lastmodified >= now("-<N>m")`, where `N` is
the number of whole minutes since the window start plus 10 minutes of slack
(clock skew between this host and Confluence). Only hits inside that slack
band are dropped by the exact cut; a hit CQL matched with an earlier time is
kept and counted in the header (W5 review).
It then filters exactly on the client against `sinceMs`. The clock is
injected so that tests can freeze it.

**CQL** is built by a pure function and never spliced from user text:
`type in (page, blogpost)` (or `type = page` when `include_blogposts` is
false) `AND lastmodified >= now("-Nm")`
`[AND space in ("K1","K2")] ORDER BY lastmodified DESC`. Space keys go
through `escapeCqlString`. Scoping is the same as `search_pages`:

| `read_spaces` | `enforced` | `spaces` arg | `all_spaces` | Effective spaces |
|---|---|---|---|---|
| unset | – | unset | – | all |
| unset | – | set | – | `spaces` |
| set | false | unset | false | `read_spaces` |
| set | false | set | false | `spaces ∩ read_spaces`; reject if empty |
| set | false | any | true | `spaces` or all |
| set | true | ⊄ `read_spaces` | – | error naming the allowed keys |
| set | true | any | true | error (as in `search_pages`) |

`redact_patterns` applies to titles exactly as in `search_pages`.

**Per-page versions** (`detail` ≥ `versions`): call `getPageVersions(id, 50)`
for each hit, through `settleInChunks(hits, DEFAULT_MAX_CONCURRENCY, …)`.
A pure `summariseVersions(versions, sinceMs)` then:

- sorts by `number` descending, without relying on API order;
- counts the versions with `when >= sinceMs` and lists distinct editors
  (latest first, at most 3, then `+n more`);
- sets `baseline = (lowest in-window number) − 1`, or `created` when the
  lowest in-window number is 1;
- sets `atLeast: true` when all 50 fetched versions are in the window. In
  that case the true baseline is unknown, so the report says `≥50 edits` and
  the diff covers only the fetched span;
- returns `metadataOnly` when CQL matched the page but no version falls in
  the window (for example a move or restriction change). The page is still
  reported, never dropped;
- treats a `when` that does not parse as unknown and says so. It never drops
  the page.

A per-page failure (403, 404, timeout) becomes a line with
`versions unavailable (<status>)`. It never fails the whole report.

**Diffs** (`detail: "summary"`): for the first `max_diffs` pages in report
order that have a numeric baseline, diff `baseline → current` with the
existing body fetch and `computeSummaryDiff`. Then condense the result with
a pure `condenseDiff` to one line: `Changed: <sections> (+a −r)`, at most 3
sections, then `+n more`. `created` pages say `new page`. Bodies over
`MAX_DIFF_SIZE` say `too large to diff`. Pages after the first `max_diffs`
are listed without a diff, and a note says how many were skipped.

**Output contract**: plain text like the other read tools. There is one
fence per page block. Ids, space keys, timestamps, version numbers and
counts stay outside the fence; titles, editor names and section names go
inside it.

```
Changes since 2026-10-05T09:00:00Z (24h) · 3 item(s) · complete
Spaces: DOCS, TEAM

DOCS
- ID: 123456, v14, 2026-10-06T08:12:00Z, 3 edits (v12–v14)
  <fence>Title: Release checklist
  Editors: A. Editor, B. Editor
  Changed: Rollback (+4 −1), Sign-off (added)</fence>
- ID: 123999, v1, 2026-10-06T07:40:00Z, new page
  <fence>Title: Onboarding notes
  Editors: C. Editor</fence>
TEAM
- ID: 124001, v7, 2026-10-05T15:02:00Z, metadata change only (no new version)
  <fence>Title: Team calendar</fence>
<tenant echo>
```

Blog posts appear in the same list, marked `[blog]` after the ID (the type
is server-authored, so it stays outside the fence). The header counts both
types as `item(s)`.

When the hit list is truncated, the header says
`· showing 50, more exist (raise limit ≤200, narrow spaces, or shorten the window)`.
The pages are sorted by space key, then by modification time with the newest
first. This order is deterministic, so tests can pin it.

**Call cost** (P = pages reported, D = `min(P, max_diffs)`):

| `detail` | HTTP calls | Wall time at 6 in flight |
|---|---|---|
| `list` | ⌈P / page size⌉ (1 for P ≤ page size) | one or two round trips |
| `versions` | `list` + P | + ⌈P/6⌉ round trips (200 pages ≈ 34) |
| `summary` | `versions` + ≤ 2D (fewer on cache hits) | + ⌈2D/6⌉ round trips |

The tool description states these costs, as the version tools already do
("Costs 1 API call"), so the agent can choose a level deliberately.

## Unknowns: P0 live probe

Unit tests stub `fetch`, so they cannot settle these. Each answer drives a
decision. The orchestrator runs P0 with the user present, as read-only GETs
against the maintainer's designated test profile, and records the
answers in this file before W1 starts.

| # | Question | Drives |
|---|---|---|
| 1 | Does `/wiki/rest/api/search` accept `expand=content.version,content.space`, and what does the shape look like (`version.when`, `version.by.displayName`, `space.key`)? | W1 schema; whether `list` needs zero per-page calls |
| 2 | Is there a result-level `lastModified`, and in what format? | Fallback when `version.when` is missing |
| 3 | What is the maximum `limit` per request with that expand, and does paging use a `_links.next` cursor? | Page size; paging loop |
| 4 | Is `totalSize` present and exact? | Whether the header can say "of N" or only "more exist" |
| 5 | Is `now("-90m")` (minute unit) accepted? | Window encoding (fallback: whole hours, rounded up) |
| 6 | In what order does v1 `/content/{id}/version` return versions? | Confirms the defensive local sort is enough |
| 7 | Does a page move or restriction change bump `lastmodified` without a new version? | Whether `metadataOnly` needs a live test case |

**P0 answers (2026-10-06, 4 read-only GETs):**

1. Yes. With the expand, each result's `content` carries `version.number`,
   `version.when` (ISO, millisecond precision), `version.by` (the v1 user
   object) and `space.key`. `list` needs no per-page calls.
2. Yes: a result-level `lastModified`, ISO with whole seconds
   (`…:32.000Z`). The client takes the later of it and `version.when`, so
   the truncated seconds cannot drop a page at the window edge.
3. Paging uses `_links.next`, a cursor path relative to
   `_links.context` (`/wiki`), for example `/rest/api/search?next=true&cursor=…`.
   Following it returned the next page with no overlap. The maximum page
   size was not probed (production limits); the client follows `next` until
   it has `limit` hits, so a server-side cap only adds round trips. The
   client only follows a relative path on the configured host.
4. `totalSize` is present. It is not relied on: the header says
   "more exist" from the presence of `next` and never prints a total.
5. Yes, `now("-90m")` is accepted.
6. Newest first. The local sort stays as a guard.
7. Not probed: it needs a write. `metadataOnly` is covered by unit tests.

## Contracts (fixed before the lanes start)

```ts
// confluence-client.ts (W1)
export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly type: "page" | "blogpost";
  readonly spaceKey?: string;
  readonly version?: { readonly number: number; readonly when?: string; readonly by?: string };
  readonly lastModified?: string;
  readonly excerpt?: string;
}
export function searchContent(
  cql: string,
  opts: { limit: number; expandVersion: boolean }
): Promise<{ hits: readonly SearchHit[]; more: boolean; totalSize?: number }>;
// searchPages keeps its signature and delegates, so existing callers don't change.

// recent-changes.ts (W2), all pure
export type Window = { readonly sinceMs: number; readonly cqlMinutes: number; readonly label: string };
export function resolveWindow(
  input: { hours?: number; since?: string }, nowMs: number
): { ok: true; window: Window } | { ok: false; error: string };
export function resolveEffectiveSpaces(/* table above */): { ok: true; spaces?: readonly string[] } | { ok: false; error: string };
export function buildRecentChangesCql(w: Window, spaces: readonly string[] | undefined, includeBlogposts: boolean): string;
export type VersionSummary =
  | { kind: "edits"; count: number; atLeast: boolean; editors: readonly string[]; moreEditors: number;
      baseline: number | "created"; current: number }
  | { kind: "metadataOnly"; current: number }
  | { kind: "unavailable"; reason: string };
export function summariseVersions(v: readonly VersionMetadata[], sinceMs: number, fetchLimit: number): VersionSummary;
export function condenseDiff(r: ReturnType<typeof computeSummaryDiff>): string; // diff.ts:109
export function formatReport(input: ReportInput, fence: typeof fenceUntrusted, clean: (s: string) => string): string;
```

## Workstreams

```
P0 probe ─────────────┐
W2 pure core ─────────┼─► W3 handler (2 commits) ─► W5 review ─► E2E
                      │
P0 ─► W1 client ──────┘   W4 docs (parallel with W3)
```

W2 does not depend on P0: it consumes the normalised `SearchHit` and
`VersionMetadata` types, not raw API JSON. At most two agents run tests at
the same time.

### P0 · orchestrator (Opus), with the user
The live probe above. Read-only GETs only, and only against the designated
test profile: the one set as `CONFLUENCE_PROFILE` in the local, gitignored
`.mcp.json`. No other tenant is used for P0 or E2E. Before the first call,
check that the active profile's host matches it. Never write the profile
name or host into this repo; it is public.

**That tenant is a production instance, not a test system.** Live use is
limited to small, hand-run checks, about 20 requests per probe:
- No loops, no automated suites, no CI, and no repeated runs against it.
- Use small `limit` values (at most 10) and short windows.
- Answer each probe question with one or two calls; don't sweep.

Everything else is verified with stubbed `fetch`.

### W1 · Sonnet, high: client
`confluence-client.ts`: `SearchHitSchema`, `searchContent` with cursor paging
and a hard stop at `limit`; `searchPages` delegates to it. Tests in
`confluence-client.test.ts`:
- paging stops at `limit`;
- `more` is true or false exactly as it should be;
- a result that is neither a page nor a blog post is skipped;
- a missing `version.when` falls back to `lastModified`;
- an unparseable hit is skipped, not thrown;
- the `expand` and `cql` params are encoded.

### W2 · Sonnet, high: pure core
New `src/server/recent-changes.ts` plus tests. Freeze the clock and use fixed
fast-check seeds. Properties:
- `baseline < every in-window number ≤ current`;
- `count` equals the number of versions with `when ≥ since`;
- the input order of versions does not matter;
- `resolveWindow` round-trips: `sinceMs ≤ now − hours`, `cqlMinutes·60s ≥ now − sinceMs`;
- `buildRecentChangesCql` output always passes back through `scopeCql`
  unchanged in meaning, and never contains unescaped user text (fuzz the
  space keys with quotes and backslashes).

Example tests:
- `hours` and `since` both set, or neither set;
- `since` in the future or more than 720 h ago;
- created-in-window;
- `atLeast` at exactly 50;
- `metadataOnly`;
- an unparseable `when`;
- every row of the scoping table;
- `include_blogposts` true (the default) and false give the two `type`
  clauses.

### W3 · Opus, high: handler and wiring (after W1 and W2)
Commit 1 is Phase 1: `search_pages` formatting (timestamp re-rendered from the
parsed time, editor inside the fence, the `more` line,
the `limit` cap).

Commit 2 is Phase 2:
- register `get_recent_changes` with `readOnlyTool("Get recent changes")`;
- add it to `READ_ONLY_TOOLS` (`index.ts:674`), `KNOWN_TOOLS`
  (`tool-allowlist.ts`) and the expectations in `tool-surface.test.ts`;
- add an integration test modelled on `search-scope.integration.test.ts`:
  scoping table, enforced mode, redaction of titles, a blog post marked
  `[blog]` in a default call, a per-page 403 that
  gives a line and not a failure, truncation header, fences around every
  tenant string, `max_diffs` skip note, and the tenant echo present.

### W4 · Sonnet, medium: docs (parallel with W3)
`doc/user-doc/tools-reference.md`, `doc/design/03-tools.md`, the tool list
and count in `README.md`, and a `CHANGELOG.md` entry. Update the
`read_spaces` / `read_spaces_enforced` doc comments in
`src/shared/profiles.ts:139-157` to say that they now also scope
`get_recent_changes`. Add an example prompt to the tools reference: "Give me
a concise report of the pages that changed in the last 24 hours".

### W5 · review
- The `test-critic` agent reviews the W2 and W3 tests.
- An Opus/high correctness review of the full diff checks report honesty in
  particular: no path may present a truncated or partially failed report as
  complete.
- Findings are fixed by the agent that owns the lane.

### E2E · orchestrator, with the user
Against the same test profile as P0, under the same production limits:
small, hand-run, a few dozen requests in total.

**Writes need the maintainer's explicit permission for each run.** Ask
before the first write and list exactly what will be created or edited. With
no permission, run only the read-only part (step 2 against content that
already exists) and report the write-dependent checks as not verified. Every
permitted write goes to the maintainer's personal space (the `~…` space key),
and nothing is created or edited in any other space. Before the first write,
resolve the personal space key and check that the target is that space.

1. *(Needs write permission.)* Edit one scratch page twice, create one new
   page and edit one blog post, all in the personal space.
2. Run each `detail` level once with `hours: 1`, scoped to the personal
   space, with `limit` ≤ 10 and `max_diffs` ≤ 3.
3. Check the edit counts, the baseline, `new page`, and that the condensed
   diff names the edited section.
4. Check one scoped run. Check enforced mode with stubbed `fetch` only, not
   live.
5. *(Needs write permission.)* Delete the scratch content from the personal
   space, after confirming with the maintainer.

Tests with a stubbed `fetch` cannot catch a wrong `expand`, cursor or CQL
time unit, so this step decides whether the feature is done.

**E2E results (2026-10-06, read-only, no write permission requested; about
33 GETs):** run against the built server over stdio, scoped to the personal
space with `limit` ≤ 5.
- `list`, `versions` and `summary` over 720 h: paging, the
  `showing 5, more exist` header, `new page` with the edit count, editors
  inside the fence, and the tenant line were all correct.
- `list` over 1 h: `· complete` with the two pages edited in that hour.
- `summary` over 1 h with `max_diffs: 1`: `1 edit (v19)` with a condensed
  `Changed: <section> (+1 −1)` inside the fence, the other page listed
  without a diff, and the `max_diffs` note.
- `search_pages`: `Space`, `Modified` and version outside the fence,
  `Last editor` inside it, and the "More results exist" line.
- Not verified live (needs writes or content that did not exist): a blog
  post in the window, and `metadataOnly`. Both are covered by unit and
  integration tests.

Engineering rules, resource budget and the watchdog follow
`plans/field-session-findings-2026-10.md` §7–8: scoped
`npx vitest run --maxWorkers=2 <files>`, one test run per agent, neutral
fixtures (`example.com`, `DOCS`/`TEAM`), no push or publish. **Lane agents
(W1–W5) never call a live tenant.** Only the orchestrator does, in P0 and
E2E, under the production limits above.

## Model and effort summary

| Task | Model | Effort |
|---|---|---|
| P0, E2E, full-suite run | orchestrator (Opus) | – |
| W1 client, W2 pure core | Sonnet | high |
| W3 handler, scoping and fencing | Opus | high |
| W4 docs | Sonnet | medium |
| W5 correctness review | Opus | high |
| W5 test critique | test-critic agent | – |

## Data-loss and safety assessment

- **No write path.** Both tools are read-only. They do not call `writeGuard`,
  use write budget or touch `safeSubmitPage`. The only shared state they use
  is the versioned body cache, which is keyed by immutable
  `(pageId, version)`, so a diff run cannot poison a later write.
- **The main risk is a misleading report.** An agent could act on a report
  that looks complete but isn't, and conclude that "nothing else changed".
  Two features exist for this reason: the `complete` / `more exist` header,
  and per-page `unavailable` lines that replace silent omission. W5 checks
  for exactly this.
- **Cross-tenant confusion.** The user works across several tenants, so the
  report ends with `tenantEcho` and states which profile and host it covers.
- **Prompt injection.** Titles, editor names and section headings are tenant
  text and are fenced. Only server-validated identifiers stay outside the
  fence, the same as the T5 rule in `search_pages`.
- **Load.** Per-page fan-out goes through the shared semaphore and
  `settleInChunks`. `limit ≤ 200` and `max_diffs ≤ 25` bound the worst case
  to about 250 GETs.

## Out of scope (follow-ups)

- Deleted or trashed pages, comment-only changes and attachment-only changes.
  CQL can reach them (`type = comment`, `type = attachment`), but each needs
  its own line format. Record them as a follow-up and do not widen this tool.
- "Changed since I last looked": this needs persisted per-user state, which
  this server deliberately avoids.
- `structuredContent` output: follow whatever the 7.1.0 work decides for read
  tools.

## Decisions

1. **Release:** both phases ship in 7.1.0.
2. **Default `detail`:** `list`. The tool description names the cost of
   `versions` and `summary`, so the agent can ask for more.
3. **Blog posts:** included by default (`include_blogposts: true`).
