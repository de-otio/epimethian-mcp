# Plan: MCP SDK v2, protocol 2026-07-28, Confluence v2 API and new tools

**Status:** proposed (2026-11-22). Nothing here is implemented.
**Base:** `master` after **7.5.0** (released 2026-11-22).
That release already adds main-server `instructions`, `/pages/{id}/direct-children` in place
of `/children`, a clear error for a 410 from v1, and the `anthropic/alwaysLoad` and
`maxResultSizeChars` `_meta` keys. This plan builds on those and does not re-plan them.
**Inputs:** the 2026-11-22 research summarised in §2, and the backlog in
[field-session-findings-2026-10.md](field-session-findings-2026-10.md) §1 ("7.2.0 (later)",
"7.4.0 (later)"), with IDs (T1–T4, A1–A4, R2, S-H4, S-M8, S-M11) from
[the investigation](../doc/design/investigations/investigate-field-session-findings-2026-10.md).

## 1. Releases

Three releases, split by risk and by what can be verified on its own:

| Release | Contents | Why grouped |
|---|---|---|
| **7.6.0** (minor, still on SDK 1.x) | v1 → v2 read swaps (W-V2READ, W-HIST), optional **gateway mode** for scoped API tokens, with a fixed capability map and stated degradations (W-GW), token-expiry reminder in `status` (W-GW) | Confluence-side only. No protocol change, so a regression is a Confluence API question and can be checked with read-only live calls. Users on Node 18 get one last minor with the v2 reads |
| **8.0.0** (major) | SDK `@modelcontextprotocol/server` 2.4.x, both protocol eras over stdio, confirmation gate redesigned for multi round-trip (MRTR), Node ≥ 20 floor, real stdio smoke test, raw zod shapes → `z.object` | Breaking (Node floor, SDK, `$schema` 2020-12 in `tools/list`). The confirmation gate is the security-critical change; it ships with no other behaviour change so a regression points at one thing |
| **8.1.0** (minor) | New tools: `move_page` (same space), `delete_attachment` (trash only), `insert_section`, `rename_heading`, `get_page` `grep`, folder reads, `get_tasks` (read). R2 label memo | Additive. Built once on the v2 SDK and the new gate, instead of being built on 1.x and ported |

Why this order:

- **SDK 1.x deadline.** v1.x gets fixes only until about 2027-01-27. 8.0.0 must be on npm by
  early January 2027, leaving three weeks for field reports. Count back from that date.
- **7.6.0 before 8.0.0.** The API swaps touch `confluence-client.ts`, the CLI and the keychain;
  the SDK migration touches `index.ts`, `elicitation.ts`, the build and CI. Shipping 7.6.0
  first keeps the 8.0.0 diff to the protocol layer. The two can be **built** in parallel
  (§3); only the merges are ordered.
- **New tools after 8.0.0.** Every new write tool needs the confirmation gate. Building them on
  the 1.x gate means writing the gate glue twice. The 8.1.0 tools are also the first users of
  `z.object` schemas and the era-aware gate, which tests the 8.0.0 contracts.
- **Rejected: one 8.0.0 with everything.** About 40 tool registrations change shape, the gate is
  rewritten, nine v1 call sites move, and seven tools are added. That cannot be verified in one
  session (house rule: small enough to verify in one session).

**Deferred, with reasons:**

| Item | Reason |
|---|---|
| `copy_page` / copy tree | v1 only (`/content/{id}/copy`, `/pagehierarchy/copy` as an async long task). Partial copies on failure, duplicated titles (`Copy of …`), copied restrictions and attachments. Needs its own data-loss design. Earliest 8.2.0 |
| Archive / unarchive | v1 only (`/content/archive`, async long task). Unarchive needs admin on some plans. Reversible but bulk side effects. 8.2.0 at earliest, with copy |
| Templates (`get_templates`, create from template) | v1 only (`/template`); no v2. Unavailable in gateway mode from day one. Low demand in the field findings |
| `update_task` (task status writes) | v2 `PUT /tasks/{id}` rewrites the page body and bumps the version outside our pipeline (no safe-write, no cache eviction we control). Read first (8.1.0), write later |
| `create_folder` / folder moves | Reads first. A folder create is low risk, but moving content into folders shares `move_page`'s exposure question |
| Export (PDF/Word) | No supported Cloud REST API for PDF export. `get_page format: "markdown"` and `download_attachment` cover local export today |
| T1 `compact`, T4 tolerant matching, R4 | Write-path matching changes; keep isolated (as decided in the field-session plan). After 8.1.0 |
| Attachment purge | Irreversible. Unchanged from the field-session plan |

## 2. Verified facts this plan relies on

MCP / SDK (spec changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog;
SDK migration: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs/migration and
`docs/protocol-versions.md` in the same repo):

- 2026-07-28 is final. No `initialize` handshake or sessions; client capabilities arrive per
  request in `_meta`; `server/discover` replaces the handshake for metadata.
- Servers can no longer send requests during a call. Elicitation, sampling and roots use
  **multi round-trip**: the tool returns `input_required`; the client retries the same call
  with `inputResponses`. Roots, sampling and logging are deprecated. Tasks and MCP Apps are
  extensions. `tools/list` SHOULD be deterministic. Schemas are JSON Schema 2020-12.
- TypeScript SDK v2 shipped 2026-07-27, latest 2.4.0. Packages: `@modelcontextprotocol/server`
  and `@modelcontextprotocol/client`. Node 20+. CJS build kept. A codemod exists.
  `registerTool` stays and takes Standard Schema; raw zod shapes are deprecated; zod ≥ 4.2
  (we have 4.6.7). `server.elicitInput` is deprecated in favour of `ctx.mcpReq.elicitInput`
  (2025-era) and `inputRequired(...)` (2026-era). `serveStdio(factory)` serves both eras.
  2.4.0 type-checks `structuredContent` against `outputSchema`.

Confluence:

- v1 REST answers **410** on the `api.atlassian.com/ex/confluence/{cloudId}` gateway (reports
  from about 2026-08 and 2026-11). Site-URL Basic auth still reaches v1. Deprecation notice
  CHANGE-864.
- v2 has: `GET /pages/{id}?version=N&body-format=storage`, `GET /pages/{id}/versions`,
  `GET /pages/{id}/labels` (read only), `GET`/`DELETE /attachments`, ancestors, descendants,
  content properties, folders, tasks, restriction-state/permissions (new 2026-10-14),
  `spaces/{id}/permissions`, `users-bulk`.
- v2 has **no** label add/remove, attachment upload, content state, CQL search or user search.
  Tracked upstream as CONFCLOUD-77196 and CONFCLOUD-76866.
- Scoped API tokens work only through the gateway, where v1 is gone and v2 needs granular
  scopes. API tokens expire after at most one year.

Not yet verified, so they are tasks, not assumptions: which individual v1 endpoints 410 on the
gateway (all of them, or only some); whether v2 historical reads return byte-identical storage
for every version kind (investigation open question 2); `serveStdio`'s factory lifetime
(per process, per connection or per request); the exact wire names of `input_required`,
`inputResponses` and any request-state field; where `instructions` live in the 2026 era.

## 3. Dependency DAG (all three releases)

```
Phase 0 (orchestrator): branch release/7.6.0 off master at 7.5.0; npm ci; full suite green
  │
  ├── Wave A (parallel, ≤4 test-running agents)
  │     lane 1: W-INV (live read-only probe matrix; no src edits)       ── Sonnet, medium
  │     lane 2: W-V2READ ──► W-HIST                                     ── Sonnet, high (same agent)
  │     lane 3: W-GW                                                    ── Opus design → Sonnet build
  │     lane 4: S0 SDK spike (throwaway worktree, never merged)         ── Opus, high
  │                └─► W-GATE-SPEC (design doc only)                    ── Opus, high
  ▼
I-7.5 integration: merge W-V2READ+W-HIST, then W-GW; W-INV results gate W-HIST's revert switch
  ▼ W-REVIEW-7.5 (Opus, read-only data-loss walk) → fixes → docs (Haiku) → 7.6.0 release checkpoint
  ▼
Branch release/8.0.0 off 7.6.0
  ├── Wave B
  │     lane 1: W-SDK (deps, codemod, serveStdio, ctx accessors, Node floor, build, CI)  ── Sonnet, high
  │     lane 2: W-GATE (era-aware gate + approval store), starts from W-GATE-SPEC          ── Opus, high
  │     lane 3: W-SMOKE (bundle smoke harness + mock Confluence)                           ── Sonnet, medium
  ▼
I-8.0a: W-SDK first, then W-GATE (rebased on W-SDK), then W-SMOKE
  ▼
Wave C: W-SHAPES (sole owner of index.ts: raw shapes → z.object, golden diff)  ── Sonnet, medium
  ▼
Wave D: test-critic on W-GATE + W-SMOKE ∥ security-reviewer (gate) ∥ Opus data-loss walk
  ▼ fixes (Opus, high) → docs (Sonnet medium + Haiku) → 8.0.0 release checkpoint
  ▼
Branch release/8.1.0 off 8.0.0
  ├── Wave E (parallel)
  │     lane 1: W-MOVE                 ── Opus, high (exposure + ordering design), Sonnet tests
  │     lane 2: W-DELATT               ── Sonnet, high
  │     lane 3: W-STRUCT (insert_section, rename_heading) ── Opus, high
  │     lane 4: W-READS (grep, folder reads, get_tasks, R2 memo) ── Sonnet, medium
  ▼
I-8.1 (fixed merge order: READS, DELATT, MOVE, STRUCT) → W-META-8.1 (annotations, golden
  list, descriptions) → reviews → docs → 8.1.0 release checkpoint
```

Why each edge exists:

- **W-HIST after W-V2READ, same agent:** both edit the version/attachment region of
  `confluence-client.ts` (lines ~2160–2700); serialising avoids neighbouring-hunk merges.
- **W-HIST's revert switch waits for W-INV:** `revert_page` writes what the historical read
  returns. It moves to v2 only after byte parity is shown (§5.2).
- **W-GW ∥ W-V2READ:** W-GW owns `getConfig`/`Config`, the request base and
  `resolveDownloadUrl`; W-V2READ owns the read functions. Contract C1 (§4) fixes the shape both
  use.
- **S0 and W-GATE-SPEC in Wave A:** no `src/` edits, so they cost nothing to run early, and
  W-GATE cannot start without their answers.
- **W-GATE after W-SDK at merge:** W-GATE uses the v2 handler `ctx`. It is developed against the
  spike's API notes and rebased onto W-SDK before merge.
- **W-SHAPES alone:** it edits every `registerTool` block, which every other 8.0.0 lane touches.
- **8.1.0 lanes in parallel:** each new tool lives in its own handler module (contract C6), so
  `index.ts` only gains one import and one register call per tool; the integrator resolves those.

## 4. Cross-workstream contracts

- **C1. Endpoint base.** `Config` gains `apiMode: "site" | "gateway"`, `apiV2: string`, and
  `apiV1: string | null`. `apiV1` is `null` in gateway mode. The type change makes the compiler
  list every v1 call site; each must either have a v2 path or go through
  `requireV1(feature)`, which throws `FeatureUnavailableInGatewayMode` (a typed error with the
  feature name, mapped to a fixed tool message). Nobody builds a URL from `cfg.url` for API
  calls except W-GW's base builder. `siteUrl` stays the source for human links (`webui`).
- **C2. Capability map.** `api-capabilities.ts` (pure) exports
  `capabilitiesFor(mode): Readonly<Record<Feature, boolean>>`. It is computed once at startup
  from the mode and a **static** table filled from W-INV's results, never probed at runtime, so
  `tools/list` is deterministic for a given profile.
- **C3. Content-type routing for v2 reads.** v1 `content/{id}/…` did not care about page vs blog
  post; v2 does. Every swapped read takes `ContentType` (from `resolveContentType`, already in
  the client) and builds `/pages/…` or `/blogposts/…`. No swap may silently drop blog-post
  support that v1 gave.
- **C4. Confirmation binding (8.0.0).** One binding type for every gate, in both eras and both
  paths (elicitation and soft token): `{kind, tool, cloudId, targetIds, targetVersion,
  diffHash, argsHash}`. `argsHash` = SHA-256 of canonical JSON of the tool arguments with
  `confirm_token` and `batch_token` removed. `kind` is `"mrtr"` or `"soft"`; a value minted
  for one kind never validates as the other.
- **C5. No mutation before the gate.** No Confluence request other than GET/HEAD, no
  write-budget consumption, no mutation-log write and no local file write may happen before a
  gate resolves. A test enforces it for every gated tool (§6.2).
- **C6. New tool modules (8.1.0).** Each new tool's handler lives in
  `src/server/tools/<tool>.ts` exporting `register<Tool>(server, deps)`. `deps` carries the
  shared guards (`checkSpaceAllowed`, `gate`, `writeBudget`, `logMutation`, attribution).
  Tests go in new files named after the workstream (house contract 5). New
  `confluence-client.ts` exports are added to the hand-written mock block in `index.test.ts`;
  the integrator resolves those conflicts.
- **C7. House contracts carry over** from the field-session plan §3: results with
  `outputSchema` carry `structuredContent` on every non-error path (contract 4), module
  singletons export `_resetForTests()` (contract 6), every page body write goes through
  `safeSubmitPage` (`no-direct-raw-writer.test.ts`).

## 5. Release 7.6.0 workstreams

### 5.1 W-INV — live probe matrix · Sonnet, medium (lane 1)

**Scope.** Establish facts, write no product code. Output: a table committed as
`doc/design/investigations/investigate-v1-v2-parity-2026-11.md` and an opt-in script
`scripts/live/v2-parity.mjs` (never run in CI; takes `--profile` and page ids on the command
line; prints counts and hashes, never bodies, titles or names).

1. **Site mode, designated test profile, read-only.** For each row of the inventory (§5.4),
   call the v1 and the v2 endpoint on the same ids and compare: status, result count, ordering,
   and the fields our schemas read. Ids: at least 5 pages (one with macros and tables, one
   with a draw.io diagram, one with more than 25 versions, one converted from the legacy
   editor, one with a restore in its history) and 2 blog posts.
2. **Historical bodies.** For at least 30 versions across those pages, compare SHA-256 of
   v1 `content/{id}?version=N&expand=body.storage` and v2 `pages/{id}?version=N&body-format=storage`
   (and `/blogposts/…`). Record whether v2 echoes `version.number === N` for each.
3. **Gateway mode** (only if the user provides a scoped, read-only token for the designated test
   profile; open question Q2). For every v1 GET in the inventory, record the gateway status
   (410 or not). For every v2 read, record the minimum granular scope that makes it pass.
   No write requests in gateway mode, not even probes, unless the user permits one for that run,
   and then only in the user's personal space.

**Done:** the doc has one row per inventory line with a status for both modes (or "not
verified: no scoped token"), the parity counts, and the scope list. No tenant names, hosts,
space keys or titles appear in it (marker grep before reporting).

### 5.2 W-V2READ then W-HIST · Sonnet, high (lane 2, one agent, two commits)

**Files:** `confluence-client.ts` (functions `getAttachments`, `findAttachmentByName`,
`getAttachmentMetadata`, `getPageVersions`, `getPageVersionBody`, `getVersionStorage`,
`fetchV1VersionBody`, `getLabels`, `probeWriteCapability`), new tests
`v2-read-swaps.test.ts`, `historical-read.test.ts`. Handlers in `index.ts` only where the output
shape changes (`get_page_versions` author field).

**W-V2READ design.**

1. `getAttachments` → `GET /{pages|blogposts}/{id}/attachments` with cursor pagination (follow
   `_links.next`, same page limit as today). Map v2 fields to the existing `AttachmentData`
   shape so tool output is unchanged.
2. `findAttachmentByName` → the same endpoint with `filename=`, then an **exact,
   case-sensitive post-filter** on the title. Zero matches → not found; more than one exact
   match → refuse with an ambiguity error (never pick the first).
3. `getPageVersions` → `GET /{pages|blogposts}/{id}/versions` sorted newest first. v2 gives
   `authorId`, not a display name: resolve names with one `POST /users-bulk` per call (deduped,
   cached per tenant for the process, same cache keying as the space-key cache). If the lookup
   fails, show the account id; never fail the read.
4. `getLabels` → `GET /{pages|blogposts}/{id}/labels`. `addLabels`/`removeLabel` stay v1.
5. `probeWriteCapability` primary → v2 permitted-operations for the space (W-INV confirms the
   endpoint; if it does not exist, keep the v1 call in site mode). The dry-run fallback is
   unchanged.

**W-HIST design.**

1. New `getHistoricalStorage(id, type, version)` on v2 `?version=N&body-format=storage`.
   **Fail closed:** if the response's `version.number !== N`, or the body is missing, or the
   representation is not `storage`, throw `HistoricalReadMismatchError`. Never fall back to the
   current body.
2. `get_page_version` and `diff_page_versions` switch to it in both modes.
3. `revert_page` switches only when W-INV shows 30/30 byte-identical bodies. Otherwise, in site
   mode it keeps v1 and the CHANGELOG says why; in gateway mode it uses v2 with the step-1
   assertion and the existing content-safety guards.
4. The versioned page cache key gains the source (`v1`/`v2`) for one release, so a body
   cached from one source is never compared with the other in a diff.

**Data-loss analysis.**

- *Wrong historical body written by `revert_page`:* the main risk. Covered by the version
  assertion, byte parity before switching, and the existing revert guards (shrinkage, structure
  loss, confirmation).
- *v2 ignores `?version=` for some content (returns current):* the assertion catches it; the
  result would otherwise be a silent no-op revert or an empty diff ("No changes").
- *Substring attachment match:* `update_drawio_diagram` and `add_attachment` with
  `overwrite` would add a version to the wrong file. The exact post-filter and the
  ambiguity refusal prevent it.
- *Attachment id format:* v2 ids carry an `att` prefix; `uploadAttachmentVersion` (still v1)
  accepts both (`ATTACHMENT_ID_RE`). A test round-trips a v2 id into the v1 upload URL.
- *Version order flipped:* nothing computes "previous version" from list position (diffs take
  explicit numbers), but a test pins newest-first.
- *Blog posts regress:* contract C3; every swap has a blog-post test.

**Tests (each must fail on the pre-change code or on a plausible wrong implementation):**

- Request-URL assertions per swap, for page and blog post ids (not only output assertions).
- `findAttachmentByName("a.drawio")` with `a.drawio` and `a.drawio.bak` returned → exact
  match; with two exact matches → ambiguity error, no upload request.
- Historical read: response with `version.number = N+1` → throws; missing body → throws; the
  revert handler then issues **no PUT**.
- `users-bulk` failure → versions still listed with ids.
- Pagination: 3 pages of attachments followed via cursor; a cursor pointing at another origin
  is refused (same rule as download redirects).
- Property (fast-check, fixed seed): for any list of attachment titles, the post-filter
  returns exactly the titles `=== name`.

**Live read-only verification:** `get_attachments`, `get_labels`, `get_page_versions`,
`get_page_version`, `diff_page_versions` on the W-INV ids, through a local build connected to
the designated test profile; outputs match the 7.5.0 build except the documented author field.

**Done:** all inventory rows owned here are on v2 or marked "stays v1, why"; scoped tests green;
no new `tsc` errors in touched files.

### 5.3 W-GW — gateway mode · Opus, high (design), then Sonnet, high (build) (lane 3)

**Files:** `confluence-client.ts` (`getConfig`, `Config`, `validateStartup` area,
`resolveDownloadUrl`, request base), `src/shared/keychain.ts`, `src/shared/test-connection.ts`,
`src/cli/setup.ts`, `src/cli/status.ts`, new `api-capabilities.ts`, `request-policy.ts` (origin
rule only), new tests `gateway-mode.test.ts`, `api-capabilities.test.ts`.

**Design decisions.**

1. **Where the mode lives.** In the keychain record next to the token
   (`apiMode?: "gateway"`; absent = site), because a scoped token only works through the
   gateway: the mode is a property of the credential, not of the profile's policy. Setup asks
   "Is this a scoped API token?" and writes both together.
2. **Requires the tenant seal.** Gateway mode needs `cloudId` from the seal. A pre-seal profile
   cannot switch to gateway mode; setup re-runs the seal first. The gateway base is built only
   from the sealed `cloudId`, never from user input, so a token cannot be pointed at another
   tenant's cloudId by editing a URL.
3. **Startup checks in gateway mode.** `/_edge/tenant_info` on the site URL (unauthenticated,
   as today) must return the sealed `cloudId`; then `GET {gateway}/wiki/api/v2/spaces?limit=1`
   must succeed. v1 `/user/current` is not called. A 401 names scoped-token expiry or a missing
   scope.
4. **Origin pinning.** In gateway mode the only credentialed origin+path prefix is
   `https://api.atlassian.com/ex/confluence/{sealedCloudId}/`. `resolveDownloadUrl` and
   pagination cursors are checked against it. The credential latch on redirects is unchanged.
   Human-facing links are built from the site URL, never from a response's `_links.base`.
5. **Capability map (C2) and degradation.** Fixed at startup (table below). Tools whose core
   call is unavailable are **not registered** in gateway mode (decided, Q3), and the
   main-server `instructions` gain one line naming the mode and the missing tools.
6. **Side writes that degrade.** The attribution label (`ensureAttributionLabel`) and the
   unverified badge (`markPageUnverified`) both need v1. In gateway mode both are skipped
   silently: no opt-in flag and no per-write warning (decided, Q4). The version comment
   attribution still applies. A test asserts that a gateway-mode write makes no v1 call and
   still sends the version comment.
7. **Scopes.** Setup prints the granular scope list for the chosen posture. Read posture:
   `read:page:confluence`, `read:blogpost:confluence`, `read:space:confluence`,
   `read:attachment:confluence`, `read:label:confluence`, `read:comment:confluence`,
   `read:hierarchical-content:confluence`, `read:folder:confluence`, `read:task:confluence`,
   `read:content.property:confluence`, `read:user:confluence`,
   `read:space.permission:confluence`. Write posture adds `write:page:confluence`,
   `write:blogpost:confluence`, `delete:page:confluence`, `write:comment:confluence`,
   `delete:comment:confluence`, `delete:attachment:confluence`. W-INV corrects this list
   against live results; the final list goes into `doc/user-doc` and setup output.
8. **Scope probe at setup** (global rule R4: one call must pass, one must fail). A read-posture
   token must pass the spaces read and **fail** the existing dry-run write probe (403). If the
   write probe does not fail, setup warns that the token is broader than the posture.
9. **Token expiry.** Atlassian does not expose a token's expiry through the REST API (W-INV
   confirms). Setup asks for the expiry date shown when the token was created (optional,
   `YYYY-MM-DD`), stored in the keychain record. `status` prints days left; the server's
   stderr banner warns at ≤ 14 days; an expired date gives a clear startup error. Whether it
   also appears in `get_version` or `check_permissions` is Q5.

**Gateway capability table (to be confirmed by W-INV):**

| Feature | Site mode | Gateway mode |
|---|---|---|
| Page/blog read, create, update, delete, children, comments | v2 | v2 |
| Versions list, historical body, labels read, attachments list/metadata | v2 (7.6.0) | v2 |
| Attachment upload / new version (`add_attachment`, draw.io tools) | v1 | **unavailable** |
| Attachment download | site download path | gateway download path (W-INV verifies one exists; else unavailable) |
| `add_label`, `remove_label`, attribution label | v1 | **unavailable** / skipped |
| Content state (`get/set/remove_page_status`, unverified badge) | v1 | **unavailable** / skipped |
| `search_pages` (CQL), `get_recent_changes` | v1 `/search` | **unavailable** unless W-INV finds `/search` alive; `get_recent_changes` may fall back to v2 `GET /pages?sort=-modified-date` per space (degraded: no CQL filters) |
| `get_page_by_title` | v2 | v2 |
| `lookup_user` by name | v1 `/search/user` | **unavailable**; by account id via `users-bulk` |
| Write-capability probe | v2 operations / v1 | v2 operations / dry-run |
| Badge locale (`systemInfo`) | v1 | default locale |

**Data-loss / tenant-safety analysis.**

- *Cross-tenant write* (the catastrophic case for a multi-tenant consultant): the gateway URL is
  derived from the sealed cloudId only, startup checks that the site's tenant_info still
  returns it, and the token is scoped to that site. Test: a keychain record whose site
  tenant_info returns a different cloudId refuses to start.
- *Credential sent off-tenant:* origin+prefix pinning, including for pagination cursors and
  download redirects.
- *Silent loss of the human "unverified" signal:* stated in banner, results and docs; Q4.
- *A tool that half-works:* e.g. `add_drawio_diagram` uploads (v1) then edits the page (v2).
  In gateway mode the upload is unavailable, so the tool is not registered at all; no partial
  state is possible.

**Tests:** capability table pinned exactly (both modes); `apiV1 === null` in gateway mode and
every v1 helper throws `FeatureUnavailableInGatewayMode` without a request; origin pinning
(gateway prefix with another cloudId → refused; `api.atlassian.com` without the prefix →
refused); setup writes mode and expiry only together with a sealed cloudId; `status` output at
15, 14, 0 and −1 days (frozen clock); `tools/list` in gateway mode equals the golden gateway
list and is byte-identical across two calls.

**Live verification:** site mode unchanged against the designated test profile (`status`,
`get_version`, `get_page`). Gateway mode only with a user-provided read-only scoped token:
startup, `get_page`, `get_page_versions`, `get_attachments`; confirm the unavailable tools are
absent. No writes.

**Done:** setup/status/keychain/startup changes tested; gateway mode documented in
`doc/user-doc` with the scope list and the degradation table.

### 5.4 v1 call inventory (owned by W-V2READ, W-HIST, W-GW; verified by W-INV)

| v1 call (`confluence-client.ts`) | Used by | v2 replacement | Decision | Live check (read-only) |
|---|---|---|---|---|
| `GET content/{id}/child/attachment` (`getAttachments`, `findAttachmentByName`) | `get_attachments`, draw.io tools, `add_attachment` overwrite | `GET /pages|blogposts/{id}/attachments` (`filename=`) | swap (W-V2READ) | same ids, counts and titles |
| `GET …/child/attachment/{attId}/data` and site `/download/…` | `download_attachment` | v2 attachment `downloadLink` | swap metadata; download path per W-INV | download one small file, compare SHA-256 |
| `POST content/{id}/child/attachment` (`uploadAttachment`) | `add_attachment`, `add_drawio_diagram` | none | **stays v1** (CONFCLOUD-77196 / -76866); gateway: unavailable | none (write) |
| `POST …/child/attachment/{attId}/data` (`uploadAttachmentVersion`) | `update_drawio_diagram`, overwrite | none | **stays v1**; gateway: unavailable | none (write) |
| `GET content/{id}/version` (`getPageVersions`) | `get_page_versions` | `GET /pages|blogposts/{id}/versions` + `users-bulk` | swap (W-V2READ) | same numbers and order |
| `GET content/{id}?version=N&expand=body.storage` (`fetchV1VersionBody`) | `get_page_version`, `diff_page_versions`, `revert_page` | `GET /pages|blogposts/{id}?version=N&body-format=storage` | swap reads; revert after parity (W-HIST) | 30 versions, hash parity |
| `GET content/{id}/label` (`getLabels`) | `get_labels`, attribution | `GET /pages|blogposts/{id}/labels` | swap | same names and prefixes |
| `POST/DELETE content/{id}/label` | `add_label`, `remove_label`, attribution | none | **stays v1**; gateway: unavailable/skipped | none (write) |
| `GET/PUT/DELETE content/{id}/state` | status tools, unverified badge | none | **stays v1**; gateway: unavailable/skipped | `get_page_status` only |
| `GET /search` (CQL) (`searchContent`, `searchPagesByTitle`) | `search_pages`, `get_recent_changes` | none for CQL | **stays v1**; gateway per W-INV | n/a |
| `GET /search/user` (`searchUsers`) | `lookup_user` | `POST /users-bulk` (ids only) | stays v1 for names | n/a |
| `GET user/current/permission/space/{key}` (`probeWriteCapability`) | startup posture | v2 space permitted operations (verify) | swap if W-INV confirms | posture unchanged |
| `GET settings/systemInfo` (`getSiteDefaultLocale`) | badge locale | none | **stays v1**; gateway: default | n/a |
| `GET user/current` (`test-connection.ts`) | setup, status, startup | `GET /spaces?limit=1` in gateway mode | site: stays; gateway: replaced (W-GW) | `status` |

## 6. Release 8.0.0 workstreams

### 6.1 S0 spike and W-GATE-SPEC · Opus, high (Wave A, lane 4)

**S0** runs the official codemod in a throwaway worktree (never merged; removed when done) and
answers, with file:line references into the SDK's published source:

1. `serveStdio(factory)`: is the factory called once per process, per connection or per
   request? Any per-`McpServer` state (`fakingElicitationFlags` WeakMap, `getClientLabel`,
   `_sessionIsReadOnly`) depends on the answer.
2. The handler `ctx`: accessors for client capabilities (2026: per request; 2025: from
   initialize), client info (for `clientLabel` and attribution), and protocol era.
3. `inputRequired(...)`: exact shape, how `inputResponses` reach the handler, whether a
   request-state field exists and whether the SDK signs or validates it.
4. Where `instructions` go in the 2026 era (`server/discover` result?).
5. `outputSchema` checks in 2.4.0: compile time only, or also at runtime? What happens to an
   `input_required` result on a tool that declares `outputSchema`?
6. The emitted `tools/list` JSON for one tool with raw shape vs `z.object`: `$schema`,
   `additionalProperties`, defaults.
7. Bundling: build the spike with our esbuild config; is the `zod/v4` alias still needed or
   harmful; does `dist/cli/index.js agent-guide` start; does the server answer `tools/list`
   over stdio in both eras.
8. Whether the codemod handles `InMemoryTransport` in our ~20 integration tests.

**W-GATE-SPEC** turns §6.3 into `doc/design/security/07-confirmation-mrtr.md` using S0's
answers: the state machine, the binding (C4), the era × capability matrix and the test list.
It is reviewed by the `security-reviewer` agent (omit `model`) **before** W-GATE starts.

**Done:** spike report (8 answers) and the spec, reviewed; spike worktree removed.

### 6.2 W-SDK — migration · Sonnet, high (Wave B, lane 1)

**Files:** `package.json`, `package-lock.json`, `esbuild.config.mjs`, `.github/workflows/build.yml`,
`.github/workflows/publish.yml` (load the `github-actions-workflows` skill first),
`src/server/index.ts` (imports, `main`, `startRecoveryServer`, `getClientLabel`,
`clientSupportsElicitation`, the `registerTool` wrapper), `src/server/elicitation.ts` imports
only, test-file imports, `src/shared/update-check.ts` and `src/cli/upgrade.ts` (Node gate).

1. Replace `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server` (exact 2.4.x minor
   that is at least two weeks old at build time) and, as a devDependency,
   `@modelcontextprotocol/client` for tests. Run the codemod, then hand-fix.
2. `main()` and `startRecoveryServer()` use `serveStdio(factory)`. The factory builds and
   registers the server; registration work that hits the network (`getProfileSettings`,
   posture) is done **once** before the factory and captured, so a per-request factory does not
   re-probe.
3. Per-session state (S0 item 1): move the fast-decline flag, read-only note flag and client
   label to a module-level store keyed by process (stdio has one client per process), with
   `_resetForTests()`.
4. `getClientLabel` and `clientSupportsElicitation` read from the handler `ctx` (per request).
   When a 2026-era request carries no client info, the label is `undefined` and attribution
   falls back to "MCP client"; a test pins that the version comment never contains `undefined`.
5. Keep `server.registerTool`'s wrapper semantics (profile filter, read-only gate) and the
   `_meta` keys from 7.5.0; `tool-surface.test.ts` stays the golden check.
6. `engines.node` → `>=20` (or `>=22`, Q6); esbuild `target` to match; CI matrix 20/22/24 (or
   22/24).
7. **Upgrade across the Node floor.** `upgrade` (tool and CLI) and the patch auto-upgrade
   refuse to install 8.x when `process.versions.node` is below the floor, with a message naming
   the required version. Auto-upgrade never crosses a major (already true; a test pins it).
8. `instructions` placed where S0 says for both eras.

**Data-loss analysis.** Two schema traps can turn a good write into a retry, which repeats an
append or a find_replace:
(a) a parsed-vs-raw argument mismatch (zod defaults not applied under Standard Schema), so a
handler sees `undefined` where it used to see a default;
(b) an output-validation failure after the write (contract 4).
Tests: every tool with a defaulted parameter receives the default when it is omitted; the
output-schema conformance test runs over the v2 SDK, and its tool list is generated from the
golden list, not hand-written.

**Tests:** existing suite green on SDK v2 (no assertion weakened; any changed assertion is listed
in the agent's report); `upgrade` refuses on a faked Node 18; attribution with no client info.

**Done:** build, scoped tests, `agent-guide` starts from the bundle, CI file valid.

### 6.3 W-GATE — confirmation across eras · Opus, high (Wave B, lane 2)

This is the security-critical part. Today's gate (`elicitation.ts`) has six rows: env bypasses
(1–3), soft token (4), fail-closed (5), in-call `elicitInput` (6). In 2026-era requests, row 6
cannot exist: the server cannot ask mid-call. The gate becomes a function of
**(era, client advertises elicitation in this request, call carries a confirmation)**.

**Files:** `src/server/elicitation.ts` (rewrite of `gateOperation` and the capability check),
new `src/server/pending-approvals.ts` (pure store + clock/random injection),
`src/server/confirmation-tokens.ts` (binding gains `kind` and `argsHash`), `index.ts` gate call
sites (9 today: `authorise_destructive_writes`, `update_page`, the blog publish helper,
`delete_page`, `update_page_section`, `update_page_sections`, `add_attachment`,
`update_drawio_diagram`, `revert_page`), new tests `gate-eras.test.ts`,
`pending-approvals.test.ts`, `gate-no-mutation.integration.test.ts`.

**Matrix (first matching row wins; rows 1–3 unchanged from today):**

| Era | Elicitation advertised (this request) | Call carries | Behaviour |
|---|---|---|---|
| any | any | — | Rows 1–3 env overrides, unchanged |
| 2025 | yes | — | `ctx.mcpReq.elicitInput`, fast-decline detection as today |
| 2026 | yes | no `inputResponses` for this gate | Mint pending approval (kind `mrtr`), return `input_required` with one elicitation request. **No mutation** (C5) |
| 2026 | yes | `inputResponses` | Validate (below); accept → proceed; decline/cancel → `USER_DECLINED`/`USER_CANCELLED`; mismatch/unknown/expired → fresh `input_required` |
| any | no | valid `confirm_token` (kind `soft`) | Proceed (soft path, as today) |
| any | no | no token / invalid | Mint soft token, `SOFT_CONFIRMATION_REQUIRED`, or row 5 fail-closed when binding fields are missing |

**Pending approval (2026 era).**

1. Id: `randomBytes(24)` base64url, with a prefix distinct from soft tokens. It is used as the
   `inputRequests` key (and as the only content of any request-state field). Nothing else
   travels through the client: no diff, no page content, no binding fields.
2. Stored server-side with the C4 binding, `expiresAt` (same TTL clamp as soft tokens),
   `humanSummary` (counts-only rule unchanged: no tenant text in prompts). Bounded store: 50
   outstanding, FIFO eviction, shared 15-minute mint budget with soft tokens.
3. **On retry the handler recomputes everything** from the retry's arguments and a fresh page
   read (version, prepared body, diff hash, args hash). The approval is looked up by the
   response key, **consumed atomically before comparison** (single use whatever the outcome),
   and must match every binding field. The client is trusted to relay the user's answer, as
   the 2025-era client already is; it is not trusted to keep the call the same.
4. The response must be `action: "accept"` with `content.confirm === true`, for exactly the
   key minted for this gate. Extra or missing keys → treated as no response (re-prompt).
5. Mismatch (page advanced, arguments changed) → discard, re-prompt with a summary that says the
   page changed since the user was asked. The new prompt shows the recomputed counts.
6. **Kind separation.** `validateToken` (soft) rejects an `mrtr` id; the approval store rejects
   a soft token. So a pending id that leaks into model context cannot be replayed as
   `confirm_token`, and the reverse.
7. **Sibling invalidation.** A successful write calls `invalidateForPage(cloudId, pageId)`, which
   now also drops pending approvals for that page.
8. **One gate per call.** Handlers that could reach two gates (the blog publish helper plus a
   deletion gate) merge them into one context with both reasons. A test harness counts gate
   invocations per handler run and fails on more than one.
9. **Fast-decline in the 2026 era.** The heuristic times the gap between minting and a
   `decline` response. The flag is process-wide (stdio, one client) per §6.2 item 3, so it
   survives a per-request factory.
10. **Batch tokens** (`authorise_destructive_writes`) use the same gate for their one prompt.
    `batch_token` validation is unchanged and still bypasses only the per-call gate for listed
    page ids.
11. **Clients that lack elicitation in the 2026 era** never receive `input_required` with an
    elicitation request; they get the soft path.

**Data-loss analysis.**

- *Write happens before the prompt:* C5, enforced by `gate-no-mutation.integration.test.ts`
  for all nine gated paths: when the result is `input_required` or `SOFT_CONFIRMATION_REQUIRED`,
  the fetch mock saw only GET/HEAD, `writeBudget` is unchanged, the mutation log has no new
  line, and no local file was written. `add_drawio_diagram`/`update_drawio_diagram` (upload then
  page edit) and `add_attachment` overwrite are the risky ones: the gate must sit before the
  upload.
- *Double apply on a duplicated retry:* single-use consumption plus the version binding. The
  second retry finds no approval → re-prompt. For writes with no version (delete, attachment
  overwrite), single use is the guard; the test sends the same accepted retry twice and asserts
  one mutation.
- *Approval for args A used for args B:* `argsHash`; property test below.
- *Outcome unknown after approval:* approval is consumed; the existing `WriteOutcomeUnknownError`
  rule (no `version: "current"` writes until a fresh read) still applies; a retry needs a new
  approval.
- *Era confusion in one process:* the era comes from the request being handled, never from a
  process-wide guess. A 2025-era client never gets `input_required`; a 2026-era request never
  triggers `elicitInput`.

**Tests (must fail on a wrong implementation):**

- Era × capability × call matrix as a table-driven test, one row per matrix line, against a
  real `McpServer` with SDK v2 `Client`s of both eras.
- Property (fast-check, fixed seed): for arbitrary tool arguments A and any B ≠ A (after
  removing `confirm_token`/`batch_token`), an approval minted for A never authorises B.
- Property: for random interleavings of mint/validate/invalidate across 3 pages, no approval
  validates twice and no approval validates after `invalidateForPage` for its page.
- An `mrtr` id passed as `confirm_token` → invalid; a soft token as an `inputResponses` key →
  re-prompt, no write.
- Expired approval (frozen clock, TTL + 1 ms) → re-prompt, no write.
- Page version advances between the two legs → re-prompt; the new prompt's counts are recomputed.
- Accept with `confirm: false`, accept with no content, unknown action → no write.
- A 2026 request without elicitation capability never gets `input_required`.
- Prompt text for a page whose title and body contain instruction-like text: no tenant text in
  the elicitation message (counts-only invariant).

**Live verification:** 2025 era with the user's current client (Claude Code) against the
designated test profile: one gated write **only if the user permits it for that run, and only in
the user's personal space** (a `update_page_section` with `confirm_deletions`), accept once and
decline once; check the page history shows exactly one new version. 2026 era: if no available
client speaks 2026-07-28 (Q8), the e2e in W-SMOKE against the mock is the release gate and the
CHANGELOG says so.

**Done:** matrix and property tests green; `security-reviewer` sign-off on the diff;
`doc/design/security/03-write-safety.md` updated.

### 6.4 W-SMOKE — real stdio smoke test · Sonnet, medium (Wave B, lane 3)

**Files:** new `test/smoke/stdio-smoke.test.ts` (separate vitest project, runs after
`npm run build`), new `test/smoke/mock-confluence.ts`, `.github/workflows/build.yml` and
`publish.yml` (one step each; W-SDK owns the rest of those files, so W-SMOKE's step is merged
after W-SDK).

1. **Recovery mode, offline:** spawn `node dist/cli/index.js` with `CONFLUENCE_PROFILE` naming a
   profile with no credentials (and a keychain shim env so CI's missing `secret-tool` does not
   change the path). 2025 era: `initialize` → `tools/list` contains exactly `setup_profile`.
   2026 era: `server/discover` → `tools/list` with capabilities in `_meta`, same result.
2. **Full server against a mock Confluence:** a local HTTP server on 127.0.0.1 answers
   `tenant_info`, the startup probes and a page read/write. Env-var credentials point at it.
   If the client insists on `https://` site URLs, the mock serves TLS with a generated
   self-signed certificate and the test sets `NODE_EXTRA_CA_CERTS`. Do **not** add a
   "test mode" env var that relaxes URL checks in the shipped bundle.
   - Both eras: `tools/list` equals the golden list, byte-identical across two calls.
   - Both eras: a gated write round trip. 2025: elicitation accepted by the client handler.
     2026: `input_required`, then retry with `inputResponses` → exactly one PUT at the mock.
   - Invalid arguments → `isError: true` (bundled zod instance identity check).
3. Local runs need local port binding; if the sandbox refuses, run the smoke in CI only and say
   so in the report.

**Done:** CI runs it on every push; the 1.x-era `agent-guide` check stays as a cheap first step.

### 6.5 W-SHAPES — raw shapes to `z.object` · Sonnet, medium (Wave C, sole owner of `index.ts`)

Mechanical, but the emitted JSON Schema is the client contract. Convert each `inputSchema` raw
shape to `z.object({...})` with the default (strip) unknown-key behaviour, so calls that sent an
unknown key keep working. Before/after: dump `tools/list` and diff; the only allowed changes are
`$schema`/draft markers named in S0 item 6. Any other difference is a bug. The golden file is
regenerated in the same commit and the diff goes in the PR body.

### 6.6 Wave D — reviews · test-critic, security-reviewer, Opus high

- `test-critic` on `gate-eras`, `pending-approvals`, `gate-no-mutation`, `stdio-smoke`.
- `security-reviewer` (omit `model`) on `git diff release/7.6.0...release/8.0.0` restricted to
  `elicitation.ts`, `pending-approvals.ts`, `confirmation-tokens.ts`, `batch-tokens.ts` and the
  gate call sites.
- Opus/high data-loss walk of every mutation path touched (house rule).
- Fixes by an Opus/high agent; full suite once more.

## 7. Release 8.1.0 workstreams (new tools)

Every write tool: annotations from `tool-meta.ts`, space allowlist (`checkSpaceAllowed`) on
**every** container involved, `writeBudget.consume()` after the gate, mutation-log record,
`invalidateForPage` and page-cache eviction, attribution where a version is created, `source:
chained_tool_output` handling as for existing destructive tools, outcome-unknown handling, and
contract C5. Each is absent in read-only posture and listed in `WRITE_TOOLS`.

### 7.1 W-MOVE — `move_page` · Opus, high (design + tests), Sonnet builds

**Scope.** Move a page within the **same space**: `position: "append" | "before" | "after"`,
`target_id`. Site mode: v1 `PUT content/{id}/move/{position}/{targetId}`. Gateway mode: v2
`PUT /pages/{id}` with a new `parentId` (append only; `before`/`after` refused with a clear
message).

**Design decisions** (from S-H4):
- Same space only: the target's space must equal the page's space, both allowed by the
  allowlist; cross-space moves are refused (Q10).
- Cycle check: refuse when the target is the page or one of its descendants (check the target's
  ancestors via v2 `/pages/{target}/ancestors`; do not rely on the API to refuse).
- **Exposure check:** compare effective restrictions before and after, using the v2
  restriction-state endpoint (new 2026-10-14) for the page's current parent and the new parent.
  If the move would widen or narrow who can view the page (inherited view restrictions differ),
  the gate prompt says so in counts-only text; without elicitation, soft token.
- Annotations: `destructiveTool("Move page", {requiresUserInteraction: true})`.
- Version: binding uses the page's current version; after the move, re-read and evict caches
  (does a move bump the version? verify live).

**Data-loss analysis:** a move loses no content but can (a) expose a restricted page —
exposure check plus gate; (b) break position-dependent macros (`children`, page trees) — stated
in the result; (c) race with a concurrent move or delete — re-read after the call and report
the observed parent, not the requested one; (d) duplicate titles cannot arise within one
space. Outcome unknown → `WriteOutcomeUnknownError` and "re-read the page's parent".

**Tests:** cycle refused with no PUT; cross-space refused; restriction change → gate fires;
same restrictions → still gated (destructive) but prompt states "no permission change";
`before`/`after` refused in gateway mode; observed parent reported.

**Live:** read-only checks only (ancestors and restriction-state for two pages). A real move
only if the user permits it for that run, inside the personal space, moving a scratch page and
moving it back.

### 7.2 W-DELATT — `delete_attachment` (trash only) · Sonnet, high

**Scope.** v2 `DELETE /attachments/{id}` without `purge`. Input: `page_id` plus `attachment_id`
or `filename` (exact, case-sensitive, via W-V2READ's lookup; ambiguity refused).

**Design (S-M8):** container fail-closed (the attachment's container id must equal `page_id`, and
that container's space must pass the allowlist; a lookup failure refuses); the page body is
scanned for references to the filename (`ri:attachment ri:filename`, draw.io `diagramName`);
references found → the prompt says "N references on this page will break" (counts only);
gate always (destructive, `requiresUserInteraction`); the result says that restoring from the
trash needs a space admin.

**Data-loss analysis:** wrong file (exact lookup, id-container check); a diagram whose preview
`.png` sibling stays and shows stale content (reported, not deleted); the `purge` parameter is
never sent (a test inspects the URL); deleting an attachment referenced from **other** pages is
not detectable cheaply — stated in the description.

**Tests:** container mismatch → no DELETE; `purge` absent from every DELETE URL; reference count
in the prompt; filename with two exact matches → refused.

**Live:** `get_attachments` on a page; no deletion unless permitted for that run in the personal
space.

### 7.3 W-STRUCT — `insert_section`, `rename_heading` · Opus, high

**Scope (T3, S-M11):** `insert_section` with `after_heading` or `before_heading`, `level`,
`heading`, `body`; `rename_heading` with `heading`, `new_heading`. Both go through
`safeSubmitPage`, reuse `locateSectionRange`, and keep the bytes outside the edited range
byte-identical (prefix/suffix equality asserted before submit).

**Design:** `after_heading` inserts at the end of that heading's section (including its
sub-sections), never inside a sub-section; the inserted level may not take over following
headings (a level-2 insert before a level-3 run is refused unless the caller passes
`after_heading` of a same-or-higher level); headings are escaped and fence-checked; duplicate
heading text → ambiguity error (no disambiguation syntax yet); `rename_heading` edits the
heading's text only, tokenised so macros inside the heading survive; the rename warns that
anchor links to the old heading text break (counts of `ac:anchor`/`#` links found on the page).

**Data-loss analysis:** the guards of body mode apply (`enforceContentSafetyGuards`), plus the
prefix/suffix equality check, which catches any splice error; concurrent edits produce 409
(version-bound); placeholders are rejected in `heading`.

**Tests:** property (fast-check): for random pages built from a heading grammar, the bytes
outside the insertion point are unchanged and the heading count grows by one; insertion
between CDATA-containing macros; rename of a heading containing a status macro keeps the macro.

### 7.4 W-READS — `get_page` `grep`, folder reads, `get_tasks`, R2 memo · Sonnet, medium

- `grep` (T2): literal, case-sensitive by default; returns each matching block element (p, li,
  tr, heading) with its heading path and storage, fenced, capped at 50 matches and the
  existing max-length cap (S-L4). Works for pages and blog posts.
- Folder reads: `get_page_children` already lists folders through `/direct-children` (7.5.0);
  add `get_folder` (v2 `/folders/{id}`: title, parent, space) and make `get_page`/children
  output name folders as folders.
- `get_tasks` (read only): v2 `/tasks` filtered by page id, space id, status or assignee; fenced
  task text; `read_spaces` applies.
- R2: memoise "attribution label present" per page and process; invalidated on any label
  write and on outcome-unknown. Badge memo stays dropped (S-M5).

### 7.5 W-META-8.1 · Sonnet, high (after I-8.1)

Annotation table rows for the new tools in `tool-meta.test.ts`; golden tool list and
description lengths (≤ 1,800 chars after wrappers); `KNOWN_TOOLS`, `WRITE_TOOLS`,
`READ_ONLY_TOOLS`, `src/cli/setup.ts` `TOOLS`, `install-agent.md` table and count; gateway
capability rows for each new tool.

## 8. File ownership by wave

| Wave | Workstream | Owns (only this lane edits it during the wave) |
|---|---|---|
| A | W-INV | `scripts/live/`, the new investigation doc |
| A | W-V2READ/W-HIST | `confluence-client.ts` lines ~2160–2900 (attachments, versions, labels read), new read tests |
| A | W-GW | `confluence-client.ts` lines ~1–520 and `resolveDownloadUrl`, `keychain.ts`, `test-connection.ts`, `setup.ts`, `status.ts`, `api-capabilities.ts`, `request-policy.ts` |
| A | S0/W-GATE-SPEC | throwaway worktree; `doc/design/security/07-confirmation-mrtr.md` |
| B | W-SDK | `package*.json`, `esbuild.config.mjs`, workflows, `index.ts` top (imports, utilities ≤ line 220, wrapper ~1080–1100, `main`, recovery server), `update-check.ts`, `upgrade.ts` |
| B | W-GATE | `elicitation.ts`, `pending-approvals.ts`, `confirmation-tokens.ts`, `batch-tokens.ts`, the nine gate call sites in `index.ts` |
| B | W-SMOKE | `test/smoke/`, one step per workflow (merged after W-SDK) |
| C | W-SHAPES | all of `index.ts` |
| E | each 8.1.0 lane | its `src/server/tools/<tool>.ts` and tests; `index.ts` only for one import and one call |

`CHANGELOG.md`, README and `doc/` are edited only by the docs workstream of each release.

## 9. Model, effort and concurrency

| Task | Model | Effort |
|---|---|---|
| S0 spike, W-GATE-SPEC, W-GATE, W-MOVE design, W-STRUCT, integration of guard-code conflicts, data-loss walks, review fixes | Opus | high |
| W-GW design (decisions 1–5, origin pinning) | Opus | high |
| W-GW build, W-V2READ/W-HIST, W-SDK, W-DELATT, W-META-8.1 | Sonnet | high |
| W-INV, W-SMOKE, W-SHAPES, W-READS, user docs | Sonnet | medium |
| CHANGELOG entries, doc link fixes, investigation status lines | Haiku | low |
| Gate review | `security-reviewer` (no `model` override) | – |
| Test critique | `test-critic` | – |

Rules for every agent (as in the field-session plan §7): own worktree off the release branch,
local commits only; one test run at a time, `npx vitest run --maxWorkers=2 <files>`; never the
full suite (the orchestrator runs it); ≤ 4 test-running agents at once; the orchestrator runs
the load/memory watchdog during each wave. No live tenant calls except where a workstream says
"live", and then read-only against the designated test profile. Never push, tag or publish.
Fixtures use `example.com`, space keys like `DOCS`/`TEAM`, numeric ids. Remove worktrees when
each lane is merged.

## 10. Release checkpoints (human)

For each release: fast-forward the release branch into the default branch locally; the user
pushes and runs `gh release create` (the egress guard will ask); install from npm and check
`epimethian-mcp --version` and `status`; re-check Dependabot and code-scanning alerts.

8.0.0 extras: create a `release/7.x` maintenance branch at the 7.6.0 tag first. It receives
security fixes until the SDK 1.x end of fixes (~2027-01-27). The CHANGELOG `Breaking` section
lists: Node floor, SDK package rename (only relevant to people embedding the server), `$schema`
2020-12 in `tools/list`, and any tool-surface change found by W-SHAPES.

## 11. Open questions for the user

**Decided 2026-11-22:**

- Q1: three releases, 7.6.0 → 8.0.0 → 8.1.0, as in §1.
- Q2: the user creates a scoped, read-only, short-expiry token for the designated test profile;
  gateway mode is live-verified with read-only calls before 7.6.0 ships.
- Q3: tools that cannot work in gateway mode are left out of `tools/list`.
- Q4: in gateway mode, writes proceed and simply omit the unverified badge and attribution
  label. No opt-in flag and no per-write warning. The version comment (Epimethian version and
  repo link) is still written, so provenance stays in the page history.

Questions 6–12 are still open: 6–8 and 12 before 8.0.0, 9–11 before 8.1.0. Q5 is built to
the recommendation (expiry asked at setup, shown in `status` and the banner, not in
`get_version` / `check_permissions`) unless the user decides otherwise.

**W-INV live runs.** The standing rules for the designated test profile allow only small,
hand-run, read-only checks, and no subagent calls it. W-INV therefore builds and tests the
probe script against stubbed `fetch` only; the user runs it by hand (or allows one run per
invocation). Until its results are in, the conservative defaults apply: `revert_page` stays
on v1 in site mode, `probeWriteCapability` keeps its v1 call in site mode, and every
gateway-table row marked "to be confirmed" is treated as unavailable.

1. **Release split.** 7.6.0 (v2 API + gateway mode) → 8.0.0 (SDK v2 + MRTR gate) → 8.1.0 (new
   tools). Agree, or fold 7.6.0 into 8.0.0?
2. **Scoped test token.** Gateway mode can only be verified with a scoped, **read-only** API
   token for the designated test profile (short expiry). Will you create one? Without it,
   gateway mode ships marked "not live-verified".
3. **Unavailable tools in gateway mode:** leave them out of `tools/list` (recommended: the agent
   never sees a tool it cannot use) or register them and return a fixed error?
4. **No unverified badge or attribution label in gateway mode.** Accept with banner and result
   warnings, or refuse writes in gateway mode unless the profile opts in
   (`allow_unbadged_writes: true`)?
5. **Token expiry.** Ask for the expiry date at setup and show it in `status` and the banner
   (recommended). Also in `get_version` / `check_permissions` output?
6. **Node floor for 8.0.0:** `>=20` (the SDK's floor; Node 20 is already end-of-life) or
   `>=22` (recommended: maintenance LTS until 2027-04; CI tests 22 and 24)?
7. **MRTR mismatch behaviour:** re-prompt when the page changed or the arguments differ
   between the two legs (recommended), or fail with an error and make the agent start over?
8. **2026-era live check.** Is there a client you use that speaks 2026-07-28 today? If not,
   is the SDK-client e2e against the mock acceptable as the release gate for that era?
9. **Deferrals:** copy, archive, templates, task writes and export are out of 8.1.0 (§1).
   Agree?
10. **`move_page` scope:** same space only, with the restriction comparison. Cross-space moves
    later or never?
11. **`delete_attachment` with references on the page:** confirm and proceed (recommended), or
    refuse outright?
12. **Raw shapes → `z.object` in 8.0.0** (recommended, while the release is breaking anyway), or
    leave the deprecated form until the SDK removes it?

## 12. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| v2 historical read differs from v1 → `revert_page` writes the wrong body | Version assertion, 30-version parity gate, revert stays v1 in site mode until parity | Patch release putting reads back on v1 in site mode (the v1 functions stay in the tree for 7.5.x) |
| v1 disappears on the site URL before 7.6.0 ships | 7.5.0's clear 410 error; inventory tells users which tools are affected | Ship W-V2READ alone as 7.5.x if needed |
| Gateway mode sends a credential off-tenant | Prefix pinning on every request, cursor and redirect; sealed cloudId only | Gateway mode is opt-in; a patch can refuse to start in it |
| A gate bypass in the MRTR rewrite | Spec reviewed before code; matrix + property tests; security review; C5 test | `release/7.x` stays on the 1.x gate; users pin `@7` |
| Bundle crash from a second zod or SDK instance | Smoke test on the built bundle in CI and before publish | Do not publish; the publish workflow runs the smoke |
| Node 18 users upgrade into a crash | `upgrade` refuses across the floor; no auto-upgrade across majors; `engines` set | `npm i -g @de-otio/epimethian-mcp@7` |
| Clients reject `$schema` 2020-12 | W-SHAPES diff; live `tools/list` in Claude Code before release | Patch that strips `$schema` from emitted schemas, if the SDK allows |
| SDK 2.x behaviour changes in a minor | Pin the exact 2.4.x; Dependabot PRs run the smoke | Pin back |
| New tools widen exposure (`move_page`) | Same space, restriction comparison, always gated, `requiresUserInteraction` | Profile tool denylist; patch removes the tool |
