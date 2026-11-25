# 6. Deliverables and acceptance criteria

Status: design, reviewed 2026-11-25. Step 0 (7.6.1) built; steps A and B not built. Implementation plan:
[plans/policy-gate.md](../../../plans/policy-gate.md).

Releases (D22): step 0 as the 7.6.1 patch now, on SDK 1.x; P1 this week; step A after 8.0.0,
against SDK 2.x, in the first free minor (Q13); step B after A. Test runs: `npx vitest run
--maxWorkers=2 <files>`, scoped files first. Every new pure module has property tests
(fast-check) with pinned clocks; seeds are not pinned and are printed on failure.

## Precondition (before the step-A build)

**P1. Decision-14 live check** (manual, the user present; small read-only calls on the
designated test profile only; one site and one gateway profile). Run this week, before the test
token is revoked around 2026-11-29 (Q12). Record the answers in `plans/policy-gate.md` §2:

1. `getContent` metadata returns `spaceId` under the scoped token; `GET /spaces/{id}` returns
   `key` and `type`.
2. `/spaces?keys=K` with the exact key and with a wrong-case key (Q2).
3. CQL `space.type = "personal"` restricts a search to personal spaces (Q5).
4. `/spaces` pagination via `_links.next` in both modes.
5. `GET /pages?id=…` with several ids returns each page's `spaceId` (batch resolution).

Outcome feeds `personalCql`, the case hint, the batch lookup and the gateway setup scope list.

## Step 0

| ID | Deliverable | Acceptance criteria |
|---|---|---|
| 0-D1 | `safeOpenReadWithStat` (mode, owner uid, `verifyDirChain`, `{raw, stat}` with `bigint`) in `src/shared/safe-fs.ts`; three-state `readRegistry()`, `RegistryUnreadableError`, `describeUnreadable`, `registryFingerprint` in `src/shared/profiles.ts`; `getProfileSettings`/`readProfileRegistry` throw on unreadable and use `Object.hasOwn`; parse errors keep only the position | 0-T1, 0-T2, 0-T8, 0-T10 pass |
| 0-D2 | `safeAtomicWrite` in `safe-fs.ts` (reused for `update-check.json`); the writer core `writeWithAnchor` without its anchor steps: lock file, stale-temp sweep, refuse on unreadable before any temp file, `.bak` rules (D36), pre-rename `lstat`, unknown keys kept; `assertRegistryWritable`; `updateProfileSettings(name, fn)`; every exported writer goes through the core | 0-T2, 0-T3, 0-T9, 0-T11, 0-T12 pass |
| 0-D3 | `main()` reads the registry once, passes it to `getConfig({registry})`; unreadable → `startRecoveryServer(profile, reason)`; `recoveryText` | 0-T4, 0-T5 pass; `getConfig` no longer falls back to posture `detect` on an unreadable file |
| 0-D4 | `setup` (site and gateway) and `profiles --remove` preflight the registry before any keychain write or delete; `cli/index.ts` prints `RegistryUnreadableError` without a stack, exit 1 | 0-T6 passes |
| 0-D5 | `SpaceNotAllowedError` names the `spaces` setting and the file path (no non-existent flag) | 0-T7 passes |

Tests:

- **0-T1** `src/shared/registry-fail-closed.test.ts`, written red first (reproduces analysis 02
  "to verify"): real fs in `mkdtemp`, `HOME` redirected; registry with a trailing comma, mode
  0666, a symlink, `{"profiles": "x"}`, a directory, a file owned by another uid (stat mocked), a
  group-writable config directory; profile with `spaces: ["DEV"]` and `posture: "read-only"`.
  Before: settings `undefined`, posture `detect`. After: each case yields `unreadable` with the
  right `kind`; a parse error carries line and column or none; a canary inside the broken JSON
  never appears in the reason, `what` or `fix`; absent stays absent.
- **0-T2** For each writer × each unreadable kind: throws `RegistryUnreadableError`; file bytes
  and mode identical before and after; no `.profiles.*.tmp` left. Absent: `addToProfileRegistry`
  creates a 0600 file.
- **0-T3** Property: for any mutation of a valid registry (dropped brace, wrong type at a key,
  truncation, non-UTF-8 byte) that makes it invalid, no CLI write changes the file bytes.
- **0-T4** `recovery-mode.test.ts`: one case per `RecoveryReason`; five refusal lines with the
  pinned prefixes, the fix line, the `.bak` clause only when a backup exists, and "Restart:
  needed"; a canary inside the broken JSON never appears.
- **0-T5** Boot `main()` over `InMemoryTransport` with a syntax-error registry: `listTools()` is
  exactly `["setup_profile"]`; `getInstructions()` names the fix.
- **0-T6** `setup.test.ts`, `setup.gateway.test.ts`, `profiles.test.ts`: with an unreadable
  registry the keychain save/delete mocks are never called; exit 1.
- **0-T7** `src/cli/cli-commands-in-errors.test.ts`: every `epimethian-mcp <word>` in string
  literals under `src/server/**` and `src/shared/**` names a command `src/cli/index.ts`
  dispatches; subcommands checked against their module's dispatcher from step A.
- **0-T8** `validate-startup.test.ts`: unreadable registry → `getConfig` throws; no write probe.
- **0-T9** `updateProfileSettings` removes a key, replaces the `policy` block whole, returns
  `before`/`after`, removes the entry on `undefined`, leaves other profiles' subtrees equal.
- **0-T10** A profile named `__proto__`, `constructor` or `toString` is not found unless it is
  an own key.
- **0-T11** Durability: a fault-injected `rename` failure leaves the old file intact and the
  temp removed; a pre-existing temp name is not followed or reused (`O_EXCL`); `.bak` equals the
  bytes of the readable file before the write and is fsynced; with the registry absent an
  existing `.bak` is byte-identical afterwards; an unknown top-level key survives a write; fsync
  calls happen in order (spy); a directory-fsync failure after the rename is a stderr warning and
  the write resolves; on `win32` (platform mocked) the directory fsync is not attempted.
- **0-T12** Lock and races (fake clock): two concurrent writers both land, one after the other;
  a held lock makes a writer refuse after 5 s with the lock message and unchanged bytes; a lock
  older than 60 s with a dead pid is cleared with a warning; a hand edit between read and rename
  is detected and the change is re-applied to the edited file; temp files older than one hour
  are swept, newer ones kept.

## Step A

| ID | Deliverable | Acceptance criteria |
|---|---|---|
| A-D1 | `src/shared/policy.ts` (grammar, projection, `anchorOf`, `reconcileAnchor`, continuity, hash, renderers) | A-T1, A-T2 pass |
| A-D2 | `src/server/gate-core.ts` (`GATE_SPECS`, grammar-checking combinators, `optional`, `allOf`, exhaustive `decideRead`, `degradeAsk`, `renderRefusal`, manifest, change note, ledger functions) | A-T3, A-T5, A-T19 pass; `tsc` fails when a `KNOWN_TOOLS` name has no row (`@ts-expect-error` fixture) |
| A-D3 | `src/server/gate.ts` (`PolicyStore` single flight with stored observation, torn-save re-read and anchor timeout; `resolveTarget` with canonicalisation, batching, negative cache and resolver chain; `gateHandler` on `CallToolResult`; `UndeclaredToolError`; capped deny lines) | A-T6, A-T7, A-T14, A-T18 pass |
| A-D4 | `index.ts` hunks H3–H10 against the 8.0.0 tag ([01 §1.5](01-architecture.md#15-indexts-hunks-complete-list)); shim edited in place; `pageSpaceCache.seed` calls and optional manifest items | A-T4, A-T8, A-T11, A-T13, A-T17 pass; `git diff` shows no change inside an `inputSchema` |
| A-D5 | `scopeCql` `CqlScope` overload with ceiling; `config.ts` grammar and `policy` key (full block schema incl. `read_budget`) | `cql-scope.test.ts` extended: personal disjunct, deny clause, ceiling, never unscoped; existing cases unchanged |
| A-D6 | `listAllSpaces`, `findSpaceByKey`, `getSpaceById`, `getContentSpaces`, `spaceKeyFromResponse` in `confluence-client.ts`; `pageSpaceCache.seed` with space type and the 10,000 cap | Unit tests with mocked `v2Get`: follows every `_links.next`, stops at `maxSpaces`, sets `truncated`, applies no type filter, returns `collaboration`/`knowledge_base` types as strings; batches of 250; caches |
| A-D7 | Keychain anchor item: `readPolicyAnchor` (tri-state, timeout), `writePolicyAnchor`, `clearPolicyAnchor`; anchor steps of `writeWithAnchor`; `profiles --remove` clears it | A-T12, A-T15 pass |
| A-D8 | `src/cli/terminal.ts`; `src/cli/policy.ts`: `policy [--check] [--verbose]`, `policy setup`, `policy allow [--write]`; `parseArgs`; dispatch; `status.ts` line; `setup` hand-off; terminal requirement on `profiles --set-read-write` | A-T9, A-T16 pass; 0-T7 covers the new commands |
| A-D9 | `SpaceNotAllowedError` names `epimethian-mcp policy allow <KEY> --write --profile <p>` and "policy changes apply on the next tool call" (D18) | 0-T7; message test |
| A-D10 | Decision 15 (write ceiling) | A-T10 passes |

Tests:

- **A-T1** `src/server/gate-boundaries.test.ts`: the five import rules in
  [01 §1.2](01-architecture.md#12-dependency-direction).
- **A-T2** `src/shared/policy.test.ts` (fast-check): `parseSpaceEntries ∘ formatSpaceEntries` is
  identity on valid input; `inScope` ⇔ (exact key ∨ (allPersonal ∧ type personal)) ∧ ¬ deny
  (case-insensitive); a `~`-prefixed key with type `global`, `collaboration` or undefined is not
  matched by `~*`; adding an allow entry never turns allow into deny; adding a deny entry never
  turns deny into allow; `*`, `!~*`, deny-only lists, keys outside `SPACE_KEY_RE` (`~x,HR`,
  quotes, spaces) rejected; `[]` enforced denies everything; enforced without `read_spaces` →
  `invalid-settings`; an invalid entry on a non-enforcing profile is dropped and listed in
  `ignored`, on an enforcing one (file or anchor) it is `invalid-settings` whose path holds only
  setting names and indexes; `cqlScopeOf` never returns an empty scope as ok and never a key the
  ceiling rejects; `hashPolicy` stable under key and set order; `anchorOf(p)` is undefined iff
  `p.state === "off"`; `reconcileAnchor`: for every space, the effective policy allows it only if
  both file and anchor would (when both enforce), the effective budget is never looser than
  either, `match` leaves the file's policy unchanged; `applyContinuity` order of 03 §5.3 (the
  anchor row wins over "absent after an off start").
- **A-T3** `src/server/gate-core.test.ts` (fast-check): off ⇒ allow for every readable input;
  unreadable ⇒ deny except `get_version`, `upgrade`; on ∧ unresolvable ⇒ deny for every
  non-exempt class; for every generated (phase, class, target kind) outside row 13 the decision
  is a deny (no default allow); a `deferred` or `none` target on a non-manifest spec ⇒
  `GATE_TARGET_UNCHECKED`; budget set ∧ `count` ∧ no id in the deciding phase ⇒ deny; no A/B
  input yields `ask`; `degradeAsk(x, {elicitation: false})` never allows; same input ⇒
  deep-equal output; `renderRefusal` has exactly 5 lines with `REFUSAL_PREFIXES`; combinators:
  generated strings outside the grammars yield `malformed`, leading-zero ids normalise; a canary
  injected into every tenant-derived fixture string **and every argument-derived string**
  (titles, CQL, `space_key`, `page_id`, `output_path`) never appears in refusal, receipt, change
  note, instructions, description or `audit.log` output; a personal key `~canary` never appears
  in any agent-facing output; `policy allow` appears only with a resolver-derived non-personal
  key.
- **A-T4** `src/server/gate-coverage.test.ts` (boots `main()` like `tool-surface.test.ts`):
  every `listTools()` name in site and gateway mode, read-only and read-write, has a row; every
  `argNames` entry exists in the emitted JSON input schema and is required, or its absence maps
  to `malformed` or `none` (`optional`); behavioural matrix generated from `GATE_SPECS` (scope
  `["DEV"]` enforced; every content resolves to `HR`): each non-exempt tool returns its refusal
  code, no body-fetching client mock was called, no file was written (`download_attachment` also
  with `overwrite: true` and an existing file); manifest tools: no manifest →
  `GATE_RELEASE_UNREPORTED`, `HR` in the manifest → `GATE_RELEASE_OUT_OF_SCOPE`, manifest built
  from a response whose `spaceId` is `HR` while the argument says `DEV` → withheld; an error
  result from a manifest tool is replaced by the fixed text with the status class; with no
  policy and no anchor, `tools/list` and every fixture result are byte-identical to the pre-gate
  golden.
- **A-T5** Shim unit test: registering `"made_up_tool"` or `"constructor"` throws
  `UndeclaredToolError`; a registration without `inputSchema` throws.
- **A-T6** `src/server/gate.test.ts` (fake fingerprint, read, anchor and sleep; pinned clock):
  unchanged fingerprint ⇒ no read; ten concurrent calls after a change ⇒ one read (single
  flight); a read that throws ⇒ `POLICY_UNREADABLE` (`io-error`) and the next call reads again
  (promise cleared); changed fingerprint, same hash ⇒ no note; changed hash ⇒ one reload, one
  `onChange`, one note on the next final result only; `input_required` stub does not consume the
  note; unreadable ⇒ `POLICY_UNREADABLE` for reads and writes and the handler is never invoked,
  also when the start was `off`; 100 calls in an unreadable or absent state ⇒ one registry read
  and one keychain read; a parse error (or `ENOENT`) followed by a valid file 75 ms later ⇒ no
  deny; a persistent parse error ⇒ deny whose `Instead` line says to call again once; absent
  after `on` with no anchor ⇒ deny; absent after `off` ⇒ off; absent with an anchor ⇒ the anchor
  enforced; `anchor-unreadable` retries the keychain at most once per 5 s; env-var mode ⇒ no
  store, no `lstat`.
- **A-T7** Cache: hit ⇒ no `getContent`; a `list_pages` result seeds the cache so a following
  `get_page` makes no metadata call; a seeded personal space matches `~*` on a cache hit;
  10,001 seeds keep 10,000 entries; an unknown key is looked up once per 60 s; 250 `contents`
  ids ⇒ one batch request (plus one for blog posts not found); policy off ⇒ resolver never
  called.
- **A-T8** Instructions `length <= 4096` with 100 keys, gateway, read-write; `get_page` and the
  four listing tools end with a suffix naming ≤ 5 keys, every other gated tool with ` Read policy
  applies; see instructions.`; byte-identical when off; every description ≤ 1,800 characters
  with the suffix (8.1.0 cap).
- **A-T9** `src/cli/policy.test.ts`: `parseSelection` properties; `policy setup` with mocked
  readline and `listAllSpaces` (two pages via `_links.next`) writes the expected settings
  (`read_spaces_enforced: true`), the anchor and an `audit.log` line with old and new
  fingerprint, and preserves `!` entries; only existing `read_spaces` are pre-ticked; an empty
  pick asks `[b]ack / [s]ave anyway`; `o` turns the policy off, keeps `read_spaces`, clears the
  anchor; no "all spaces" option; invalid active-profile settings ⇒ setup proceeds; tenant
  unreachable, zero spaces, truncated list, no terminal and a held lock print the 02 §9.4 texts
  with their exit codes; unreadable registry ⇒ exit 1, no keychain or network call; `policy
  allow hr` with tenant key `HR` ⇒ "did you mean", nothing written; plain `policy allow HR`
  changes only `read_spaces`, `--write` only `spaces`; `policy --check` flags unknown keys with
  exit 1 and reports `.bak` against the anchor; unknown flags ⇒ exit 2 (`parseArgs` strict);
  fingerprints only with `--verbose`; `policy` output matches
  [02 §9.3](02-interfaces.md#93-policy-output) for off, enforced, mismatch, unreadable.
- **A-T10** `src/server/gate-write-ceiling.test.ts` (D15): each write tool with a target in `HR`
  under scope `["DEV"]` enforced ⇒ `POLICY_WRITE_OUTSIDE_READ_SCOPE`, no request other than GET,
  no write-budget use, no mutation-log record; `authorise_destructive_writes` with one id in
  `HR` ⇒ refused; comment tools judged by container; `create_comment` with a parent comment on
  an `HR` page ⇒ refused; `create_page` in `DEV` with a parent in `HR` ⇒ refused; the person line
  names `policy allow HR` and adds the `--write` form only when `HR` is not in `spaces`.
- **A-T11** `search-scope.integration.test.ts`, `recent-changes.integration.test.ts` extended:
  `~*` and `!KEY` scopes narrow; out-of-scope hits post-filtered; the agent sees "some results
  withheld" without a count; `get_spaces` filtered; `all_spaces` refused when enforced; a scope
  of only `~*` with `personalCql: false` ⇒ `POLICY_SEARCH_NOT_SCOPABLE` and no search request;
  with an anchor ceiling, the CQL holds only keys both allow.
- **A-T12** `src/shared/policy-anchor.test.ts` (anchor rules, D23, D26): (a) a `policy` write
  whose projection is on writes the anchor, one whose projection is off clears it; `policy allow
  HR` on a search-default profile leaves no anchor and the next start is neither recovery nor on;
  (b) kind `other` writers (`setup` posture, `profiles --set-read-only`, attribution, `--remove`)
  never write the anchor, and a change that would alter a projection throws; (c) intersection: a
  hand-widened `read_spaces` keeps the anchor scope; `read_spaces_enforced` removed by hand with
  the budget kept stays enforced at the anchor scope; a deleted file enforces the anchor; a
  hand-narrowed file applies the narrower scope; (d) tri-state: macOS exit 44 and Linux exit 1
  with empty output ⇒ `absent`; a timeout (fake 2,000 ms), any other exit code, a prompt denial
  or an unparseable item ⇒ `error`; `error` keeps the last anchor; `error` with none known and
  the file on ⇒ `anchor-unreadable`; with the file off ⇒ off; (e) ordering: the anchor is
  written only after the read-back matches; a read-back mismatch writes no anchor and says to run
  again; turning off clears the anchor before the file write; a crash injected after each step
  leaves a state at least as narrow as before; the `utimes` after the anchor write makes a
  running store reload and read the new anchor; (f) the seal re-save and `setup` never touch the
  anchor item; `profiles --remove` clears it.
- **A-T13** `registerTools` makes no registry read of its own (spy: one `readRegistry` call per
  startup, also with a per-request `serveStdio` factory).
- **A-T14** `audit.log` deny lines in step A: one line per deny with code, tool, ID or key,
  profile; nothing else; after 1,000 lines one `further denies suppressed` line and nothing more
  in that process.
- **A-T15** Startup with an anchor: no registry, no profile entry or no policy keys ⇒ the server
  starts and enforces the anchor (not recovery mode); a mismatch ⇒ instructions line and a change
  note on the first final result.
- **A-T16** Terminal: `policy setup`, `policy allow`, `log --purge-older-than` and `profiles
  --set-read-write` refuse when stdin is not a TTY or `/dev/tty` cannot be opened; they proceed
  with stdout piped; the confirmation is read from the `/dev/tty` stream (mocked), not stdin, and
  the stream is closed afterwards.
- **A-T17** Title tools and recent changes (moved from B-T8): manifest space from the response
  (`spaceId` → `getSpaceById`), never from the argument; `resolve_page_link` hit without a
  response space ⇒ dropped; not found ⇒ `EMPTY_MANIFEST` accepted; no manifest ⇒ withheld;
  `get_recent_changes` with `spaces[]` and no manifest ⇒ withheld; a `get_page` handler whose
  optional item names another space than the pre-resolved one ⇒ withheld.
- **A-T18** Results: for each write tool with an `outputSchema`, the gated result's
  `structuredContent`, `_meta` and `isError` are deep-equal to the handler's, and the change note
  is appended after the handler's blocks; on a plain result it comes first; `tsc` accepts the
  wrapper against SDK 2.x `CallToolResult`.
- **A-T19** Copy (pins codes and prefixes, D37): every refusal's line 1 contains "This is final
  for this call" and "until the person says the policy was changed"; `invalid-settings` names
  `policy setup --profile <p>`; `POLICY_ALL_SPACES_REFUSED` and `POLICY_SPACE_UNRESOLVED` person
  lines are the 02 §8.1 forms; the budget refusal shows UTC and local time (fixed offset); the
  `GATE_*` person line holds the issue URL; one restart wording across refusals, change note and
  CLI.

## Step B

| ID | Deliverable | Acceptance criteria |
|---|---|---|
| B-D1 | Budget ledger with holders (pure in `gate-core.ts`, cell in `gate.ts`); `policy.read_budget` enforced | B-T1, B-T7, B-T9 pass |
| B-D2 | `mutation-log.ts` helpers with `prefix`, retention and `ENOENT`-tolerant sweep; `src/server/read-log.ts` (session hex in the name, 10 MB cap, 90-day sweep) | B-T2 passes; existing `mutation-log.test.ts` passes unchanged |
| B-D3 | Receipt and records in `gateHandler`; deny records move from `audit.log` to the read log; `lookup_user` allows recorded; listing records with content IDs | B-T3, B-T4, B-T10, B-T11 pass |
| B-D4 | (moved to step A: H10, A-T17) | – |
| B-D5 | `src/cli/log.ts` (time range, summary, JSONL, `--purge-older-than`, lenient reader); `policy` log and "changed outside the CLI" lines | B-T5, B-T6 pass |
| B-D6 | Budget question in `policy setup` | A-T9 extended |

Tests:

- **B-T1** Budget properties (pinned `now`): `usedAfter <= cap`; re-reading a counted id is
  never denied; `n` distinct ids at one `now` ⇒ exactly `min(n, cap)` allowed; after `oldestAt +
  windowMs` one new id is allowed; a deny never changes the ledger; `reserve` then
  `settle(failed)` of new ids with no other holder is the identity; `prune` never removes an id
  in flight; the entry count never exceeds the distinct ids of the window; warn ⇔ `cap -
  usedAfter <= max(1, ceil(cap * 0.2))`; refusal `freesAt` equals `oldestAt + windowMs`; with no
  budget set the ledger still records and a budget turned on counts the last 60 minutes.
- **B-T2** Real fs in `mkdtemp`: dir 0700, file 0600 checked by `fstat`, name with the session
  hex, `O_EXCL` with no fallback (a pre-existing file with the same name ⇒ log unwritable,
  reported); symlinked directory refused via `verifyDirChain`; append failure returns `{ok:
  false}`, the receipt shows the gap and the next record carries `droppedBefore`; at the 10 MB cap
  (small cap injected) one `capped` record, then `EFBIG`, and `session_end` still written with the
  dropped count; sweeps are prefix-scoped, delete files older than 90 days (pinned `now`), and
  ignore `ENOENT` when a second sweep removed a file first; no file while the policy is off and no
  anchor exists; a client label with control characters is stored stripped.
- **B-T3** `renderReceipt` output contains only space keys, content ids, numbers, the fixed
  words and a time, never a withheld count and never a personal key (`a personal space`); it is
  a separate content block after any `<<<CONFLUENCE_UNTRUSTED` fence.
- **B-T4** Ordering (contract C5): for a pre-check refusal, no reservation and exactly one deny
  record, written after the decision; for an allowed read the reservation precedes the handler
  and the record precedes the result; a handler error settles the reservation as failed; nothing
  is logged for a write-class call.
- **B-T5** `log` pure core: allow + deny + error = total; distinct pages ≤ allow count; summary
  per space commutes with filtering by space; unparseable lines counted; a record with an extra
  field or a newer `v` is counted as newer, not as a gap; `--format jsonl` re-parses with
  `readRecordSchema`; a `changed` record without a matching CLI line is labelled "not made with
  the CLI"; an empty period prints the empty-period line; search results are "filtered out".
  `--purge-older-than` deletes only `reads-*` files older than the given days and prints the
  backup note.
- **B-T6** `policy` reports changes outside the CLI from fixture logs.
- **B-T7** Two concurrent `get_page` calls for different uncounted ids with one slot left: the
  second is refused in the pre phase and its handler is never called; `download_attachment`
  refused by the budget writes no file, also with `overwrite: true`.
- **B-T8** (moved to step A as A-T17.)
- **B-T9** Interleaved settle (S2): call 1 reserves page X; call 2 reads X (already counted) and
  releases it; call 1 fails ⇒ X stays counted. If call 2 also fails ⇒ X is removed. Generated
  interleavings of reserve, release and fail over two to four calls never leave an id uncounted
  that some call released.
- **B-T10** Listing records: a `search_pages` result with 150 released hits records 100
  `contentIds` and `moreContentIds: 50`; withheld hits contribute no ID.
- **B-T11** `lookup_user` allows are recorded with tool, decision and code only; the strict
  schema rejects any query field.

## Documentation deliverables

| ID | File | Change | Step | Acceptance |
|---|---|---|---|---|
| DOC-1 | `README.md` "Search Scope and Redaction" (`:167-194`) | Rename to "Read scope and redaction". `README.md:188` says `read_spaces_enforced` is not a read boundary: rewrite the row and the note at `:193` (every read tool; D15 writes); entry grammar (`KEY`, `~*`, `!KEY`, no `*`; key charset); `read_spaces: []`; the `policy` block; `policy`/`policy setup`/`policy allow [--write]`/`log`; receipt; the keychain anchor (a hand edit can narrow, never widen); the threat-model sentence; for tool-name-level restrictions, an MCP gateway in front of the server; "read log", not "audit log" | A (budget, log: B) | No sentence says the scope is not a boundary; no sentence claims compliance, prevention or evidence-grade audit; the analysis-03 limits appear in substance; placeholder keys only |
| DOC-2 | `doc/user-doc/tools-reference.md` | One line per gated tool (space source); refusal codes and what to do; receipt line; "some results withheld"; `lookup_user` outside the space scope | A/B | Every `DenyCode` documented |
| DOC-3 | `doc/user-doc/installation.md` | `setup` ends with the offer to limit readable spaces; `policy` commands; terminal requirement | A | Matches setup output |
| DOC-4 | `CHANGELOG.md` `[Unreleased]` (§1 below) | Fixed / Changed / Added entries | 0/A/B | Each step's entries present before its release |
| DOC-5 | `doc/design/security/06-limitations.md` §17 (`:248`) | Rewrite: what the scope bounds; 5-min cache TOCTOU; same-user file and keychain access (anchor removable; tamper-evident via fingerprints; logs editable); terminal check defeated by `script`/`expect`; Confluence path of this server only; the budget caps accidental reads, is not a minimisation guarantee, and resets on restart; listings and excerpts not budgeted; `lookup_user` not scoped until step E. **What the tool does not guarantee (X5):** it does not make usage GDPR-compliant by itself; the server cannot verify which model or provider receives content; the read log shows what was handed to the MCP client, not what the provider received or kept; transfer and retention at the provider are the provider's and the employer's concern | A/B | No contradiction with README; the non-guarantee list is present; no sentence claims compliance, prevention or evidence-grade audit |
| DOC-6 | `doc/design/security/05-observability.md` | "Read log" section: location and file name; schema; **purpose** (operator self-audit and incident scoping); **retention** 90 days, swept only when a server opens a log, 10 MB per file; **erasure**: `log --purge-older-than <days>` or deleting the files; exports, backups and synced home directories fall outside the sweep; the log is personal data about the operator, stays on the machine and is never transmitted; `log` shows IDs only; `droppedBefore` and `capped`; no switch; personal keys contain account IDs; coexistence with the mutation log. "Profile audit log" (`:126`) gains policy edits (old and new fingerprint) and step-A deny lines with their cap | A/B | Fields match `readRecordSchema`; purpose, retention and erasure text present; no sentence claims evidence-grade audit |
| DOC-7 | `install-agent.md`, printed by `src/cli/agent-guide.ts` | New section "Read policy (scope and budget)" after "Write budget" (`:268`); replace "Search scope" (`:763-770`). A `Withheld [POLICY_...]` result is final for that call until the user says the policy was changed: do not retry, do not try another tool; relay the five lines and quote the "For the person" line verbatim; never run `policy allow` yourself; a `POLICY_UNREADABLE` after the user saved the file may be retried once; receipt line; budget warning; the change note supersedes startup instructions and descriptions; `REGISTRY_UNREADABLE` from `setup_profile`: tell the user, do not edit files | A (receipt, budget: B) | `agent-guide.test.ts` / `install-agent.test.ts` pin the heading, the codes and the phrases "final for this call" and "For the person"; no sentence claims compliance, prevention or evidence-grade audit |
| DOC-8 | `src/cli/setup.ts` output, CLI help text | After the client snippets: `Limit which spaces the agent may read now? [y/N]` → `policy setup` in-process; last line states the read scope; `--help`/usage lists `policy` and `log` | A/B | `setup.test.ts` checks prompt and hand-off |
| DOC-9 | `src/shared/profiles.ts` doc comments (`:138-157`) | New meaning of `read_spaces` / `read_spaces_enforced`; `policy` block; `writeWithAnchor` as the only writer | A | No "NOT a read boundary" text left |
| DOC-10 | `doc/design/04-setup.md` | `setup` hand-off; registry preflight; lock; anchor | 0/A | – |
| DOC-11 | `doc/analysis/policy-gate/05-lessons-from-repo-aegis.md` | The row "Audit log cannot be written — To decide" points to decision 12 | A | Row updated |
| DOC-12 | `doc/design/policy-gate/*` | Status line updated per step as built | 0/A/B | – |

### 1. CHANGELOG drafts (`[Unreleased]`)

Step 0 (7.6.1), **Fixed**:
- An unreadable profile registry (syntax error, unexpected shape, group- or world-writable
  permissions, a file or directory owned by another user, symlink) starts the server in recovery
  mode, whose tool names the problem and the fix; it is no longer treated as empty, which
  silently dropped a profile's restrictions. A registry that is group- or world-writable must be
  fixed with `chmod 600 ~/.config/epimethian-mcp/profiles.json`; a symlinked registry must be
  replaced with a regular file.
- CLI commands no longer overwrite an unreadable profile registry; `setup` and
  `profiles --remove` check it before touching the keychain. Writes are flushed to disk, take a
  lock so two commands cannot overwrite each other, keep the version before the last CLI change
  in `profiles.json.bak`, and keep unknown top-level keys.
- The write-allowlist refusal no longer names a CLI flag that does not exist.

Step A, **Changed**:
- With `read_spaces_enforced: true`, `read_spaces` bounds every read tool, not only
  `search_pages` and `get_recent_changes`: content in other spaces is withheld with a
  `POLICY_*` result. Profiles that read pages outside `read_spaces` by ID will see refusals.
  `read_spaces: []` with enforcement allows no reads.
- With `read_spaces_enforced: true`, writes to a space outside `read_spaces` are refused, so a
  write's response cannot echo content the profile may not read.
- On a profile with `read_spaces_enforced: true`: `read_spaces_enforced` without `read_spaces`,
  invalid `read_spaces`/`redact_patterns`/`spaces`/`policy` values, and space keys with
  characters other than letters, digits, `.`, `_`, `:`, `-` (after an optional `~`) start
  recovery mode instead of disabling search only. Fix with `epimethian-mcp policy setup
  --profile <name>`. On other profiles such entries are ignored with a warning.
- Changes to `read_spaces`, `read_spaces_enforced`, `spaces`, `redact_patterns` and `policy`
  apply to running servers on their next tool call; the next result says the policy changed.
- Profiles that already enforce `read_spaces` are not anchored in the keychain until
  `epimethian-mcp policy setup` runs once for them.
- `profiles --set-read-write` needs an interactive terminal.

Step A, **Added**: `epimethian-mcp policy`, `policy setup`, `policy allow` (`--write` for
writes); `read_spaces` entries `~*` (all personal spaces) and `!KEY` (exception); the read scope
in server instructions and tool descriptions; a policy set with `policy setup` is recorded in
the keychain, so a hand edit or a removed file can narrow the policy but never widen or remove
it.

Step B, **Added**: read log (`~/.epimethian/logs/reads-*.jsonl`) while a policy is active,
kept 90 days, at most 10 MB per session, with no switch to turn it off;
`epimethian-mcp log` (including `--purge-older-than`); receipt line on reads;
`policy.read_budget` (distinct pages per rolling window); `lookup_user` calls are recorded.
