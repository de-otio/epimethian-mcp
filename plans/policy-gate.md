# Plan: Policy gate (steps 0, A, B)

**Status:** proposed, revised 2026-11-25 to match the reviewed design. Nothing here is
implemented.
**Base:** step 0 on `master` at **7.6.0** (`15d5ebe`); steps A and B on `master` after 8.0.0
has merged.
**Inputs:** the design in [doc/design/policy-gate/](../doc/design/policy-gate/00-overview.md)
(reviewed 2026-11-25; D1–D37) and the analysis in
[doc/analysis/policy-gate/](../doc/analysis/policy-gate/README.md) (decisions 1–14 final). D15
(write ceiling), D18 (hot `spaces`/`redact_patterns`) and D20 (restart wording) are confirmed.
This plan sequences the build against
[next-release-sdk2-and-v2-api.md](next-release-sdk2-and-v2-api.md) (8.0.0 and 8.1.0).

## 1. Releases

| Release | Contents | Why grouped |
|---|---|---|
| **7.6.1** (patch, SDK 1.x, Node ≥ 18) | Step 0: three-state registry read with owner-uid and directory-chain checks (`safeOpenReadWithStat`), recovery mode with a reason, one durable and locked writer core (`safeAtomicWrite`, lock file, `.bak`, unknown keys kept), CLI preflights, write-allowlist message fix | Fixes a live data-loss path and a fail-open today; no new feature, no new setting, no new CLI flag |
| **A-release** (minor, after 8.1.0; provisionally **8.2.0**) | Step A, written once against SDK 2.x and Node ≥ 20: read scope on every tool through the shim, keychain anchor, `policy`/`policy setup`/`policy allow`, scope in instructions and descriptions, change note, `audit.log` deny lines, write ceiling (D15), hot `spaces`/`redact_patterns` (D18) | One concept (a list of spaces); verifiable with the behavioural matrix |
| **B-release** (the minor after the A-release; provisionally **8.3.0**) | Step B: read log, receipts, distinct-page budget, `log` | Builds on the 8.0.0 handler context (client label) and step A's gate |

**There is no 7.7.0.** Step A is built after 8.0.0 against SDK 2.x, so it never rebases over
the SDK migration and W-SDK never rebases over it (design D22).

**Version numbers (answer to design Q13, decided 2026-11-25).** The A-release is the first
minor after 8.1.0, because the 8.0.0 plan assigns 8.1.0 to contract C6 and W-META-8.1. That
is 8.2.0 provisionally: the 8.0.0 plan also names 8.2.0 as the earliest slot for the deferred
copy and archive tools, so if one of those is scheduled first, the A-release takes the next
free number and B the one after. The number is fixed at the A checkpoint (CHANGELOG heading,
`package.json`, rollback pins), not earlier. The build may start once 8.0.0 is on `master`;
W-WIRE (the only lane that edits handlers) starts after 8.1.0 has merged, or the orchestrator
decides at the gate before it (§3) whether to wait or to take H7–H10 against `index.ts`
(design 01 §1.5: if C6 has moved handlers into `src/server/tools/`, those hunks land there).

Branches:

| Branch | Off | Merged into | Forward-merge owner |
|---|---|---|---|
| `release/7.6.1` | `master` at 7.6.0 | `master` (7.6.1 tag) | orchestrator merges `master` into `release/8.0.0` the same day; conflicts in `main()` and `startRecoveryServer` (H1, H2) are resolved by one Opus agent so W-SDK's `serveStdio` hunk keeps both changes |
| `release/8.x-policy-a` | `master` after 8.0.0 merges | `master` (A-release tag) | – |
| `release/8.x-policy-b` | `master` after step A has merged | `master` (B-release tag) | – |

Target for 7.6.1: on `master` before W-SDK starts (about early December), so the SDK migration
carries H1–H2 once.

## 2. Verified facts this plan relies on

Line numbers are `master` at 7.6.0 (design [01](../doc/design/policy-gate/01-architecture.md),
[02](../doc/design/policy-gate/02-interfaces.md)). Step 0 uses them as they are; W-CONTRACT-A
re-anchors every one against `master` after 8.0.0 before step A builds on it. The ones a lane
must not re-derive:

- The `registerTool` shim is `src/server/index.ts:1169-1187`; the handler is `rest[1]`.
  `KNOWN_TOOLS` has 41 names (`src/server/tool-allowlist.ts`); `setup_profile` is only on the
  recovery server (`:6296`).
- `readFullRegistry` (`src/shared/profiles.ts:177-238`) returns `{profiles: []}` on every
  failure; the writers (`:275-315`) then overwrite the file. The read path checks the mode
  only (`src/shared/safe-fs.ts:48-58`); `verifyDirChain` is `safe-fs.ts:182`.
- `main()` (`:6326`) calls `getConfig()` before `validateStartup`; `getConfig` reads the registry
  at `confluence-client.ts:259`, `registerTools` again at `index.ts:1123-1125`.
- `resolveContentSpace` (`space-allowlist.ts:121`) caches successes 5 min; `getSpaceKeyById`
  (`confluence-client.ts:1527`) caches per process; `resolveSpaceId` (`:1469`) uses
  `/spaces?keys=`; `searchPagesByTitle` falls back to the argument key (`:2463`).
- Keychain re-save drops fields `readFromKeychain` (`keychain.ts:235`) does not copy; this is
  why the anchor is its own keychain item (D26).
- Mutation log opens with an `O_EXCL` fallback (`mutation-log.ts:198-207`) and sweeps
  `mutations-*` (`:146`).
- `profiles --set-read-write` (`src/cli/profiles.ts:45-54`) runs without a terminal.
- `update-check.json` is written in `src/shared/update-check.ts`; it adopts `safeAtomicWrite`.

**P1 live check results** (filled in when P1 has run; see §10):

| Item (06 Precondition) | Site | Gateway |
|---|---|---|
| 1. metadata `spaceId` + `GET /spaces/{id}` `key`,`type` | – | – |
| 2. `/spaces?keys=` exact / wrong case (Q2) | – | – |
| 3. CQL `space.type = "personal"` (Q5) | – | – |
| 4. `/spaces` `_links.next` paging | – | – |
| 5. `GET /pages?id=…` with several ids returns each `spaceId` | – | – |

**Keychain "not found" exit codes (design assumption 9, R29):**

| Case | macOS `security` | Linux `secret-tool` |
|---|---|---|
| Item does not exist (must be `absent`) | – (expected 44) | – (expected 1, empty output) |
| Locked keychain, denied prompt, timeout (must be `error`) | – | – |

## 3. Dependency DAG

```
NOW, independent of everything below (human, this week, before the token is revoked ~2026-11-29):
  P1: decision-14 live check (items 1-5)  +  local keychain exit-code check (assumption 9)
  │
Phase 0 (orchestrator): branch release/7.6.1 off master at 7.6.0; npm ci; full suite green
  │
  ├── Lane 1: W-STEP0  (one Opus agent, sequential commits; no contract wave)      ── Opus, high
  ├── Lane 2: W-DOC0   (CHANGELOG Fixed, agent guide, 04-setup, README notes)      ── Sonnet, medium
  ▼
I-0: merge W-STEP0, then W-DOC0 → W-REVIEW-0 (security-reviewer + orchestrator data-loss walk)
  → fixes by the W-STEP0 agent → 7.6.1 checkpoint → forward-merge into release/8.0.0
  ▼
  ... 8.0.0 builds and ships (W-SDK carries H1-H2) ... 8.1.0 ...
  ▼
Branch release/8.x-policy-a off master after 8.0.0 (P1 recorded in §2)
  ├── Wave A-C: W-CONTRACT-A (re-anchor facts, C3-C8 types, CORE_SPECS, requireTerminal stub) ── Opus, high
  ▼
  ├── Wave A-B (parallel; ≤4 test-running agents; the docs lane runs only its two doc tests)
  │     lane 1: W-CORE    (gate-core.ts: decideRead, combinators, refusal, manifest, copy test) ── Opus, high
  │     lane 2: W-POLICY  (shared/policy.ts, config.ts, cql-scope.ts)                           ── Sonnet, high
  │     lane 3: W-SHELL   (gate.ts, client functions, space-allowlist seed and message)         ── Opus, high
  │     lane 4: W-CLI-A   (keychain anchor + writeWithAnchor anchor steps, then terminal.ts,
  │                        cli/policy.ts, status, setup hand-off)                               ── Sonnet, high
  │     lane 5: W-DOC-A   (README, user docs, CHANGELOG, security docs, agent guide, 04-setup)  ── Sonnet, medium
  ▼
I-A1: merge POLICY, CORE, SHELL, CLI-A (fixed order)
  ▼
Gate: orchestrator decides W-WIRE start (8.1.0 merged, or hunks against index.ts)
  ▼
Wave A-W: W-WIRE (sole owner of index.ts and tool modules: H3–H10, seed calls)  ── Opus, high
  ▼
Wave A-T: W-MATRIX (coverage matrix, goldens, integration, write-ceiling tests)  ── Sonnet, high
  ▼
W-REVIEW-A: Opus code review ∥ security-reviewer ∥ test-critic → fixes (Opus) → docs final → A checkpoint
  ▼
Branch release/8.x-policy-b off master after step A has merged
  ├── Wave B-C: W-CONTRACT-B (C10 record schemas, ledger cell)                  ── Opus, high
  ├── Wave B-B (parallel)
  │     lane 1: W-BUDGET  (ledger, reservation, receipt, deny records in gate-core/gate)  ── Sonnet, high
  │     lane 2: W-LOG     (mutation-log helpers, read-log.ts, ReadLog construction in main) ── Sonnet, high
  │     lane 3: W-LOGCLI  (cli/log.ts, policy log lines, setup budget question)           ── Sonnet, medium
  │     lane 4: W-DOC-B   (observability, README, user docs, CHANGELOG, agent guide)      ── Sonnet, medium
  ▼
W-REVIEW-B → fixes → B checkpoint
```

Why each edge exists:

- **No contract wave in step 0:** one builder commits the types first (02 §1.1 and §4 give them
  in full); there is no second lane to code against them.
- **P1 independent of 7.6.1, a precondition of Wave A-C:** the live check decides `personalCql`,
  the case hint, the batch lookup and whether the gateway scoped token can resolve spaces at
  all. The test token is revoked about 2026-11-29, and step A starts about a month later, so
  P1 runs now and its results wait in §2.
- **Contracts first (W-CONTRACT-A/B):** every lane codes against the same types; a type change
  after the wave starts costs a rebase in every lane.
- **W-CLI-A anchors first:** the anchor (keychain item and `writeWithAnchor` anchor steps) is
  the security-critical part of the lane; the orchestrator diff-checks it against 02 §1.1–1.2
  before the CLI commands are built on it.
- **W-WIRE after the lanes:** `index.ts` has one owner per wave; W-WIRE consumes all modules.
- **W-MATRIX after W-WIRE:** the behavioural matrix boots the real `main()`.
- **Step A after 8.0.0:** see §1. It never runs in parallel with W-SDK.

## 4. Cross-workstream contracts

Contracts land as types plus `throw new Error("not implemented")` bodies; lanes replace the
bodies. A lane that needs a contract change stops and asks the orchestrator. Step 0 has no
contract wave: its builder commits the PG-C1/C2 types first.

- **PG-C1. Registry read** (02 §1.1; step 0, first commits of W-STEP0): `safeOpenReadWithStat`,
  `safeAtomicWrite`, `RegistryRead`, `Observation`, `FileFingerprint`, `UnreadableReason` (step-0
  kinds: `parse-error`, `unexpected-shape`, `unsafe-permissions`, `not-regular-file`,
  `io-error`), `Registry` (with `extra`), `RegistryUnreadableError`, `describeUnreadable`,
  `readRegistry`, `registryFingerprint`, `assertRegistryWritable`, `writeWithAnchor` (step-0
  steps 1–3, 6–7 only), `updateProfileSettings`.
- **PG-C2. Recovery** (02 §4; step 0): `RecoveryReason` (`profile-missing`,
  `registry-unreadable`), `recoveryText`, `startRecoveryServer(profile, reason)`. There is no
  `policy-missing` reason: a removed policy with an anchor enforces the anchor (D23).
- **PG-C3. Policy model** (02 §2; Wave A-C): `SPACE_KEY_RE`, `SpaceScope`, `ResolvedSpace`
  (`type: string | undefined`), `EffectivePolicy`, `AnchorState`, `PolicyLoad` (with
  `anchor: "none" | "match" | "mismatch"`), the step-A `UnreadableReason` kinds
  (`invalid-settings`, `removed`, `anchor-unreadable`) and `SettingKey`, `policyBlockSchema`
  (full, incl. `read_budget`), `ToolClass`, signatures of `projectPolicy`, `anchorOf`,
  `reconcileAnchor`, `applyContinuity`, `hashPolicy`, `startupHash`, `inScope`, `cqlScopeOf`,
  renderers.
- **PG-C4. Gate core** (02 §3; Wave A-C): `Target`, `TargetOf`, combinator signatures and
  grammars, `GateSpec`, `CORE_SPECS` (one row per `KnownTool` at the base commit), `ResolvedTarget`,
  `Decision`, `DenyCode`, `Subject`, `Fix`, `Alternative`, `ReleaseManifest`, `RELEASE`,
  `EMPTY_MANIFEST`, `REFUSAL_PREFIXES`.
- **PG-C5. Shell** (02 §5; Wave A-C): `PolicyStore`, `PolicyStoreDeps`, `GateDeps` (incl.
  `denyLine`), `ResolveResult`, `TargetResolver`, `gateHandler` on `CallToolResult`,
  `UndeclaredToolError`, `isFinalResult`.
- **PG-C6. Client additions** (02 §9.2; Wave A-C stubs): `findSpaceByKey`, `getSpaceById`,
  `listAllSpaces`, `getContentSpaces`, `spaceKeyFromResponse`. `getConfig({registry})` is the
  step-0 part, built by W-STEP0.
- **PG-C7. Keychain anchor and terminal** (02 §1.2, §9.1; Wave A-C): `PolicyAnchor`,
  `AnchorRead` (`present | absent | error`), `readPolicyAnchor(profile, {timeoutMs})`,
  `writePolicyAnchor`, `clearPolicyAnchor`; the anchor steps of `writeWithAnchor` (kind
  `policy`: clear first when off; read-back, anchor, `utimes` when on); and the stub
  `requireTerminal()` in `src/cli/terminal.ts` (S14), so `cli/policy.ts` and
  `cli/profiles.ts` code against one signature.
- **PG-C8. Text** (02 §8, §7, §9.3–9.6; D37): the contract wave pins the deny codes, the five
  refusal prefixes, the receipt prefix, the line-1 phrase "This is final for this call" and
  the single restart sentence (`policy changes apply on the next tool call`) as constants.
  The rest of each message may be reworded without a contract change; docs cite codes, not
  whole messages. Personal space keys never appear in agent-facing text.
- **PG-C9. Ordering** (8.0.0 contract C5): before a decision, only GET requests; no
  reservation, no log write, no file write. Enforced by A-T4, A-T10 and B-T4.
- **PG-C10. Step B records** (03 §2) and the ledger cell (02 §3.6, §5). Wave B-C.
- **PG-C11. 8.1.0 tools** (01 §1.6): each tool module exports its `GateSpec` row; `GATE_SPECS`
  is assembled from a typed import list; `register<Tool>` `deps` carries no read gate. The 8.0.0
  plan's C6 states this (added 2026-11-25). If 8.1.0 has already merged without it,
  W-CONTRACT-A writes the rows for the 8.1.0 tools in `CORE_SPECS` and W-WIRE moves each into
  its module.
- **House contracts:** module singletons export `_resetForTests()`; clocks injected; no
  content, titles or argument strings in refusals, receipts or logs.

## 5. Release 7.6.1 workstreams (step 0)

### 5.1 W-STEP0 — registry fail-closed, durable writer, recovery · Opus, high (lane 1)

One agent, sequential commits, one test run at a time. Reason: the writer core, the reader,
`getConfig` and the CLI preflights share `profiles.ts` and one data-loss argument; a second
lane would split a single review.

**Files:** `src/shared/safe-fs.ts` and its test, `src/shared/update-check.ts` (adopts
`safeAtomicWrite`), `src/shared/profiles.ts`, `src/server/confluence-client.ts` (`getConfig`
`:240-275` only), `src/server/index.ts` (H1, H2 and the `recoveryText` type/function next to
`startRecoveryServer`), `src/server/space-allowlist.ts` (`:45-49` message), `src/cli/index.ts`
(error print), `src/cli/setup.ts`, `src/cli/profiles.ts`, and the tests below.

Commits, in order:

1. **0-T1 red first** (`src/shared/registry-fail-closed.test.ts`, marked `.fails`) with the
   reproduction; the PG-C1 and PG-C2 types and stubs.
2. **`safe-fs.ts`:** `safeOpenReadWithStat` (mode, owner uid, `verifyDirChain`, `bigint` stat),
   `safeAtomicWrite` (temp `O_EXCL|O_NOFOLLOW` 0600, fsync, rename, directory fsync best effort,
   D30); `update-check.json` reuses it.
3. **Reader:** `readRegistry` (parse-error position from the digits of the `SyntaxError`
   offset, never the text), `registryFingerprint`, `describeUnreadable` fix table,
   `Object.hasOwn` lookups in `getProfileSettings` and `readProfileRegistry`.
4. **Writer core `writeWithAnchor`** without its anchor steps: lock file (`O_EXCL`, 50 ms retry
   up to 5 s, stale after 60 s with a dead pid), stale-temp sweep (one hour), refuse on
   unreadable before any temp file, `.bak` rules (D36; untouched when the registry is absent),
   pre-rename `lstat` compare with up to three re-applies, unknown top-level keys kept;
   `assertRegistryWritable`; `updateProfileSettings`; every exported writer goes through the
   core.
5. **Startup:** `getConfig({registry})` uses the passed read and propagates
   `RegistryUnreadableError` (no posture fallback); H1 (`main()` reads once, recovery on
   `unreadable`), H2 (`recoveryText`, five-line shape, `.bak` clause only when a backup exists,
   "Restart: needed"); `cli/index.ts` prints `RegistryUnreadableError` without a stack, exit 1.
6. **CLI preflights:** `assertRegistryWritable()` at the start of `runSetup` and the gateway
   path before any prompt that leads to `saveToKeychain` (`:288`, `:491`); same before
   `deleteFromKeychain` in `removeProfile` (`:178`).
7. **Message fix:** `SpaceNotAllowedError` names the `spaces` setting and the file path (no
   non-existent flag); new `src/cli/cli-commands-in-errors.test.ts` (0-T7).

**Tests (all of 06 Step 0):** 0-T1 `registry-fail-closed.test.ts`; 0-T2, 0-T3, 0-T9, 0-T10,
0-T11, 0-T12 in `profiles.test.ts` / `safe-fs.test.ts` / a new lock-and-races file; 0-T4
`recovery-mode.test.ts`; 0-T5 boot test over `InMemoryTransport`; 0-T6 `setup.test.ts`,
`setup.gateway.test.ts`, `profiles.test.ts`; 0-T7 `cli-commands-in-errors.test.ts`; 0-T8
`validate-startup.test.ts`. Deliverables 0-D1 to 0-D5.
**Done:** all listed tests pass; `engines` stays `>=18` (no new CLI flag); the data-loss walk
(which file bytes can change in which registry state, for every writer) is in the commit
message body of commit 4; a canary inside a broken JSON never appears in any output.

### 5.2 W-DOC0 — step-0 docs · Sonnet, medium (lane 2)

**Files:** `CHANGELOG.md`, `README.md` (registry and recovery notes, only where it already
describes the registry), `install-agent.md` (recovery-mode paragraph), `src/cli/agent-guide.test.ts`,
`src/cli/install-agent.test.ts`, `doc/design/04-setup.md`, `doc/design/policy-gate/*` (Status
lines).

1. DOC-4: CHANGELOG `[Unreleased]` **Fixed** entries from 06 (CHANGELOG drafts, step 0), naming
   the `chmod 600` and symlink fixes, the lock, the `.bak` meaning ("the version before the
   last CLI change") and kept unknown keys.
2. DOC-7 (step-0 slice): `REGISTRY_UNREADABLE` from `setup_profile` → tell the user, do not
   edit the file; the two guide tests pin it.
3. DOC-10 (step-0 slice): `04-setup.md` registry preflight and lock.
4. DOC-12: Status lines of the design files per step 0.

**Tests run:** the two guide tests only.
**Done:** docs match the texts in 02 §1.1 and §4; marker check clean.

### 5.3 W-REVIEW-0 · `security-reviewer` (no `model`) + orchestrator (Opus)

`security-reviewer` on `git diff master...release/7.6.1` with the design (02 §1.1, §4, 06 Step
0) as spec; focus: lock stale handling and pid races, `O_EXCL`/`O_NOFOLLOW`, owner-uid and
directory-chain checks, error text leakage (canary), `.bak` rules. The orchestrator does the
data-loss walk (every file each writer can change in each registry state: absent, ok, each
unreadable kind) and diff-checks against 02. Findings are fixed by the W-STEP0 agent
(continued with `SendMessage`, so it keeps its context).

## 6. A-release workstreams (step A, after 8.0.0)

### 6.1 W-CONTRACT-A — step-A types, texts, stubs · Opus, high (Wave A-C)

**Files:** new `src/shared/policy.ts`, `src/server/gate-core.ts`, `src/server/gate.ts` (types,
stubs, `CORE_SPECS` rows, pinned text constants); `src/shared/keychain.ts` (anchor types and
stubs); `src/shared/profiles.ts` (the three step-A `UnreadableReason` kinds, `SettingKey`,
anchor steps as stubs in `writeWithAnchor`); `src/server/confluence-client.ts` (new function
stubs); new `src/cli/terminal.ts` (stub).

1. **Re-anchor.** Re-check every file:line in §2 and in design 01 §1.5 against `master` after
   8.0.0; list what moved. Read the 8.0.0 S0 notes for the `instructions` placement (Q10) and
   the exact `inputRequired` wire name (`isFinalResult`).
2. PG-C3 – PG-C8 as in 02.
3. `CORE_SPECS` with one row per `KnownTool` at the base commit (41 at 7.6.0; recount, and
   classify any tool 8.0.0 or 8.1.0 added: write, content-read or listing), `as const satisfies
   Record<KnownTool, GateSpec>`, plus the `@ts-expect-error` fixture that a missing row fails
   `tsc` (A-D2).
4. `requireTerminal()` stub in `src/cli/terminal.ts` (S14; signature per 02 §9.1).
5. If the Linux half of the keychain check (§2) is still empty, run it now (container or CI
   runner) and record it; a result other than exit 1 with empty output stops W-CLI-A's
   anchor commit until the design is amended.

**Done:** `tsc` clean; orchestrator diff-reviews against 02.

### 6.2 W-CORE — decision core · Opus, high (Wave A-B, lane 1)

**Files:** `src/server/gate-core.ts`, `src/server/gate-core.test.ts`,
`src/server/gate-boundaries.test.ts`, and the copy test (`gate-core.test.ts` or new
`gate-copy.test.ts`).

1. Combinators with grammars, `optional`, `allOf`, `searchTarget`, `recentChangesTarget`,
   `deferredTarget`; `GATE_SPECS` lookup with `Object.hasOwn`.
2. `decideRead` as the 14-row table (02 §3.3), exhaustive switch, no default allow (D34);
   `degradeAsk`.
3. `renderRefusal`, change note, manifest helpers; ledger and receipt pure functions as stubs
   for step B.
4. Import-scan test (A-T1), including rule 5 (only `profiles.ts` calls `writePolicyAnchor` /
   `clearPolicyAnchor`, plus `--remove`).

**Tests:** A-T1, A-T3, A-T19; the `@ts-expect-error` fixture.
**Done:** property tests at ≥ 1,000 runs with pinned clocks (seeds printed on failure, not
pinned); no I/O imports; the canary test covers every argument-derived string.

### 6.3 W-POLICY — policy model · Sonnet, high (Wave A-B, lane 2)

**Files:** `src/shared/policy.ts`, `src/shared/policy.test.ts`, `src/server/config.ts`,
`src/server/cql-scope.ts`, `src/server/cql-scope.test.ts`, `src/server/read-scope.ts`.

1. Grammar, `inScope` (type-based `~*`, only `=== "personal"`), `caseHint`, `cqlScopeOf` with
   `personalCql` from P1 and the ceiling.
2. `projectPolicy` (the only runtime validator of gate keys; recovery only on enforcing
   profiles, D28), `anchorOf`, `reconcileAnchor` (intersection), `applyContinuity` in the
   order of 03 §5.3 (the anchor row wins), `hashPolicy`, `startupHash`.
3. Renderers: `policySentences`, `instructionLines`, `descriptionSuffix` (keys only for
   `get_page` and the four listing tools), `changeSentence`; personal keys never in
   agent-facing text.
4. `config.ts`: grammar and the full `policy` block schema (A-D5); `scopeCql` overload.

**Tests:** A-T2; `cql-scope.test.ts` extensions (personal disjunct, deny clause, ceiling, never
unscoped; existing cases unchanged).
**Done:** every row of 03 §5.2–5.4 that `projectPolicy` or `reconcileAnchor` owns has a named
test; the orchestrator reviews the invariants (intersection never wider than either side)
before merge.

### 6.4 W-SHELL — store, resolver, wrapper, client functions · Opus, high (Wave A-B, lane 3)

**Files:** `src/server/gate.ts`, `src/server/gate.test.ts`, `src/server/space-allowlist.ts`
(`seed` with space type, 10,000 cap, and the A-D9 message), `src/server/confluence-client.ts`
(new functions only; `getSpaceKeyById` backed by `getSpaceById`).

1. `PolicyStore`: single flight cleared in `finally`, stored observation (S16), one torn-save
   re-read after 75 ms, anchor read with a 2,000 ms timeout and at most one retry per 5 s
   while `anchor-unreadable`, env-var mode has no store.
2. `resolveTarget`: canonicalisation through the tenant, batched `contents`, negative cache
   (60 s, 1,000 entries), attachment container cache, resolver chain.
3. `gateHandler` per 01 §1.4 (unreadable before off; budget hooks as no-ops until B; fixed
   text for manifest-tool errors; whole result kept, change note appended or prepended; capped
   `denyLine`), `UndeclaredToolError`, `isFinalResult`.
4. Client functions per PG-C6 (A-D6: follow every `_links.next`, no type filter, batches of
   250). `SpaceNotAllowedError` names `policy allow <KEY> --write --profile <p>` (A-D9).

**Tests:** A-T6, A-T7, A-T14, A-T18; client unit tests (A-D6); the A-D9 message test; 0-T7
stays green.
**Done:** the handler is never invoked on any deny path (spy) in every test.

### 6.5 W-CLI-A — anchor, terminal, policy commands · Sonnet, high (Wave A-B, lane 4)

The anchor is folded into this lane (review resolution 1); there is no W-ANCHOR. Two parts,
anchor first.

**Files:** `src/shared/keychain.ts`, `src/shared/keychain.test.ts`,
`src/shared/policy-anchor.test.ts`, `src/shared/profiles.ts` (anchor steps of
`writeWithAnchor`), `src/cli/terminal.ts`, `src/cli/policy.ts`, `src/cli/policy.test.ts`,
`src/cli/profiles.ts` (`--remove` clears the anchor; `--set-read-write`),
`src/cli/profiles.test.ts`, `src/cli/index.ts` (dispatch via `parseArgs`, usage),
`src/cli/status.ts`, `src/cli/setup.ts` (hand-off at the end only), `src/cli/setup.test.ts`.

Part 1 — anchor (orchestrator gate before part 2):

1. `readPolicyAnchor` tri-state with timeout (`absent` only on macOS exit 44 / Linux exit 1
   with empty output; everything else `error`), `writePolicyAnchor`, `clearPolicyAnchor`;
   account `policy-anchor/<profile>`; the seal re-save never touches it.
2. `writeWithAnchor` steps 4, 5 and 8 (02 §1.1): kind-`other` projection check, clear-first
   when off, read-back before anchoring, `utimes`.

Part 2 — terminal and commands:

3. `requireTerminal()` (stdin TTY, `/dev/tty` opens, confirmation read from the `/dev/tty`
   stream, closed afterwards); applied to `--set-read-write`, `policy setup`, `policy allow`.
4. `policy [--check] [--verbose]`, `policy setup` (picker, `parseSelection`, paging, `o` for
   off, no "all"), `policy allow [--write]` (reads only; `--write` writes only, D32), using
   `updateProfileSettings` and the anchor order; `audit.log` line with old and new
   fingerprint. `status` line; `setup` hand-off prompt (DOC-8); usage lists `policy`.
5. Extend 0-T7 so the new commands are checked against their dispatcher.

**Tests:** A-T9, A-T12, A-T16; 0-T7 extension; the `setup.test.ts` prompt check (DOC-8).
**Done:** a seal re-save round trip keeps the anchor; every crash order of A-T12(e) leaves a
state at least as narrow as before; CLI outputs match the 02 §9.3–9.5 texts (pinned codes and
prefixes; exit codes 0/1/2).

### 6.6 W-DOC-A — step-A docs and agent guide · Sonnet, medium (Wave A-B, lane 5)

**Files:** `README.md` (`:167-194`), `doc/user-doc/tools-reference.md`,
`doc/user-doc/installation.md`, `CHANGELOG.md`, `doc/design/security/06-limitations.md` §17,
`doc/design/security/05-observability.md` (profile audit log), `install-agent.md`,
`src/cli/agent-guide.test.ts`, `src/cli/install-agent.test.ts`, `doc/design/04-setup.md`,
`doc/design/policy-gate/*` (Status lines and re-anchored line numbers from W-CONTRACT-A),
`doc/analysis/policy-gate/05-lessons-from-repo-aegis.md` (one row, DOC-11),
`src/shared/profiles.ts` doc comments (`:138-157`; comments only, after I-A1, DOC-9).

1. **DOC-1:** "Read scope and redaction"; `README.md:188` changes meaning (no sentence says
   the scope is not a boundary); grammar (`KEY`, `~*`, `!KEY`, no `*`, key charset);
   `read_spaces: []`; the `policy` block; `policy`/`policy setup`/`policy allow [--write]`; the
   anchor (a hand edit can narrow, never widen); the threat-model sentence; tool-name-level
   restrictions → an MCP gateway in front; "read log", not "audit log".
2. **DOC-2** (step-A slice: one line per gated tool, refusal codes and what to do, "some
   results withheld", `lookup_user` outside the space scope), **DOC-3**, **DOC-4** (**Changed**
   and **Added** from 06; D15 and D18 entries are included, both confirmed), **DOC-10**
   (hand-off, anchor), **DOC-11**, **DOC-12**.
3. **DOC-5 acceptance (non-guarantees, X5):** `06-limitations.md` §17 states what the scope
   bounds; the 5-min cache TOCTOU; same-user file and keychain access (anchor removable;
   tamper-evident only; logs editable); the terminal check defeated by `script`/`expect`; the
   Confluence path of this server only; `lookup_user` not scoped until step E. It also lists
   what the tool does not guarantee: it does not make usage GDPR-compliant by itself; the
   server cannot verify which model or provider receives content; the read log shows what was
   handed to the MCP client, not what the provider received or kept; transfer and retention at
   the provider are the provider's and the employer's concern. No contradiction with the
   README. (Budget bullets: W-DOC-B.)
4. **DOC-6 (step-A slice):** "Profile audit log" (`:126`) gains policy edits (old and new
   fingerprint) and the step-A deny lines with their 1,000-line cap.
5. **DOC-7 (step-A slice):** new section "Read policy (scope and budget)" after "Write budget"
   (`:268`), replacing "Search scope" (`:763-770`): a `Withheld [POLICY_...]` result is final
   for that call until the user says the policy was changed; relay the five lines and quote
   the "For the person" line verbatim; never run `policy allow`; a `POLICY_UNREADABLE` after
   the user saved the file may be retried once; the change note supersedes instructions and
   descriptions. The two guide tests pin the heading, the codes and the phrases "final for this
   call" and "For the person".

**Tests run:** the two guide tests only.
**Done:** every refusal code in PG-C8 is documented; no sentence claims compliance, prevention
or evidence-grade audit (grep on the touched docs for `complian`, `prevent`, `evidence`,
`guarantee`, each hit read); placeholder keys only; marker check clean.

### 6.7 W-WIRE — `index.ts` integration · Opus, high (Wave A-W, sole owner of `index.ts` and the tool modules)

**Files:** `src/server/index.ts` (H3–H10 and the `pageSpaceCache.seed` lines; or the matching
`src/server/tools/<tool>.ts` modules if 8.1.0 C6 moved the handlers), `src/server/tool-surface.test.ts`
(fixture updates only).

1. H3–H6: one load, store, instructions, `registerTools` deps (no registry read of its own),
   the shim edited in place.
2. H7–H10: search, recent changes, spaces, `list_pages`, title tools: manifests from response
   space ids, never unscoped search, "some results withheld", seed calls; optional manifest items
   in `get_page` and the version/comment/label handlers.
3. Each 8.1.0 tool module exports its `gateSpec` (PG-C11); move any `CORE_SPECS` rows the
   contract wave wrote for them.

**Tests:** A-T5 (shim), A-T8 (instructions length, suffixes, byte-identical when off), A-T13,
A-T15 (startup with an anchor), A-T17 (title tools, recent changes); existing
`tool-surface.test.ts` and `search-scope.integration.test.ts` stay green.
**Done:** `git diff` shows no change inside any `inputSchema`; the hunk list matches 01 §1.5.

### 6.8 W-MATRIX — coverage, goldens and integration tests · Sonnet, high (Wave A-T)

Absorbs the former W-GOLDEN lane.

**Files:** `src/server/gate-coverage.test.ts`, `src/server/gate-write-ceiling.test.ts`,
`src/server/search-scope.integration.test.ts`, `src/server/recent-changes.integration.test.ts`,
`tools/list` golden fixtures.

1. A-T4 generated from `GATE_SPECS`, both API modes, both postures, plus the byte-identical
   check against the pre-gate golden with no policy and no anchor.
2. A-T10 (write ceiling), A-T11 (search and recent-changes integration).
3. Goldens: regenerate for a policy-on fixture profile; policy-off goldens unchanged. The
   description cap of A-T8: every description ≤ 1,800 characters with the suffix and 100 keys.

**Done:** the matrix covers every non-exempt tool; a deliberately removed row makes it fail
(checked once by hand, not committed).

### 6.9 W-REVIEW-A · Opus, high + `security-reviewer` + `test-critic`

Opus code review of the step-A diff against 02/03/06; `security-reviewer` (no `model`) with the
design as spec, focus: argument-derived strings, canonicalisation, manifest sources, fail
directions, the anchor (tri-state, intersection, write order), the terminal check, the write
ceiling; `test-critic` (Sonnet) on `gate-*.test.ts`, `policy.test.ts` and
`policy-anchor.test.ts`. Fixes by Opus before the checkpoint.

## 7. B-release workstreams (step B)

### 7.1 W-CONTRACT-B · Opus, high (Wave B-C)

**Files:** `src/server/read-log.ts` (schemas, types), `src/server/gate-core.ts` (ledger types),
`src/server/gate.ts` (`ReadBudgetLedger` signature).

1. PG-C10: `readRecordSchema`, `policyRecordSchema`, `readRecordReaderSchema` (lenient),
   ledger cell.

### 7.2 W-BUDGET — ledger, receipt, records · Sonnet, high (Wave B-B, lane 1)

**Files:** `src/server/gate-core.ts` (ledger, receipt), `src/server/gate.ts` (reservation,
rollback, receipt, record calls, title-tool budget at release; deny records move from
`audit.log` to the read log), tests.

1. Pure ledger with holders (`reserve`, `settle`, `prune`, `budgetView`); cell with injected
   clock; records while no budget is set (N3).
2. Pre-phase reservation; rollback on error; receipt block outside any untrusted fence;
   `ReadLog.append` after decisions; `lookup_user` allows recorded; listing records with up
   to 100 content IDs.

**Tests:** B-T1, B-T3, B-T4, B-T7, B-T9, B-T10, B-T11.
**Done:** no `await` between a budget decision and its reservation (review checklist item).

### 7.3 W-LOG — read log and its construction · Sonnet, high (Wave B-B, lane 2)

**Files:** `src/server/mutation-log.ts`, `src/server/mutation-log.test.ts` (unchanged
assertions), `src/server/read-log.ts`, `src/server/read-log.test.ts`, `src/server/index.ts`
(H3 `ReadLog` construction only, a few lines next to `initMutationLog`; no other step-B lane
edits `index.ts`, so the former W-WIRE-B lane is folded in here).

1. Export `openOwnerOnlyLog`/`sweepOldLogs` with `prefix` and retention, `ENOENT`-tolerant;
   no fallback for `reads-`; `verifyDirChain`; `fstat` mode check; session hex in the name;
   10 MB cap with `EFBIG` into `droppedBefore`; control characters stripped from the client
   label.
2. Construct the `ReadLog` in `main()` only when the policy is on or an anchor exists.

**Tests:** B-T2 (incl. no file while the policy is off and no anchor exists).

### 7.4 W-LOGCLI — `log` and `policy` lines · Sonnet, medium (Wave B-B, lane 3)

**Files:** `src/cli/log.ts`, `src/cli/log.test.ts`, `src/cli/policy.ts` (log and "outside the
CLI" lines, budget question in `policy setup`), `src/cli/index.ts` (dispatch).

**Tests:** B-T5, B-T6; A-T9 extended for the budget question.

### 7.5 W-DOC-B · Sonnet, medium (Wave B-B, lane 4)

**Files:** `doc/design/security/05-observability.md`, `doc/design/security/06-limitations.md`
§17, `README.md`, `doc/user-doc/tools-reference.md`, `CHANGELOG.md` (**Added**),
`install-agent.md` with its tests, `doc/design/policy-gate/*` (Status lines).

1. **DOC-6 acceptance (read log):** a "Read log" section with location and file name; schema
   (fields match `readRecordSchema`); **purpose** (operator self-audit and incident scoping);
   **retention** 90 days, swept only when a server opens a log, 10 MB per file; **erasure**:
   `log --purge-older-than <days>` or deleting the files; exports, backups and synced home
   directories fall outside the sweep; the log is personal data about the operator, stays on
   the machine and is never transmitted; `log` shows IDs only; `droppedBefore` and `capped`;
   no off switch; personal keys contain account IDs; coexistence with the mutation log.
2. **DOC-5 (budget slice):** the budget caps accidental reads, is not a minimisation guarantee
   and resets on restart; listings and excerpts are not budgeted.
3. DOC-2 (receipt line), DOC-4 (**Added**), DOC-7 (receipt line, budget warning), DOC-12.
   (DOC-8's `log` usage line is code in `cli/index.ts`, owned by W-LOGCLI.)

**Done:** no sentence claims evidence-grade audit, compliance or prevention (same grep as
6.6); purpose, retention and erasure text present; marker check clean.

### 7.6 W-REVIEW-B · Opus, high + `security-reviewer` + `test-critic`

As 6.9, focus: ordering (PG-C9), log hardening, no content in records, ledger interleaving.

## 8. File ownership by wave

| Wave | Workstream | Owns (only this lane edits it during the wave) |
|---|---|---|
| 0 | W-STEP0 | `safe-fs.ts`, `update-check.ts`, `profiles.ts`, `confluence-client.ts` `:240-275`, `index.ts` (H1, H2), `space-allowlist.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/profiles.ts`, their tests, `cli-commands-in-errors.test.ts` |
| 0 | W-DOC0 | `CHANGELOG.md`, `README.md`, `install-agent.md`, agent-guide tests, `doc/` |
| A-C | W-CONTRACT-A | `shared/policy.ts`, `gate-core.ts`, `gate.ts`, `keychain.ts` (types), `profiles.ts` (types, stubs), `confluence-client.ts` (stubs), `cli/terminal.ts` (stub) |
| A-B | W-CORE | `gate-core.ts`, `gate-core.test.ts`, `gate-boundaries.test.ts` |
| A-B | W-POLICY | `shared/policy.ts`, `config.ts`, `cql-scope.ts`, `read-scope.ts`, their tests |
| A-B | W-SHELL | `gate.ts`, `space-allowlist.ts`, `confluence-client.ts` (new functions), their tests |
| A-B | W-CLI-A | `keychain.ts`, `profiles.ts` (anchor steps), `cli/terminal.ts`, `cli/policy.ts`, `cli/index.ts`, `cli/status.ts`, `cli/setup.ts`, `cli/profiles.ts`, their tests |
| A-B | W-DOC-A | `README.md`, `CHANGELOG.md`, `install-agent.md`, `doc/`, agent-guide tests; `profiles.ts` comments after I-A1 |
| A-W | W-WIRE | `index.ts` (and `tools/<tool>.ts` if moved), `tool-surface.test.ts` |
| A-T | W-MATRIX | `gate-coverage.test.ts`, `gate-write-ceiling.test.ts`, search/recent-changes integration tests, golden fixtures |
| B-C | W-CONTRACT-B | `read-log.ts`, `gate-core.ts`, `gate.ts` (types) |
| B-B | W-BUDGET | `gate-core.ts`, `gate.ts`, their tests |
| B-B | W-LOG | `mutation-log.ts`, `read-log.ts`, `index.ts` (ReadLog construction), their tests |
| B-B | W-LOGCLI | `cli/log.ts`, `cli/policy.ts`, `cli/index.ts`, their tests |
| B-B | W-DOC-B | `README.md`, `CHANGELOG.md`, `install-agent.md`, `doc/` |

`CHANGELOG.md`, README and `doc/` are edited only by the docs lane of each wave.

## 9. Model, effort and concurrency

Pass `model` on every Agent call except `security-reviewer`, which omits it so its frontmatter
applies.

| Task | Model | Effort |
|---|---|---|
| W-STEP0, W-CONTRACT-A/B, W-CORE, W-SHELL, W-WIRE, review fixes, code reviews, data-loss walks | Opus | high |
| W-POLICY, W-CLI-A, W-MATRIX, W-BUDGET, W-LOG | Sonnet | high |
| W-LOGCLI, W-DOC0, W-DOC-A, W-DOC-B | Sonnet | medium |
| Security review | `security-reviewer` (no `model` override) | – |
| Test critique | `test-critic` with `model: sonnet` | – |

No Haiku lanes are planned: the docs lanes are one Sonnet agent each.

Rules for every agent: own worktree off the release branch; local commits only; one test run at
a time, `npx vitest run --maxWorkers=2 <files>`, scoped files first; never the full suite (the
orchestrator runs it); ≤ 4 test-running agents at once (a docs lane runs only its two doc test
files and waits if the watchdog trips); the orchestrator runs the load/memory watchdog during
each wave. No live tenant calls (P1 is human). Never push, tag or publish. Fixtures use
`example.com`, space keys `HR`/`DEV`/`DOCS`, numeric ids. A lane that needs a file another lane
owns stops and asks. Worktrees are removed when each lane is merged.

Concurrency by wave: step 0 two agents (W-STEP0, W-DOC0); Wave A-B four test-running lanes plus
the docs lane; Wave A-W and A-T one agent each; Wave B-B three test-running lanes plus the
docs lane.

## 10. Release checkpoints (human)

For each release: fast-forward the release branch into `master` locally; the user pushes and
runs `gh release create` (the egress guard will ask; `repo-aegis approve` from the user's
terminal); install from npm and check `epimethian-mcp --version`, `status` and (from A)
`policy`; re-check Dependabot and code-scanning alerts.

**P1 — decision-14 live check and keychain exit codes (this week; a precondition of Wave
A-C, not of 7.6.1).** Run by the user, or by the orchestrator with the user watching: small
read-only calls only, on the designated test profile (the live tenant: no writes, no loops, no
subagent calls), one site and one gateway profile, items 1–5 in §2. The temporary scoped test
token is revoked around **2026-11-29**: P1 runs before then, or a new short-lived read-only
scoped token is created for it (Q12). Record the results in §2.

The keychain check (design assumption 9, R29) runs in the same sitting, locally, with no
Confluence call: query an item that does not exist and record the exit code and output on
macOS (`security find-generic-password`, expected 44) and Linux (`secret-tool lookup`, expected
1 with empty output); then record what a locked keychain, a denied prompt and a timeout return,
which must all differ from the not-found result. Do not print any secret. If Linux is not at
hand, W-CONTRACT-A item 5 runs it; A-T12 pins the codes with mocks either way.

**7.6.1:** after W-REVIEW-0; then forward-merge `master` into `release/8.0.0`. For the 8.0.0
extras, create the `release/7.x` maintenance branch at the **7.6.1** tag, not 7.6.0 (the 8.0.0
plan §10 now says so), so the maintenance line has the
fail-closed registry.
**A-release (provisionally 8.2.0):** after W-REVIEW-A; the number is set here (§1). The
CHANGELOG `[Unreleased]` entries become that heading.
**B-release (provisionally 8.3.0):** after W-REVIEW-B, same procedure.

## 11. Test and deliverable ownership

Every test ID in [06](../doc/design/policy-gate/06-deliverables.md) has exactly one owning
lane; a lane marked "part" delivers a stated clause.

| Tests / deliverables | Lane |
|---|---|
| 0-T1 – 0-T12, 0-D1 – 0-D5 | W-STEP0 |
| A-T1, A-T3, A-T19; A-D2 | W-CORE |
| A-T2; A-D1, A-D5 (`cql-scope.test.ts`) | W-POLICY |
| A-T6, A-T7, A-T14, A-T18; A-D3, A-D6, A-D9 | W-SHELL |
| A-T9, A-T12, A-T16; A-D7, A-D8; 0-T7 extension | W-CLI-A |
| A-T5, A-T8 (all but the description cap), A-T13, A-T15, A-T17; A-D4 | W-WIRE |
| A-T4, A-T8 (description cap), A-T10, A-T11; A-D10; goldens | W-MATRIX |
| B-T1, B-T3, B-T4, B-T7, B-T9, B-T10, B-T11; B-D1, B-D3 | W-BUDGET |
| B-T2; B-D2 | W-LOG |
| B-T5, B-T6; B-D5, B-D6 (A-T9 extended); DOC-8 (`log` in the usage text) | W-LOGCLI |
| B-T8 | none: moved to step A as A-T17 (B-D4 likewise) |
| DOC-4 (Fixed), DOC-7 slice, DOC-10 slice, DOC-12 | W-DOC0 |
| DOC-1, DOC-2 (step A), DOC-3, DOC-4 (Changed, Added), DOC-5 (non-guarantees), DOC-6 (audit log), DOC-7 (step A), DOC-9, DOC-10, DOC-11, DOC-12 | W-DOC-A |
| DOC-8 (setup prompt and `policy` in the usage text) | W-CLI-A |
| DOC-2 (receipt), DOC-4 (Added), DOC-5 (budget), DOC-6 (read log), DOC-7 (receipt, budget), DOC-12 | W-DOC-B |

## 12. Open questions

Tracked in [05 §3](../doc/design/policy-gate/05-risks-and-open-questions.md#3-open-questions).
Resolved and no longer blocking: Q1 (D15 confirmed), Q4 (D22: no 7.7.0), Q7, Q11 (D18
confirmed), Q13 (A-release is the first minor after 8.1.0, provisionally 8.2.0; §1).

| Question | Blocks |
|---|---|
| Q12 (test token revocation) | P1; run this week |
| Q2, Q5 (P1 results) | W-POLICY `cqlScopeOf`, hint text |
| Q10 (where `instructions` go in the 2026 protocol era) | W-WIRE H4; known from 8.0.0 S0 |
| Q3 (budget defaults) | W-LOGCLI setup question, docs examples (step B only) |
| Q6, Q8, Q9 | nothing; defaults in the design apply |

## 13. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| 7.6.1 is not on `master` before W-SDK starts | Step 0 starts now with two agents; the forward-merge conflict is confined to H1/H2 | W-SDK's owner re-applies H1–H2 from the 7.6.1 diff in `serveStdio` |
| Step A's line numbers drift on 8.0.0/8.1.0 | W-CONTRACT-A re-anchors first; W-WIRE starts after 8.1.0 | – |
| A-release number collides with another 8.x minor | Number fixed at the checkpoint (§1) | Renumber the CHANGELOG heading |
| P1 not run before the token is revoked | Create a short-lived read-only token (Q12) | Block Wave A-C until P1 has run |
| P1 shows the scoped token cannot resolve spaces | Setup's gateway scope list adds the space-read scope; refusals say `POLICY_SPACE_UNRESOLVED` | Ship A for site mode with gateway documented as "every read refused until the token has space read" |
| Keychain "not found" is not distinguishable from other failures (assumption 9) | Checked in P1; anything else than the documented not-found result is `error` | Amend 02 §1.2 before W-CLI-A's anchor commit |
| A gate bypass found after release | Matrix and property tests; security review per release | Patch release; user escape hatch: `policy setup` → `o` (05 §5) |
| Recovery mode hits users with previously tolerated broken registries | CHANGELOG names the fixes; recovery text gives the command | Pin 7.6.0 (05 §5) |
| Hand edit of the registry during a CLI write | Lock plus pre-rename `lstat`, re-applied up to three times, then refuses (D12) | – |
| Contract churn mid-wave | Contracts frozen per wave; changes only through the orchestrator | Revert the lane, re-run on the new contract |

Rollback per step is in [05 §5](../doc/design/policy-gate/05-risks-and-open-questions.md#5-rollback).
