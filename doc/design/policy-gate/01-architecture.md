# 1. Architecture

Status: design, reviewed 2026-11-25. Step 0 (7.6.1) built; steps A and B not built. Line numbers are 7.6.0 (`15d5ebe`); step A
re-anchors them against the 8.0.0 tag.

## 1.1 Components

### New modules

| File | Kind | Responsibility | Step |
|---|---|---|---|
| `src/shared/policy.ts` | pure | `read_spaces` entry grammar and `SpaceScope`; `policy` block zod schema; `projectPolicy` (registry read → file projection); `anchorOf`, `reconcileAnchor` (file projection + anchor → effective policy, intersection on mismatch); `applyContinuity`; `hashPolicy`, `startupHash`; plain-sentence renderers for the CLI `policy` output, server instructions and description suffixes | A |
| `src/server/gate-core.ts` | pure | `GATE_SPECS` (mapped over `KnownTool`, looked up with `Object.hasOwn`) and the argument combinators (with key and ID grammars, `allOf`); `decideRead` (exhaustive switch, fall-through denies) with the `ask` variant reserved for step C and the single `degradeAsk` point; `renderRefusal` (five-part, identifier-only input); `renderReceipt`, `renderChangeNote`; release-manifest symbol and helpers; budget ledger functions (`LedgerState`, `prune`, `budgetView`, `reserve`, `settle`) | A (budget, receipt: B) |
| `src/server/gate.ts` | shell | `PolicyStore` (single in-flight refresh cleared in `finally`; one `lstat` per call compared with the last observation; reload and re-project on change; one torn-save re-read; anchor read with timeout); `resolveTarget` (canonicalises every space key through the tenant; batch content lookups; negative cache; resolver extension point); `gateHandler` (the wrapper); `ReadBudgetLedger` cell (clock injected); deny-line cap | A (ledger: B) |
| `src/server/read-log.ts` | shell | Read and policy records on the mutation log's open/sweep helpers (prefix `reads-`, `O_EXCL` only, `verifyDirChain`, 10 MB cap per file, 90-day sweep); `droppedBefore`; `session` id | B |
| `src/cli/terminal.ts` | shell | `requireTerminal()`: stdin is a TTY and `/dev/tty` opens; the confirmation is read from `/dev/tty` as a `tty.ReadStream`, closed after use; stdout may be piped | A |
| `src/cli/policy.ts` | shell | `policy [--check] [--verbose]`, `policy setup` (tenant space picker; pure `parseSelection`), `policy allow <KEY> [--write]`; flags via `parseArgs` | A |
| `src/cli/log.ts` | shell | `log` (time range, summary, JSONL export, `--purge-older-than`); pure `parseRecord`, `summarise` exported for tests | B |

### Changed modules

| File | Change | Step |
|---|---|---|
| `src/shared/safe-fs.ts` | `safeOpenReadWithStat(path) → {raw, stat}` (owner uid equals euid, mode not group/world-writable, `verifyDirChain` of the parent; the stat is the `fstat` of the fd read, `bigint: true`); `safeAtomicWrite(path, bytes, opts)` (temp `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW` 0600, write, `fsync`, `rename`, directory `fsync` best effort); `update-check.json` reuses `safeAtomicWrite` | 0 |
| `src/shared/profiles.ts` | `readFullRegistry` (`:177-238`) replaced by three-state `readRegistry()` on `safeOpenReadWithStat`; `RegistryUnreadableError`; pure `describeUnreadable`; `getProfileSettings` (`:265`) and `readProfileRegistry` (`:256`) throw on unreadable and use `Object.hasOwn`; one writer core `writeWithAnchor` behind every exported writer (`:275`, `:291`, `:302`, new `updateProfileSettings`): lock file, read, refuse on unreadable before any temp file, merge, `.bak` (D36), `safeAtomicWrite`, fingerprint compare before rename, anchor rule (D23); stale temp sweep; `registryFingerprint()`; `ProfileSettings` gains `policy?: PolicyBlock`; doc comments `:138-157` rewritten | 0 (anchor, `policy`, docs: A) |
| `src/shared/keychain.ts` | New anchor item under the same service, account `policy-anchor/<profile>` (D26): `readPolicyAnchor(profile, {timeoutMs})` tri-state, `writePolicyAnchor`, `clearPolicyAnchor`. `KeychainCredentials` and `readFromKeychain` unchanged, so the seal re-save (`confluence-client.ts:557-570`) cannot touch the anchor | A |
| `src/server/confluence-client.ts` | `getConfig(opts?: { registry?: RegistryRead })` (`:240`): the first (uncached) call uses the passed read instead of reading again at `:259`; `RegistryUnreadableError` propagates (no posture fallback); `getSpaceKeyById` (`:1527`) backed by new `getSpaceById(id) → {key, type}` (same cache, `type: string`); new `findSpaceByKey(key)` (v2 `/spaces?keys=`); new `getContentSpaces(ids)` (v2 `GET /pages?id=…`, then `/blogposts?id=…` for the rest); `listAllSpaces()` following `_links.next` via `resolveV2NextLink` (`src/server/pagination-cursor.ts:48`), no `type` filter; `searchPagesByTitle` (`:2445`) exposes `spaceKeyFromResponse` without the argument fallback at `:2463`. All new calls use the client's existing 429, backoff and timeout handling | 0 / A |
| `src/server/space-allowlist.ts` | `SpaceNotAllowedError` message (`:45-49`) names a real fix: step 0 the setting and file, step A `epimethian-mcp policy allow <KEY> --write`; `pageSpaceCache` gains `seed(id, contentType, spaceKey, spaceType)` (the space type is its own field, `:63-67` holds the content type) and a size cap of 10,000 entries (oldest evicted on `set`) | 0 / A |
| `src/server/cql-scope.ts` | `scopeCql` (`:45`) gains a `CqlScope` overload: exact keys, `space.type = "personal"` disjunct for `~*` (if the live check confirms it), `space not in (...)` for deny entries. Never returns an unscoped query | A |
| `src/server/read-scope.ts` | `resolveReadScope` (`:38`) keeps compiling `redact_patterns`; scope fields come from the `PolicyStore` snapshot | A |
| `src/server/config.ts` | `ProfileSettingsValidator` (`:30-46`) adds `policy` for CLI-side validation; it is not on a runtime path. `projectPolicy` is the only runtime validator of gate keys (D28) | A |
| `src/server/mutation-log.ts` | `sweepOldLogs` (`:142`) and the open sequence (`:186-207`) take a `prefix` and a retention, are exported, and ignore `ENOENT` during a sweep; the non-`O_EXCL` fallback (`:198-207`) stays for `mutations-` only | B |
| `src/server/index.ts` | Hunks listed in §1.5 only | 0 / A / B |
| `src/cli/index.ts` | Dispatch `policy`, `log`; new flags parsed with `parseArgs` (D31); print `RegistryUnreadableError` message without stack, exit 1 | A / B (print: 0) |
| `src/cli/setup.ts` | Registry preflight before any prompt that leads to a keychain write (`runSetup` `:333`, gateway path `:288-301`, site path `:491-510`); proceeds when only the active profile's gate settings are invalid; at the end, offer `policy setup` | 0 / A |
| `src/cli/profiles.ts` | Registry preflight before `deleteFromKeychain` (`:178`); `--remove` also clears the anchor item; `--set-read-write` (`:45-54`) requires a terminal (it widens access and runs today without one) | 0 / A |
| `src/cli/status.ts` | One line: policy on/off and the pointer `epimethian-mcp policy` | A |
| `install-agent.md` (served by `src/cli/agent-guide.ts:1`) | Read-policy section | A / B |

`package.json` `engines` is `>=18` at 7.6.0; 8.0.0 raises it to `>=20` (plan `:451`), which
covers `parseArgs` (Node ≥ 18.3). Step 0 adds no CLI flag, so 7.6.1 keeps `>=18`.

## 1.2 Dependency direction

```
                    zod, node:crypto
                         ^
   src/shared/policy.ts  (PURE)  <------------------------------+
        ^        ^                                              |
        |        |                                              |
        |   src/server/gate-core.ts (PURE)                      |
        |        ^      imports: shared/policy, tool-allowlist  |
        |        |      (KnownTool type)                        |
        |        |                                              |
src/shared/safe-fs.ts <- profiles.ts -> keychain.ts (I/O)       |
        ^        ^                                              |
        |        |                                              |
        |   src/server/gate.ts (SHELL)                          |
        |        ^   imports: gate-core, shared/policy,         |
        |        |   shared/profiles, shared/keychain,          |
        |        |   space-allowlist, confluence-client (GET    |
        |        |   helpers), read-log                         |
        |        |                                              |
        |   src/server/read-log.ts (SHELL, B)                   |
        |        ^   imports: mutation-log (helpers), gate-core |
        |        |   (record types), shared/safe-fs             |
        |   src/server/index.ts  (hunks only)                   |
        |                                                       |
   src/cli/terminal.ts <- src/cli/policy.ts, src/cli/log.ts, src/cli/profiles.ts
        imports: shared/policy, shared/profiles, shared/keychain, gate-core (pure
        renderers, record types); server/confluence-client only by dynamic import
```

Rules, enforced by `src/server/gate-boundaries.test.ts` (string import scan in the style of
`src/server/no-direct-raw-writer.test.ts`, no new devDependency):

1. `src/shared/policy.ts` and `src/server/gate-core.ts` import no `node:fs`, `node:fs/promises`,
   `node:os`, `node:net`, `confluence-client`, `profiles`/`keychain` (except `import type`),
   `gate`, `read-log`, `index`; contain no `Date.now(`, `new Date()` without an argument,
   `Math.random(`, `process.`.
2. `src/shared/**` imports nothing from `src/server/**` (except `import type`).
3. `src/cli/**` imports neither `src/server/gate.ts` nor `src/server/index.ts`.
4. `src/server/gate-core.ts` imports `src/shared/policy.ts`, never the reverse.
5. Only `src/shared/profiles.ts` calls `writePolicyAnchor` or `clearPolicyAnchor`, except
   `src/cli/profiles.ts` `--remove` (clear only).

## 1.3 Responsibilities per layer

| Concern | Pure (`policy.ts`, `gate-core.ts`) | Shell (`gate.ts`, `read-log.ts`, `profiles.ts`, CLI) |
|---|---|---|
| What the policy is | `projectPolicy`, `reconcileAnchor`, `applyContinuity`, `hashPolicy` | `readRegistry`, `registryFingerprint`, `readPolicyAnchor` |
| When it changed | – | `PolicyStore.refresh` (one `lstat`, single flight) |
| What the anchor holds | `anchorOf(policy)` (set iff on) | `writeWithAnchor` (the only writer) |
| Which space a call targets | `spec.target(args)` (combinators, grammars) | `resolveTarget` (GET only, canonical key and type) |
| Allow / deny / ask | `decideRead`, `degradeAsk` | – |
| What the agent reads | `renderRefusal`, `renderReceipt`, `renderChangeNote`, `instructionLines`, `descriptionSuffix` | Appends content blocks |
| Budget | `prune`, `budgetView`, `reserve`, `settle` | `ReadBudgetLedger` cell, `now()` |
| Records | Record types | `ReadLog.append` (B); `appendAuditLog` deny lines with a per-process cap (A) |

## 1.4 Request flow through the wrapper

`gateHandler(name, spec, handler, deps)` for one call. Only GET requests happen before the
decision; nothing is counted or logged before it (8.0.0 contract C5).

```
call(args, ctx)
 │
 ├─1 snap = await store.refresh()                 single flight; one lstat; reload on change
 ├─2 snap.load.state == "unreadable"?             deny POLICY_UNREADABLE for every tool except
 │       ── yes ─> refusal (exempt-allow tools: handler) ─> 10     get_version, upgrade
 ├─3 spec.class == "exempt"?  ── yes ─> handler ─> 10
 ├─4 snap.policy.state == "off"?  ── yes ─> handler ─> 11          (byte-identical to today)
 ├─5 target = spec.target(args)                   pure; grammar-checked; malformed -> deny
 ├─6 resolved = await resolveTarget(target)       GET only, cached; canonical key + type;
 │                                                 404 -> not-found error, stop;
 │                                                 network/auth -> API error text, stop
 ├─7 pre = degradeAsk(decideRead({phase:"pre"}))  deny -> [deny line / record] -> refusal, STOP
 │     allow with counts -> ledger.reserve(ids)   SYNCHRONOUS with the decision (B)
 │                                                 (handler not called on deny: no body, no file)
 ├─8 result = await handler(args, ctx)            throw or error result -> ledger.settle(ids, failed);
 │                                                 manifest tools: fixed error text -> 10
 │     write class: return result (no release phase, no receipt, no read record)
 ├─9 manifest specs, and content reads whose handler attached an optional manifest:
 │     [clean, manifest] = takeRelease(result)
 │     rel = decideRead({phase:"release", release: manifest})
 │     deny -> settle(failed); whole result withheld; [deny record]; refusal
 │     title tools (B): budget decided and reserved here, synchronously
 │     allow -> ledger.settle(ids, released)
 ├─10 [B: recordOk = readLog.append(record)]
 └─11 decorate: receipt block [B]; change note if armed and the result is final
```

Notes:

- Step 1: `refresh` compares the `lstat` with the last observation (fingerprint, `absent` or
  errno), stored whatever the outcome, so a broken state is read once, not on every call. A
  parse error or `ENOENT` seen mid-session gets one re-`lstat` and re-read after 75 ms before it
  counts (an editor's truncate-and-write or rename-away save, D35). The anchor is read with a
  2,000 ms timeout; the in-flight promise is cleared in `finally`; any exception maps to
  `io-error`.
- Step 2 is decided before "policy off", so an unreadable file never falls through to the
  pass-through branch.
- Step 4 for write-class tools: `off` means no read scope enforced; the handler's own
  `checkSpaceAllowed` still applies `spaces`. In env-var mode (no `CONFLUENCE_PROFILE`) there is
  no `PolicyStore`: the snapshot is a constant `off` and no `lstat` runs.
- Step 6: a network or auth error returns the fixed text of
  [02 §8.1](02-interfaces.md#81-refusals) without calling the handler (audited as `API_ERROR`
  in B). A 404 returns "Content <id> was not found or is not visible to this token" (audited as
  `NOT_FOUND`). Unknown keys and 404s are kept in a 60 s negative cache.
- Step 7: the budget slot is reserved in the pre phase whenever the content id is known (every
  content read except the title tools). A `count` spec whose id is not known in the phase where
  it is decided is denied when a budget is set (S1). There is no second budget decision.
- Step 8: a manifest tool's error result is replaced by a fixed text that names the status
  class only (`The request failed (rate limited); nothing was returned.`), so an error message
  cannot carry out-of-scope names. An explicit empty manifest is required for "not found".
- Step 9: content-read handlers that already hold the response `spaceId` attach an optional
  manifest item; a space different from the pre-resolved one withholds the result (narrows R2).
- Step 11: the change note is attached to the next final result only; an 8.0.0
  `input_required` result is not final and does not consume it (`isFinalResult`,
  [02 §5](02-interfaces.md#5-srcservergatets-shell)). The wrapper returns the handler's whole
  result (`structuredContent`, `_meta` and `isError` kept); receipt and change note are separate
  text blocks appended after the handler's blocks on a result with `structuredContent` and
  prepended (change note) or appended (receipt) otherwise.
- The handler's text is never edited. Receipt and change note are outside any `fenceUntrusted`
  fence (`src/server/index.ts:392`, `:425`).
- Step A writes one line per deny to the profile audit log (`appendAuditLog`,
  `src/shared/profiles.ts:320`): code, tool, content ID or space key, profile. At most 1,000
  per process, then one `further denies suppressed` line. Step B moves deny records to the read
  log.

## 1.5 `index.ts` hunks (complete list)

None touches an `inputSchema` block (W-SHAPES' territory). H1–H2 ship in step 0 (7.6.1) on SDK
1.x; W-SDK carries them into `serveStdio(factory)` in 8.0.0 (they sit in its region, plan
`:737`). H3–H10 are written for step A against the 8.0.0 tag: `main` with
`serveStdio(factory)`, handler `ctx`, result type `CallToolResult` from
`@modelcontextprotocol/server`. If 8.1.0 C6 has moved handlers into `src/server/tools/<tool>.ts`
by then, H7–H10 land in those modules instead.

| # | Where (7.6.0) | Change | Step | Size |
|---|---|---|---|---|
| H1 | `main()` `:6330-6339` | Before `getConfig()`: `const registry = process.env.CONFLUENCE_PROFILE ? await readRegistry() : { state: "absent", observed: "absent" }`; `unreadable` → `startRecoveryServer(profile, reason)`; pass `{ registry }` to the first `getConfig` call. Keep a catch for `RegistryUnreadableError` beside `ProfileNotConfiguredError` as a backstop | 0 | +8 |
| H2 | `startRecoveryServer` `:6282-6324` | Signature `(profile, reason: RecoveryReason)`; name, instructions, description and result text from the pure `recoveryText(profile, reason)` | 0 | ~25 changed |
| H3 | `main()` `:6345-6385`, before the `serveStdio` factory | From the H1 read and `readPolicyAnchor`: `projectPolicy`, `reconcileAnchor`; `invalid-settings` on an enforcing profile → recovery (D28; `anchor-unreadable` starts normally and denies, 03 §5.4); build `PolicyStore` once and capture it for the factory; pass the load to `buildServerInstructions` and `registerTools`; create `ReadLog` (B) next to `initMutationLog` | A (log: B) | +14 |
| H4 | `buildServerInstructions` `:1083-1117` | Optional `policyLines?: readonly string[]` appended (placement per 8.0.0 S0 item 4) | A | +3 |
| H5 | `registerTools` `:1119-1141` | Signature gains `deps: { store, gate }`; `settings` from the passed load, not `getProfileSettings` (`:1123-1125`; fixes the double read); `checkSpaceAllowed` (`:1130-1136`) reads `spaces` from `store.current()` (D18) and refuses `POLICY_UNREADABLE` when unreadable; `readScope` (`:1141`) per call from the snapshot | A | ~12 changed |
| H6 | Shim `:1169-1187`, edited in place | After the three filters: assert the registration has an `inputSchema`; `Object.hasOwn(GATE_SPECS, name)` (throw `UndeclaredToolError` when absent); call `originalRegisterTool(name, {...cfg, description: cfg.description + suffix}, gateHandler(name, spec, handler, deps.gate))` | A | +9 |
| H7 | `search_pages` (`:3568`, scope near `:3604`), `get_recent_changes` (`:5693`, near `:5756`) | Scope from snapshot; never an unscoped query; post-filter hits with `inScope`; "Some results were withheld by the read policy." (no count); manifest from response space ids (the `space` expansion where present), also for `get_recent_changes` with `spaces[]`; seed `pageSpaceCache` from hits | A | ~18 |
| H8 | `get_spaces` `:3756` | Filter with `inScope` on response key and type; "Showing spaces readable under this profile's policy."; manifest | A | ~6 |
| H9 | `list_pages` `:3684` | Manifest from the returned pages' `spaceId` (must equal the resolved id); seed `pageSpaceCache` | A | ~5 |
| H10 | `get_page_by_title` `:3811`, `resolve_page_link` `:6113` | Manifest `{contentId, space}` from the response (`spaceId` → `getSpaceById`; `spaceKeyFromResponse`), explicit empty manifest when not found | A (moved from B, D34) | ~6 |

`get_page` and the version, comment and label handlers call `pageSpaceCache.seed` and attach the
optional manifest item where they already hold `spaceId` (one or two lines each, outside
`inputSchema`; counted in H7's budget of handler lines).

## 1.6 8.0.0 interplay

- **Sequencing (D22):** step 0 ships as 7.6.1 on SDK 1.x; W-SDK carries H1–H2 into
  `serveStdio`. Step A is built after 8.0.0 is released, against SDK 2.x and the post-W-SHAPES
  `index.ts`, so it never rebases over the SDK migration and W-SHAPES never rebases over it.
- The shim stays where it is; W-SDK keeps "the registerTool wrapper semantics" (plan `:449`).
  The gate call inside it is one expression.
- `serveStdio(factory)`: `PolicyStore`, `ReadBudgetLedger` and `ReadLog` are created once in
  `main()` before the factory and captured; the factory's servers register through the same
  shim, so a per-request factory does not re-read the registry (plan `:439-442`).
- `getClientLabel` and `clientSupportsElicitation` read the handler `ctx` in 8.0.0 (plan
  `:446`); `GateDeps.clientLabel(ctx)` and `GateDeps.capabilities(ctx)` are per request. A
  2026-era request without client info gives label `null` in the read log.
- `isFinalResult` recognises the SDK 2.x `inputRequired(...)` result; the exact wire name comes
  from 8.0.0 S0.
- 8.1.0 C6 (`src/server/tools/<tool>.ts`, `register<Tool>(server, deps)`): each tool module
  exports its own spec row (`export const gateSpec = … satisfies GateSpec`); `GATE_SPECS` is
  assembled from a typed import list in `gate-core.ts` (`{ ...CORE_SPECS, move_page:
  moveGateSpec, … } satisfies Record<KnownTool, GateSpec>`), so the mapping stays exhaustive and
  a module cannot register without a row. Add to C6: "`deps` carries no read gate; the gate is
  in the server's `registerTool`."
- 8.1.0 W-META-8.1 caps descriptions at 1,800 characters after wrappers; the policy suffix is
  included in that measurement (test in [06 A-T8](06-deliverables.md#step-a)).
- 2026-era `instructions` placement (8.0.0 S0 item 4) decides whether the agent sees the scope
  line at all; the five description suffixes that name keys carry the short form regardless
  (open question Q10).
