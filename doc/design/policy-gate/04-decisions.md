# 4. Design decisions

Status: design, reviewed 2026-11-25. Not built. D1–D37 are design decisions within analysis
decisions 1–14 ("A1"…"A14" below). D15, D18 and D20 go beyond them and were decided on
2026-11-25, with D22, D23 and D26–D33, from the resolutions of the design review's open
questions. D34–D37 settle review blockers and should-fix items. "Raised by" names the review
role.

Two candidate designs were compared: candidate C (central enforcement, many small modules) and
candidate S (simplest thing, few modules). The design takes C's behaviour and test plan in S's
module footprint; losing positions are listed as alternatives.

## D1. Choke point: edit the existing shim in place

- **Decision:** wrap every handler in the existing `registerTool` shim
  (`src/server/index.ts:1169-1187`); registration throws `UndeclaredToolError` for a registered
  name without a spec (looked up with `Object.hasOwn`) or without an `inputSchema`.
- **Alternatives:** (a) call the gate from each handler; (b) move the shim body into a new
  `register-shim.ts` with an SDK-structural `ToolRegistrar` type (candidate C); (c) an MCP
  gateway with tool-level policy in front of the server.
- **Rationale:** rule 1 and the bypass list in analysis 03 need one choke point a new tool
  cannot skip; (a) is 41 call sites and one forgotten call is a bypass. (b) moves a region W-SDK
  owns in 8.0.0 (plan `:737`). (c) cannot resolve a content ID to its space or post-filter
  listings (build-vs-buy review).
- **Tradeoff:** the gate expression sits in the W-SDK region; D22 sequences around it.

## D2. Declarative spec table over `KnownTool`, args read only through grammar-checking combinators

- **Decision:** `GATE_SPECS satisfies Record<KnownTool, GateSpec>`; targets built with
  `contentArg`, `spaceArg`, `optional`, `allOf`, … that expose `argNames` and enforce the ID and
  key grammars (`CONTENT_ID_RE`, `SPACE_KEY_RE`). In 8.1.0 each tool module exports its row and
  `GATE_SPECS` is assembled from a typed import list.
- **Alternatives:** S's raw lambdas (`(a) => a.page_id as string`); S's `in-handler` and
  `listing` kinds that let a handler decide; a policy engine (OPA, Cedar, casbin).
- **Rationale:** argument names become inspectable (a test compares them with the emitted
  JSON schema; W-SHAPES rewrites every schema), and an argument string that is not an
  identifier never reaches a resolver, a refusal or a log (M3). An engine adds a runtime blob
  and a second policy language, and space resolution stays outside it.
- **Tradeoff:** one indirection when reading a row; a tool with an unusual ID format needs its
  own combinator.

## D3. Pre-check from arguments, including the budget

- **Decision:** resolve the space from the arguments and decide before the handler runs,
  wherever the arguments name the content or space; reserve the budget slot in the same
  synchronous step when the content id is known, and settle it on the handler outcome. While a
  budget is set, a `count` call without a countable id is denied in every mode (S1, raised by
  security).
- **Alternatives:** post-check every result; decide the budget after the handler (first draft:
  a second decision at release); let an id-less `count` call through uncounted.
- **Rationale:** a refused call fetches no body, writes no attachment file, fills no page cache
  and counts nothing (8.0.0 contract C5). One decision per id removes the window in which two
  calls both pass a pre-check and one is withheld after its body was fetched. An uncounted read
  would be a budget bypass.
- **Tradeoff:** one metadata GET on a cache miss for content tools (none on a hit, none after a
  listing seeded the cache); one extra metadata GET on `download_attachment`.

## D4. Release manifest for listings and title tools; built from response space ids

- **Decision:** `search_pages`, `get_spaces`, `list_pages` and `get_recent_changes` (always,
  also with `spaces[]`) attach a symbol-keyed manifest of released spaces; the title tools attach
  a content-id manifest (explicit empty manifest when not found); both in step A. Manifests are
  built from response space ids via `getSpaceById` (or a response `space` expansion), never from
  arguments; missing or out of scope → whole result withheld; a manifest tool's error result is
  replaced by a fixed text naming only the status class. Other content reads may attach one
  optional item, checked when present.
- **Alternatives:** trust the listing handlers' own filtering (candidate S's `filterBySpace`
  without a post-check); a manifest for every tool; title-tool manifests in step B (first
  draft); `get_recent_changes` without a manifest when `spaces[]` is given (first draft).
- **Rationale:** trusting the handler makes the boundary depend on handler bodies that W-SHAPES
  and later lanes edit. Arguments must not feed the manifest: `searchPagesByTitle` falls back
  to the argument key (`confluence-client.ts:2463`). The review found that the step-A title
  tools and `get_recent_changes` with `spaces[]` trusted the handler body (X7, D34).
- **Tradeoff:** a handler bug withholds a whole listing (harsh, never leaky).

## D5. Scope grammar `KEY | ~* | !KEY`; no global wildcard

- **Decision:** exact keys (charset `SPACE_KEY_RE`), all personal spaces (by response type),
  deny exceptions. No `*`; the picker has no "all spaces" option. `read_spaces: []` with
  enforcement denies every read.
- **Alternatives:** candidate S's `*` and `PREFIX*` with `!` exclusions, and an "all spaces"
  picker option; a glob library (picomatch, minimatch).
- **Rationale:** A1 chose an allow list with optional deny patterns because "a deny list alone
  leaves new spaces readable until someone adds them"; `*` plus `!` is that deny list. Personal
  spaces need a pattern (analysis 04, step A), hence `~*`. `[]` mirrors `spaces: []`. A glob
  library brings `*` back.
- **Tradeoff:** a person who wants nearly everything ticks many boxes; new global spaces are
  unreadable until added (the intended default); keys outside the charset that were accepted
  before become invalid on enforcing profiles (Changed entry, D28).

## D6. Decide on the tenant's canonical key and type

- **Decision:** every space key from an argument is grammar-checked and canonicalised through
  the tenant (`findSpaceByKey`), content through `resolveContentSpace`/`getSpaceById`. Allow
  entries match the canonical key exactly; deny entries case-insensitively; `~*` matches the
  response type `personal` (any other v2 type, such as `collaboration`, is not personal). A
  resolved key that fails `SPACE_KEY_RE` makes the target unresolvable. A wrong-case argument
  gets an `Instead: use DEV` hint.
- **Alternatives:** compare argument keys as typed (first draft; let `~x,HR` pass a pre-check
  with `~*` and reach the `keys=` lookup); match arguments case-insensitively against the allow
  list (critique S5).
- **Rationale:** the decision must be about the space the tenant will serve, not about a string
  the agent chose (H1). Case-insensitive argument matching would decide on the argument again;
  if the tenant's lookup is case-insensitive, canonicalisation already gives the same result,
  and if not, the call could not succeed anyway, so a hint is enough. The `SPACE_KEY_RE` check on
  resolved keys keeps a tenant-supplied string out of agent-visible text (S4, raised by
  security).
- **Tradeoff:** one GET the first time a key is seen per process.

## D7. Module footprint

- **Decision:** seven new modules (`shared/policy.ts`, `server/gate-core.ts`, `server/gate.ts`,
  `server/read-log.ts`, `cli/terminal.ts`, `cli/policy.ts`, `cli/log.ts`) plus an import-scan
  test.
- **Alternatives:** candidate C's ~20 files (`src/server/gate/*`, `shared/policy/*`,
  `registry-load.ts`, `jsonl-log.ts`, `space-picker.ts`, `recovery-text.ts`, `audit-read.ts`).
- **Rationale:** the pure/shell split and the one-way rule keep verification cheap; the file
  count does not. Fewer files mean fewer cross-file contracts for a parallel build.
  `cli/terminal.ts` exists because `cli/profiles.ts` and `cli/policy.ts` both need
  `requireTerminal` (S14).
- **Tradeoff:** `gate-core.ts` is large (specs, decision, renderers, ledger); its sections are
  independent and separately tested.

## D8. Three-state registry read; recovery mode with a reason

- **Decision:** `readRegistry()` returns `absent | ok | unreadable(reason)`, reading through
  `safeOpenReadWithStat` (mode, owner uid, directory chain, S7 raised by security); the server
  starts recovery mode on `unreadable`; CLI writers refuse before writing; `setup` and
  `profiles --remove` check the registry before touching the keychain. Active-profile setting
  validation joins in step A (recovery only for enforcing profiles, D28). Lookups use
  `Object.hasOwn`. A `JSON.parse` message is never passed on; line and column come from the
  digits of the error position only and are optional (S5, raised by best practices).
- **Alternatives:** keep fail-open with a louder warning; refuse to start (the client shows a
  generic connection error); validate every profile.
- **Rationale:** A6; rule 8. Validating only the active profile keeps one broken profile from
  taking down servers of others. Node ≥ 20 can quote input in a parse message.
- **Tradeoff:** a file that used to "work" while broken (group-writable, symlinked, owned by
  another user) now stops the server until fixed; the Fixed entry names the fix commands.

## D9. Change detection: one `lstat` per call, single flight

- **Decision:** compare one `lstat({bigint: true})` per tool call with the last observation
  (fingerprint, `absent` or errno), stored whatever the read outcome; reload and re-project only
  when it differs; concurrent calls share one refresh, whose promise is cleared in `finally`.
- **Alternatives:** `fs.watch` or chokidar; a timer; re-reading the file on every call; keeping a
  fingerprint only for `ok` reads (first draft).
- **Rationale:** A9; deterministic, no watcher lifecycle, survives atomic rename, testable with
  a fake fingerprint. Taking the fingerprint from the fd that was read closes the gap between a
  stat and a later read. Storing the observation in broken states stops a re-read of the file
  and the keychain on every call (S16, raised by event-driven). Nanosecond times mostly close
  the same-second edit gap.
- **Tradeoff:** an edit preserving inode, size and both nanosecond times is missed.

## D10. Read log on the mutation log's helpers; no audit-off switch

- **Decision:** `mutation-log.ts` exports its open and sweep code with a `prefix` and a
  retention; `read-log.ts` uses it with `reads-`, `O_EXCL` only, a session hex in the name and
  `verifyDirChain`. The read log is on whenever the policy is on or an anchor exists; there is
  no `audit: off` setting. Retention and caps: D29.
- **Alternatives:** candidate C's extracted `jsonl-log.ts` and an `audit: "on" | "off"` key in
  the `policy` block; an environment switch like `EPIMETHIAN_MUTATION_LOG`; pino with
  pino-roll.
- **Rationale:** reuse without a new library (a dependency for about 30 lines). An off switch is
  a one-line way to remove the record that the tamper-evidence argument relies on; A12 covers
  "cannot write" by continuing.
- **Tradeoff:** a person who wants the policy without the log cannot have it; deleting the
  files or using `log --purge-older-than` is the only way to remove records.

## D11. Budget: rolling-window ledger keyed on content ID, with holders

- **Decision:** distinct content ids in a rolling window; reserved in the pre phase (D3); each
  entry counts the calls holding it and whether it was released; a failed call removes an id
  only when no call holds it and it was never released (S2, raised by reliability); the refusal
  states when the next page frees up; injected clock. The ledger records while the policy is on
  even without a budget, pruned at 60 minutes, so turning a budget on counts recent pages (N3).
- **Alternatives:** candidate S's fixed window that starts at the first counted read; a
  per-process count; counting calls; an empty ledger until a budget is set; a plain
  id → timestamp map with unreserve on failure (first draft); lru-cache with a TTL.
- **Rationale:** analysis 06 §10 (count distinct pages, warn before the cap, say when it
  resets). A rolling window frees capacity continuously. The first draft undercounted when one
  call failed after another had released the same page. A library cache is not pure with a
  pinned clock.
- **Tradeoff:** the "reset time" is the next free slot, not a full reset; the ledger holds one
  entry per id read in the last hour.

## D12. Registry writes: durable, locked, one writer core (revised 2026-11-25)

- **Decision:** every CLI writer goes through `writeWithAnchor` (02 §1.1): an `O_EXCL` lock
  file, read, refuse on an unreadable file, merge, `.bak` (D36), `safeAtomicWrite` (temp
  `O_EXCL|O_NOFOLLOW` 0600, fsync, rename, directory fsync best effort, D30), an `lstat` compare
  before the rename with up to three re-applies, unknown top-level keys preserved, stale temps
  swept. `safeAtomicWrite` lives in `src/shared/safe-fs.ts` and is reused for
  `update-check.json`.
- **Alternatives:** no compare-and-swap, accept the lost update (first draft); candidate C's
  fingerprint compare-and-swap alone; `proper-lockfile`; `write-file-atomic`.
- **Raised by:** reliability, security, build-vs-buy (S3, S38).
- **Rationale:** the data-loss paths (overwrite after a failed read, torn write on a crash,
  dropped unknown keys) were closed in the first draft; the review showed that two writers
  could also drop the `policy` block after another writer anchored it (X1). A lock file is
  about 15 lines without a dependency; `write-file-atomic` lacks directory fsync, `.bak` and
  `O_NOFOLLOW`.
- **Tradeoff:** a crashed writer leaves a lock that blocks others for up to 60 s; hand edits
  are not locked (the pre-rename `lstat` narrows that window, it does not close it).

## D13. One registry read at startup feeds posture and tools

- **Decision:** `main()` reads the registry once and passes it to the first `getConfig()` and
  to `registerTools`; with SDK 2.x this happens before the `serveStdio` factory.
- **Alternatives:** keep the two independent reads (`confluence-client.ts:259`,
  `index.ts:1123-1125`).
- **Rationale:** rule 1 ("one loader … so they cannot disagree"); a per-request factory must not
  re-read (plan `:439-442`).
- **Tradeoff:** `getConfig` gains an optional parameter used only by `main()`.

## D14. Refusal shape: five labelled lines, identifier-only input

- **Decision:** `Withheld [CODE]:` (`Not performed [CODE]:` for writes), `Rule:`,
  `For the person:`, `Instead:`, `Restart:`; the builder's input type cannot hold a title, body,
  name or unchecked argument string; `policy allow <KEY>` is named only for a resolver-derived,
  non-personal key; a personal space appears as "a personal space". Line 1 says the refusal is
  final for this call until the person says the policy was changed (X4, raised by usability).
- **Alternatives:** candidate S's separate header line `Refused (CODE).` plus five labels;
  candidate C's `Person can run:` / `Agent can instead:` labels; "do not retry" without a
  condition (first draft).
- **Rationale:** rule 5's five parts in five lines, with S's plainer labels; the code stays on
  line 1. A command built from an agent-chosen string would hand the person an agent-written
  command (M3). An unconditional "do not retry" outlived the fix.
- **Tradeoff:** the labels address the agent and the person in one text.

## D15. Write ceiling (decided 2026-11-25)

- **Status:** beyond A1–A14; confirmed 2026-11-25 (review resolution 3).
- **Decision:** when `read_spaces_enforced` is true, a write tool whose target space is
  outside the read scope is refused before its handler runs (`POLICY_WRITE_OUTSIDE_READ_SCOPE`).
  Applies to every write tool, including `create_page` (space and parent), `create_comment`
  (page and parent comment), `resolve_comment`, `delete_comment` (by the comment's container)
  and `authorise_destructive_writes` (every id in `page_ids`). `spaces` is still checked by the
  handler; both must pass.
- **Context:** analysis 03 lists "write tools that echo content back: diffs, section reads
  before an update" as a bypass.
- **Alternatives:** (a) no ceiling, document the echo bypass; (b) strip echoed content from
  write results outside the read scope; (c) intersect automatically by rewriting `spaces`.
- **Rationale:** consistent with decision 9 and closes the write-response bypass. (b) touches
  every write handler's output; (c) is a silent rewrite (analysis 05, "decision only, never a
  silent rewrite").
- **Tradeoff:** a behaviour change for profiles with `spaces` wider than `read_spaces`; its own
  "Changed" entry; `policy` names the effective write set (intersection).

## D16. Change note on final results only

- **Decision:** the note goes on the next final result; an 8.0.0 `input_required` result does
  not consume it. It is its own text block, after the handler's blocks on a result with
  `structuredContent` (S20, raised by best practices).
- **Alternatives:** next result of any kind; only on reads; always prepended (first draft).
- **Rationale:** a non-final result is re-issued by the client after elicitation; a note there
  may be dropped or shown twice. Eight write tools declare `outputSchema`; the wrapper must
  return their whole result.
- **Tradeoff:** a note can wait across an elicitation round trip.

## D17. `policy allow <KEY>` is the one command refusals name

- **Decision:** terminal required (stdin TTY, confirmation read from `/dev/tty`; stdout may be
  piped), key validated against the tenant (`findSpaceByKey`), canonical key written. Plain
  form widens reads; `--write` widens writes only (D32). The same terminal requirement is added
  to `profiles --set-read-write`.
- **Alternatives:** name `policy setup` (candidate S); a non-interactive flag form; stdin TTY
  only (first draft); stdin and stdout TTY (second draft); MCP elicitation.
- **Rationale:** rule 5 asks for one exact command; `policy setup` is a full re-pick. The
  terminal requirement keeps an agent with a shell from running the fix the refusal hands it.
  It is a speed bump: `script`, `expect` or a pseudo-terminal defeat it, and the docs say so.
  Requiring a stdout TTY added nothing the `/dev/tty` read does not already give. The agent can
  answer soft elicitation, so elicitation must not widen scope in step A.
- **Tradeoff:** typed keys go against analysis 06 §3; validation against the tenant closes the
  silent-mismatch risk that finding names. A personal space is not named in refusals, so its
  refusal names `policy setup`.

## D18. `spaces` and `redact_patterns` are hot as well (decided 2026-11-25)

- **Status:** beyond A9 (which names the read policy); confirmed 2026-11-25 (resolution 3).
- **Decision:** the write allowlist and the redaction patterns are read from the policy
  snapshot on every call; refusals never need a restart for space changes. Every "no restart
  needed" line uses one wording: `policy changes apply on the next tool call` (S32).
- **Alternatives:** keep them fixed at startup (`index.ts:1130`, `:1141`).
- **Rationale:** A9 aims at "a fix that needs a restart looks like a broken feature"; a refusal
  that names `policy allow HR --write` must work without a restart.
- **Tradeoff:** an agent with file access loses a restart speed bump for writes too.

## D19. Unreadable mid-session always denies

- **Decision:** an unreadable registry mid-session denies every gated call (except
  `get_version`, `upgrade`) whether the session started with a policy or not, after one re-read
  for a torn save (D35); the request flow checks it before "policy off". A registry or profile
  entry that disappears denies after an `on` start when no anchor exists; with an anchor, the
  anchor is enforced (03 §5.3, the anchor row wins).
- **Alternatives:** deny only after an `on` start; deny also when an anchor exists (first
  draft).
- **Rationale:** A6; the same file would start recovery mode on the next start. With an anchor
  the policy is known, so enforcing it is narrower than off and more useful than a deny.
- **Tradeoff:** a profile without a policy is blocked by a broken file mid-session until fixed.

## D20. Gate settings never need a restart; no restart-pending detection (decided 2026-11-25)

- **Status:** confirmed 2026-11-25 (resolution 3; S11 raised by completeness: the first draft
  dropped "restart pending" without flagging it).
- **Decision:** gate settings (`read_spaces`, `read_spaces_enforced`, `spaces`,
  `redact_patterns`, `policy`) never need a restart, and `policy` says so. It names a restart
  only for settings that change tool registration (posture, `readOnly`, `allowed_tools`,
  `denied_tools`); the change note says so when the startup hash changed. `policy` does not
  report whether a running server is stale.
- **Alternatives:** scan read logs for live PIDs and compare startup hashes (first draft).
- **Rationale:** PID liveness is unreliable (reuse) and depends on the log; the note already
  reaches the session that needs the restart (N1).
- **Tradeoff:** `policy` cannot name which running server is stale.

## D21. Scope in `read_spaces`, new values in `policy`

- **Decision:** the scope stays in `read_spaces` + `read_spaces_enforced` (A7); values that
  are new (budget now; step-C/D keys later) go in the strict `policy` block (A8).
  `projectPolicy` folds both, and the anchor, into one `EffectivePolicy`, which is what every
  consumer sees and what is hashed.
- **Alternatives:** move the scope into the `policy` block; put the budget at the top level of
  the settings.
- **Rationale:** A7 forbids a new scope setting; A8 asks for one block that can later be
  referenced by name.
- **Step D:** a named policy will be a `policy` block stored under a name and referenced from
  the profile; it will carry a `read_spaces` (same grammar). The profile's own `read_spaces`
  then acts as a ceiling: the effective scope is the intersection, so a named policy can narrow
  but never widen what the profile allows (consistent with A10's "cannot widen", and with the
  anchor's `ceiling` slot).

## D22. Sequencing against 8.0.0 (decided 2026-11-25)

- **Decision:** step 0 ships now as 7.6.1 on SDK 1.x; W-SDK carries its two `index.ts` hunks
  into `serveStdio`. Step A lands after 8.0.0, written once against SDK 2.x
  (`@modelcontextprotocol/server` 2.4.x, handler `ctx`, `serveStdio(factory)`, Node ≥ 20) and the
  post-W-SHAPES `index.ts`. There is no 7.7.0. Step B follows A. The decision-14 live check (P1)
  runs this week, before the test token is revoked around 2026-11-29.
- **Raised by:** cost (X6), resolution 2.
- **Context:** analysis decision 13 lets A land before 8.0.0 only if it is ready in time,
  "otherwise A waits". H1–H6 are in the region W-SDK owns (plan `:737`). 8.0.0 must be on npm in
  early January with three weeks for field reports, so W-SDK starts in about early December; one
  maintainer cannot build 7.7.0 and 8.0.0 in that window.
- **Alternatives:** build A in parallel with W-SDK and rebase (first draft); 7.7.0 before W-SDK
  starts, decided at the 7.6.1 checkpoint (second draft).
- **Rationale:** a rebase of guard code over an SDK migration is exactly the merge the 8.0.0
  plan avoids by giving W-SDK sole ownership; writing H3–H10 once against SDK 2.x removes the
  "re-apply on SDK 2.x" contingency.
- **Tradeoff:** the read boundary reaches users about two months later; until then
  `read_spaces_enforced` keeps its 7.6.0 meaning (search only).

## D23. Keychain anchor: set iff on, stores the policy, intersection on mismatch (decided 2026-11-25)

- **Decision:** the anchor (its own keychain item, D26) stores the canonical enforced scope,
  the enforced flag and the budget. It is set if and only if the written projection is `on`,
  otherwise cleared, and only through `writeWithAnchor` (kind `policy`, after a terminal
  confirmation); the anchor is written after reading back the committed registry, under the
  writer lock. On a mismatch the gate enforces the intersection of file and anchor (the file may
  narrow, never widen) until a terminal `policy setup` or `policy allow` re-anchors.
  `readPolicyAnchor` is tri-state (`present | absent | error`) with a 2,000 ms timeout; `error`
  keeps the last anchor; moving from on to off needs a positive `absent`. With no anchor known
  and the file on, an error denies (`anchor-unreadable`).
- **Raised by:** completeness, security, reliability, event-driven, cost (X1, X2); resolution 1.
- **Alternatives:** none (absent file = off, first draft); a hash of the effective policy in the
  credential record with recovery mode on `policy-missing` (second draft); defer the anchor to
  step C (cost reviewer); a second file next to the registry.
- **Rationale:** without an anchor, a deleted or hand-edited registry silently switches the
  boundary off, which is the accident the gate exists for. The second draft had four defects:
  an anchor written for an `off` projection locked a search-default profile into recovery mode;
  the hash covered `spaces` and `redact_patterns`, which other CLI writers change, so every
  legitimate edit read as tampering; a hand edit that widened `read_spaces` applied with only a
  note, and removing `read_spaces_enforced` while a budget stayed kept the state `on` so the
  check never fired; a failed keychain read counted as "no anchor". Storing the policy itself
  lets the gate compute the intersection instead of choosing between "accept the file" and
  "refuse everything". `policy-missing` is no longer a recovery reason: a removed policy with an
  anchor is the extreme mismatch and enforces the anchor.
- **Tradeoff:** a same-user agent with keychain access can still remove or rewrite the anchor
  (stated in `06-limitations.md`); one keychain read per startup and per detected file change;
  a crash between file and anchor writes narrows until the command is repeated. Profiles that
  enforce today get no anchor until `policy setup` runs once.

## D24. Search is never sent unscoped; withheld counts stay out of the agent's view

- **Decision:** if the scope cannot be expressed in CQL (only `~*` and the personal disjunct is
  not usable), search is refused (`POLICY_SEARCH_NOT_SCOPABLE`); listing results say only "some
  results were withheld"; the count goes to the read log.
- **Alternatives:** send the query unscoped and post-filter (candidate S when patterns could not
  be expressed); state the count (first draft).
- **Rationale:** an unscoped query returns out-of-scope hits to the server and makes the hit
  count a side channel (M7).
- **Tradeoff:** a personal-spaces-only scope cannot search.

## D25. Step A records denies in the profile audit log, capped

- **Decision:** before the read log exists, each gate deny appends one line to `audit.log`
  (code, tool, ID or key, profile), at most 1,000 per process, then one `further denies
  suppressed` line (resolution 7).
- **Alternatives:** no record until step B; no cap (first draft); size rotation of `audit.log`.
- **Rationale:** refusals must not be invisible to the person until B (critique S7). A runaway
  loop must not grow a file that has no rotation (S17, raised by event-driven).
- **Tradeoff:** a text log without a reader; denies past the cap in one process are not
  recorded; step B moves denies to the JSONL log.

## D26. The anchor is its own keychain item (decided 2026-11-25)

- **Decision:** account `policy-anchor/<profile>` under the credentials' service; the
  credential record and `readFromKeychain` are unchanged. `profiles --remove` clears it with the
  credentials.
- **Raised by:** reliability, security, build-vs-buy (S3); resolution 4.
- **Alternatives:** a `policyAnchor` field in `KeychainCredentials` (second draft); keytar; a
  second file.
- **Rationale:** a field in the credential blob is read-modify-written by the opportunistic seal
  re-save and by `setup`, which risks a lost anchor or a stale token written back. A separate
  item has one writer.
- **Tradeoff:** two keychain reads at startup instead of one; on macOS the first access to the
  new item may prompt (R23).

## D27. `lookup_user` stays allowed, is logged, and is outside the space scope (decided 2026-11-25)

- **Decision:** `lookup_user` stays exempt in step A (denied only while the registry is
  unreadable); step B records its allows in the read log (tool and decision, no query); the docs
  say it is outside the space scope until step E decides it.
- **Raised by:** security (S6); resolution 5.
- **Alternatives:** deny it under enforcement; leave it exempt and unlogged (first draft).
- **Rationale:** denying it breaks mentions and owner lookups; it returns tenant-wide contact
  data, so at least the fact of each lookup must be visible.
- **Tradeoff:** e-mail addresses from any space remain readable until step E (R27).

## D28. Recovery mode for invalid settings only on enforcing profiles (decided 2026-11-25)

- **Decision:** invalid gate settings on a profile that enforces (`read_spaces_enforced: true`
  in the file, or an anchor that says enforced) start recovery mode and deny mid-session. On any
  other profile, the invalid entry is dropped, warned about on stderr and in `policy`, and
  ignored. A whole-file read failure (step 0) still starts recovery mode for every profile.
- **Raised by:** cost (S36); resolution 6.
- **Alternatives:** recovery mode for every profile (first draft).
- **Rationale:** the narrowed key charset would otherwise break search-default configurations
  that work today; for a non-enforcing profile the setting is a search convenience, not a
  boundary.
- **Tradeoff:** an invalid budget on a non-enforcing profile is ignored, so that profile reads
  without the budget until the entry is fixed (`policy` says so).

## D29. Read-log retention and caps (decided 2026-11-25)

- **Decision:** read-log files are kept 90 days (swept when a server opens a log); each file is
  capped at 10 MB, after which `append` returns `EFBIG` into the decision-12 `droppedBefore`
  path; `log --purge-older-than <days>` ships in step B. Step-A deny lines in `audit.log` are
  capped per process (D25).
- **Raised by:** event-driven, completeness, cost (S17), compliance (S27); resolution 7.
- **Alternatives:** 30 days with no size cap (first draft); size rotation into new files.
- **Rationale:** 30 days can be shorter than incident discovery; a runaway loop writes about
  12 MB an hour; caps make growth enforced, not advised.
- **Tradeoff:** a session that hits the cap stops recording reads (the receipt and `log` show
  it); 90 days of a heavy user is a few hundred MB.

## D30. Directory fsync is best effort (decided 2026-11-25)

- **Decision:** after a successful rename, the directory fsync is skipped on Windows; elsewhere
  a failure is a warning on stderr, not a write failure.
- **Raised by:** best practices, reliability (S19); resolution 8.
- **Alternatives:** fail the write when the directory fsync fails; decide Windows support first.
- **Rationale:** the rename has already happened, so failing would report an error for a write
  that took effect. Safe whether or not Windows is supported (the keychain module does not
  support it today).
- **Tradeoff:** on a power loss right after the warning, the rename may not be durable.

## D31. CLI flags via `node:util` `parseArgs` (decided 2026-11-25)

- **Decision:** new CLI flags are parsed with `parseArgs` (`strict: true`). It needs Node ≥ 18.3;
  step A runs on 8.0.0's Node ≥ 20 floor, so `engines` needs no further change.
- **Raised by:** build-vs-buy (S38); resolution 9.
- **Alternatives:** hand-parsed argv (first draft); a CLI argument library.
- **Rationale:** built in; no hand-written parsers; no new dependency.
- **Tradeoff:** existing commands keep their hand parsing until touched.

## D32. `policy allow <KEY> --write` widens writes only (decided 2026-11-25)

- **Decision:** plain `policy allow <KEY>` widens reads only; `--write` widens writes only. The
  write-allowlist refusal (`SpaceNotAllowedError`) names the `--write` form. The write-ceiling
  refusal names the plain form, and adds the `--write` form when the space is not in `spaces`.
- **Raised by:** completeness (S12); resolution 10.
- **Alternatives:** `--write` widens reads and writes (first draft); `--write` widens both and
  the refusal says so.
- **Rationale:** one command, one effect; a person who allows writes does not silently allow
  reads.
- **Tradeoff:** a space that needs both takes two commands, and the ceiling refusal names both.

## D33. Listing records carry content IDs (decided 2026-11-25)

- **Decision:** listing records in the read log carry up to 100 released content IDs and a count
  of the rest, from the manifest.
- **Raised by:** compliance (S26); resolution 11.
- **Alternatives:** spaces and counts only (first draft); every ID.
- **Rationale:** incident scoping needs to name which excerpts went out; IDs are identifiers
  only (rule 6).
- **Tradeoff:** larger listing records (about 2.5 KB); a listing past 100 items is scoped by
  count.

## D34. `decideRead` has no default allow

- **Decision:** `decideRead` is an exhaustive switch whose `default` is `never`; the last table
  row denies `GATE_TARGET_UNCHECKED`. Allows are listed per (phase, class, target kind).
  `get_recent_changes` always needs its manifest; the title-tool content-id manifest (H10) is in
  step A.
- **Raised by:** security, completeness (X7, promoted in synthesis).
- **Alternatives:** a final "otherwise allow" row (first draft).
- **Rationale:** both reviewers found the same fail-open path (`deferred`/`none` targets on a
  non-manifest spec), which contradicts D4's "never trust handler bodies".
- **Tradeoff:** a new target kind fails closed until a row allows it; H10 moves into step A.

## D35. One re-read after a torn save; refusals that outlive the fix are conditional

- **Decision:** a mid-session parse error or `ENOENT` is re-`lstat`ed and re-read once after
  75 ms before it counts. The mid-session `POLICY_UNREADABLE` text says the person can call
  again once after saving. `invalid-settings` names `policy setup --profile <p>`, which proceeds
  when only the active profile's gate settings are invalid. An empty pick in `policy setup` asks
  before saving deny-all.
- **Raised by:** usability, reliability, event-driven (X4).
- **Alternatives:** report the first read as final (first draft); a longer debounce timer.
- **Rationale:** non-atomic editor saves (truncate and write, rename-away) produce a short
  parse error or `ENOENT`; reporting it as final strands the agent. The old fix line named a
  command that printed the same error.
- **Tradeoff:** a call in a torn save waits 75 ms once.

## D36. `.bak` is "the version before the last CLI change"

- **Decision:** `.bak` holds the bytes of the readable file before the last CLI write, fsynced;
  it is never touched when the registry is absent. Texts call it "the version before the last
  CLI change" and point to `policy --check`, which compares it with the anchor before suggesting
  a restore. A restored `.bak` that differs from the anchor is enforced as an intersection until
  `policy setup` runs, so it cannot widen.
- **Raised by:** reliability, security (X3).
- **Alternatives:** present `.bak` as "the last good file" (first draft); several numbered
  backups.
- **Rationale:** one `setup` run writes several times, so `.bak` is one write behind; restoring
  it could silently undo the last policy change or restore a wider scope, and writing it when the
  registry is absent could overwrite the only copy of every other profile.
- **Tradeoff:** `.bak` is a single step back, not a history.

## D37. Agent-facing text: pinned codes and prefixes, no personal keys, short suffixes

- **Decision:** contracts and tests pin the deny codes, the five refusal prefixes, the receipt
  prefix and the line-1 phrase "This is final for this call"; the rest of each message may be
  reworded, and docs cite codes. Refusals, receipts, instructions and description suffixes never
  show a personal space key; they say "a personal space" (local `policy` and `log` output keeps
  keys). Only `get_page` and the four listing tools name the readable spaces in their
  description; the others carry ` Read policy applies; see instructions.`
- **Raised by:** cost (S34, S35), compliance (S25).
- **Alternatives:** freeze whole messages (first draft); name the spaces on every gated tool
  (first draft); call `RegisteredTool.update()` after a change (best practices, optional).
- **Rationale:** frozen whole messages turn every copy fix into a contract change; the suffix
  on every tool cost about 800 tokens per session and went stale after a change; personal space
  keys are `~<accountId>`.
- **Tradeoff:** a refusal for a personal space cannot name the one-line `policy allow` fix and
  names `policy setup` instead.
