# Gateway mode (7.6.0, W-GW build brief)

Status: built on `ws/760-gw` (decisions in §9). Do not release before the W-V2READ and W-HIST lanes land (see §8, last item). Plan: [next-release-sdk2-and-v2-api.md](../../plans/next-release-sdk2-and-v2-api.md)
§4, §5.3, §5.4, §11. Line numbers are as of the contracts commit on `release/7.6.0`.

## 1. What already exists (do not re-create)

| Piece | Where |
|---|---|
| `Config.apiMode`, `apiV2`, `apiV1: string \| null` | `src/server/confluence-client.ts:88-98` (field docs inline) |
| `getConfig()` spreads `buildApiBases({ url, apiMode: "site" })` | `confluence-client.ts:274-275` |
| `requestBaseFor`, `buildApiBases`, `GATEWAY_ORIGIN`, `requireV1(cfg, feature)`, `FeatureUnavailableInGatewayMode` (`.feature`) | `src/server/api-base.ts` |
| `Feature`, `FEATURES`, `capabilitiesFor(mode)` (static, frozen) | `src/server/api-capabilities.ts` |
| Every v1 call site goes through `requireV1` with its feature | `confluence-client.ts` (grep `requireV1(`) |

Rule (C1): no API URL is built from `cfg.url`. The only reads of `cfg.url` left in the client
are cache keys (`:1359`, `:2957`) and human links (`:2281-2286`, `:3911-3914`). Human links
must never take `_links.base` from a response in gateway mode: `searchPagesByTitle` (`:2281`)
and the page-link builder (`:3911`) do today; build them from `cfg.url` when
`apiMode === "gateway"`.

## 2. Keychain record

`KeychainCredentials` (`src/shared/keychain.ts:28-36`) gains `apiMode?: "gateway"` (absent =
site; never write `"site"`) and `tokenExpiry?: string` (`YYYY-MM-DD`, as shown at token creation).

- **Read:** `readFromKeychain` (`keychain.ts:184-195`) copies only known fields. Add both, with
  validation: `apiMode` kept only if exactly `"gateway"`; `tokenExpiry` kept only if it matches
  `/^\d{4}-\d{2}-\d{2}$/` and is a real calendar date. Anything else is dropped (same policy as
  `cloudId`). **Data loss:** the opportunistic seal re-saves `{ ...stored, cloudId }`
  (`confluence-client.ts:557-570`); if `readFromKeychain` does not parse the new fields, that
  re-save erases them. Test it.
- **Invariant:** `apiMode: "gateway"` is only ever written together with `cloudId`. Enforce in
  one pure helper `buildKeychainRecord(input)` in `keychain.ts` that throws when
  `apiMode === "gateway" && !cloudId`; `setup.ts` calls it instead of the inline literal at
  `src/cli/setup.ts:230-239`.
- **Into Config:** `resolveCredentials` (`confluence-client.ts:154-219`, profile branch
  `:175-186`) returns `apiMode` and `tokenExpiry`; `getConfig` passes
  `{ url, apiMode, sealedCloudId }` to `buildApiBases` and adds `tokenExpiry?: string` to
  `Config`. A keychain record with `apiMode: "gateway"` and no `cloudId` is a startup error
  (`requestBaseFor` already throws). Env-var mode (`CONFLUENCE_URL` …) stays site mode only.

## 3. Setup (`src/cli/setup.ts`, `runSetup` at `:80`; order changes: a scoped token fails on the site URL)

1. URL, email, token as today (`:121-173`).
2. New prompt: `Is this a scoped API token? [y/N]`. `n` → today's flow, unchanged.
3. Gateway: `fetchTenantInfo` (`src/shared/test-connection.ts:66`) **before** any credentialed
   call, then the tenant confirmation (`setup.ts:201-219`). No cloudId → abort, save nothing.
4. `testConnection` against the gateway base: change its signature to
   `testConnection(baseUrl, email, apiToken)` where callers pass `requestBaseFor(...)`
   (today it appends `/wiki/api/v2/spaces?limit=1` to the site URL, `test-connection.ts:117`).
5. Optional prompt `Token expiry date (YYYY-MM-DD, blank to skip):`; validate as in §2.
6. Print the scope list for the chosen posture (plan §5.3 item 7) from one exported constant
   `GATEWAY_SCOPES: Record<"read-only" | "read-write", readonly string[]>` in
   `src/shared/gateway-scopes.ts`, reused by `doc/user-doc`.
7. **Scope probe** (R4: one call must pass, one must fail), after the posture prompt
   (`setup.ts:243+`): spaces read must pass (step 4); for posture `read-only`, the dry-run
   `PUT {apiV2}/pages/999999999999` (same probe as `confluence-client.ts:355`) must answer
   403. Anything else → warn "token is broader than the read-only posture". Put the
   classification in a pure `classifyScopeProbe(status): "narrow" | "broad" | "inconclusive"`.
8. Save via `buildKeychainRecord` with `apiMode: "gateway"`, `cloudId`, `tokenExpiry`.

## 4. Startup (`validateStartup`, `confluence-client.ts:389`; gateway branch in this order, site unchanged)

1. Expiry: `tokenExpiryState(expiry, today)` (pure, §7) → `expired` is a startup error naming
   the date and `epimethian-mcp setup --profile <p>`; exit 1 before any request.
2. Seal: `fetchTenantInfo` on the site URL must return `sealedCloudId` (reuse
   `verifyOrSealTenant`, `:497`; the opportunistic-seal branch is unreachable because gateway
   requires a seal). Mismatch or unreachable → exit 1 (already fail-closed, `:503-521`, `:537-550`).
3. `GET {apiV2}/spaces?limit=1` via `testConnection(requestBaseFor(cfg), …)`. A 401 message
   names "scoped token expired, revoked, or missing a scope", not the generic hint (`:401-410`).
4. Skip `verifyTenantIdentity` (`:413`): it calls v1 `/user/current`, gone on the gateway.
   The seal (step 2) is the tenant guard in gateway mode; say so in the banner.
5. Posture probe: `probeWriteCapability` (`:305`) already degrades — `requireV1` throws inside
   the outer `try`, so it falls through to the v2 dry-run. No change needed; add a test.

## 5. Origin + prefix pinning

The only credentialed prefix in gateway mode is
`https://api.atlassian.com/ex/confluence/{sealedCloudId}/` (= `requestBaseFor(cfg) + "/"`).
Add one pure predicate to `api-base.ts`: `isCredentialedUrl(url: string, requestBase: string): boolean`
(site: same origin, today's rule; gateway: same origin AND pathname starts with
`new URL(requestBase).pathname + "/"`). Apply it at three places:
- **Requests:** `sendGuarded` (`confluence-client.ts:1177`) / `confluenceFetch` (`:1234`): refuse,
  without sending, any URL that fails the predicate (belt and braces; all bases come from C1).
- **Pagination cursors:** `resolveSearchNext` (`:2034`) keeps only the origin today and
  prefixes `/wiki`. Make it prefix-aware: resolve `next` against `requestBase`, then require
  `isCredentialedUrl`. W-V2READ's attachment cursors use the same helper (plan §5.2 tests).
- **Download redirects:** `downloadAttachmentBytes` (`:2602`) latches `credentialed` on
  `next.origin === siteOrigin` (`:2650`). In gateway mode replace that comparison with
  `isCredentialedUrl(next, requestBase)`; `resolveDownloadUrl` (`:2571`) must refuse an
  absolute link that fails the predicate. Download stays capability `false` until W-INV finds a
  gateway download path, so the tool is hidden anyway.

Tests: gateway prefix with another cloudId → refused; `https://api.atlassian.com/` without the
prefix → refused; `…/ex/confluence/{id}x/…` (prefix without the slash) → refused.

## 6. Tool surface and side writes

- **Hidden, not erroring** (Q3 decided). In `registerTools` (`src/server/index.ts:1121`) the
  `registerTool` shim (`:1171-1183`) gains one check before the posture gate:
  `if (!toolAvailableIn(config.apiMode, name)) return server;`. `toolAvailableIn` lives in
  `api-capabilities.ts` with a static `TOOL_FEATURES: Record<string, readonly Feature[]>`
  (a tool is available iff all its features are). Gateway-hidden tools today: `add_attachment`,
  `add_drawio_diagram`, `update_drawio_diagram` (attachments.upload), `download_attachment`
  (attachments.download — overrides `ALWAYS_ON_TOOLS`, `:837`), `add_label`, `remove_label`,
  `get_page_status`, `set_page_status`, `remove_page_status`, `search_pages`,
  `resolve_page_link` (search.cql), `get_recent_changes`, `lookup_user`. A test pins this list and
  that `tools/list` is byte-identical across two calls.
- **Instructions:** `buildServerInstructions` (`index.ts:1104`) takes `apiMode` and the hidden
  list; gateway adds one line: "Gateway mode (scoped API token): these tools are unavailable: …".
  Call site `index.ts:6355`.
- **Attribution label and unverified badge** (Q4 decided: silent). At the top of
  `ensureAttributionLabel` (`confluence-client.ts:2842`) and of `markPageUnverified`
  (`src/server/provenance.ts:128`, after the `unverifiedStatus === false` bail-out at `:134`):
  `if (!capabilitiesFor(cfg.apiMode)["attribution.label"]) return {};` (resp. `unverifiedBadge`).
  Return `{}` — no `warning`, so no per-write warning reaches `appendWarnings`. The version
  comment (`buildVersionMessage`, `confluence-client.ts:1703`) is untouched. Test (e.g. call site
  `index.ts:1403-1405`): a gateway `update_page` makes no `/wiki/rest/api/` request and its PUT
  body carries the version message.
- **Badge locale:** `getSiteDefaultLocale` (`:2956`) already returns `undefined` when
  `requireV1` throws (inside its `try`), so `pickLocale` falls back to `"en"`.

## 7. Token expiry

Pure helper in `src/shared/token-expiry.ts`:
```ts
export type ExpiryState = { kind: "none" } | { kind: "ok" | "soon"; daysLeft: number } | { kind: "expired"; daysLeft: number };
export function tokenExpiryState(expiry: string | undefined, today: string /* YYYY-MM-DD */): ExpiryState;
// daysLeft = whole UTC days from today to expiry. soon: 0 ≤ daysLeft ≤ 14. expired: daysLeft < 0.
```

- `status` (`src/cli/status.ts:23`, after `URL:`/`Email:` at `:71-73`): `Mode:` line
  (`site` / `gateway (scoped token)`) and `Token expires: YYYY-MM-DD (N days left)`, or
  `EXPIRED on …`. For gateway records, `testConnection` must use the gateway base (`:76`).
- Stderr banner: one line after the connection banner (`confluence-client.ts:468-470`) when
  `soon`; `expired` is the §4 step-1 startup error. Day 0 is `soon`, not expired.
- **Not** in `get_version` (`index.ts:6149`) or `check_permissions` (`index.ts:3787`) (Q5).
- Tests (frozen `today`): 15 → ok, 14 → soon, 0 → soon, −1 → expired; malformed → none.

## 8. Open points found while landing the contracts

- `fetchTenantInfo` sends Basic auth (`test-connection.ts:86-91`); plan §5.3 item 3 says
  unauthenticated. In gateway mode call it without `Authorization` (add an option).
- No v2 equivalent of the email identity check (§4 step 4); the plan does not mention dropping it.
- `resolve_page_link` uses v1 CQL (`searchPagesByTitle`) but is missing from the §5.3 table.
- The v1 `/user/current` caller is `verifyTenantIdentity` (`test-connection.ts:6`);
  `testConnection` is already v2 (§5.4's last row names the wrong function).
- Row 2's gateway `true` values assume W-V2READ/W-HIST land; until then those functions call
  `requireV1` and would throw. Do not switch gateway mode on before both.

## 9. Decisions taken in the build

1. **Tenant identity in gateway mode.** The v1 `/user/current` email check
   (`verifyTenantIdentity`) cannot run: the gateway does not serve v1. It is replaced by
   two checks, in this order: (a) `GET {site}/_edge/tenant_info` must return the sealed
   `cloudId` (fail closed on a mismatch or an unreachable endpoint, as in site mode);
   (b) `GET {gateway}/wiki/api/v2/spaces?limit=1` must succeed. **Why this is enough:** a
   request can only reach tenant T if three things all point at T: the gateway prefix is
   built from the sealed `cloudId` and from nothing else (no URL, no response field; every
   outgoing and followed URL must pass `isCredentialedUrl`), the site URL still resolves
   to that same `cloudId` at every start, and the scoped token is bound by Atlassian to one
   site, so the gateway refuses it for any other. The email check only proved that a
   credential matched a user on a host; it never bound the host to a tenant, which the
   seal does. A mismatch between any two of the three fails startup before a write tool is
   registered. The startup banner says the email check is skipped and why.
2. **tenant_info is unauthenticated in gateway mode.** `fetchTenantInfo(url, email, token,
   { authenticated: false })` sends no `Authorization` header: a scoped token must never be
   sent to the site origin, which does not serve it. Site mode still sends Basic auth, as
   before. Setup uses the same call, so the seal is read and confirmed before any
   credentialed request.
3. **Refusal to start without a seal.** `getConfig()` exits with a message naming
   `epimethian-mcp setup --profile <p>` for a gateway record without a `cloudId` (or with a
   malformed one). `buildKeychainRecord` and `saveToKeychain` both refuse to write
   `apiMode: "gateway"` without a `cloudId`.
4. **Hidden tools, silent side writes** (Q3/Q4 as decided). `TOOL_FEATURES` in
   `api-capabilities.ts` maps every tool to the features its core call needs, including
   every step of a multi-step write; a test pins its keys to `KNOWN_TOOLS`, and an unmapped
   tool is unavailable in gateway mode. The attribution label and unverified badge return
   `{}` without a request or a warning; the version comment is unchanged.
5. **Expiry** lives in the keychain record, is shown by `status`, warned at
   14 days or fewer on the stderr banner (day 0 included), and is a startup error once past.
   It is not in `get_version` or `check_permissions` (Q5).
6. **Setup order.** The "scoped token?" question comes after the email. The gateway flow
   reads the seal unauthenticated, has the user confirm it, tests through the gateway,
   asks for expiry and posture, prints the scope list, runs the scope probe (read-only
   posture: the dry-run write must be refused), then saves mode, `cloudId` and expiry in
   one `buildKeychainRecord` call. A gateway profile needs `--profile`.
7. **Keychain round-trip.** `parseKeychainRecord` (pure, in `keychain.ts`) copies every
   field a record can hold, so the opportunistic seal re-save cannot erase `apiMode` or
   `tokenExpiry`.

### Open points for the live scoped-token check

- The scope list in `src/shared/gateway-scopes.ts` and `doc/user-doc/installation.md` is
  unconfirmed.
- Whether `tenant_info` and the v2 `spaces` call behave as assumed with a scoped token,
  including the exact status for a missing scope (401 vs 403).
- Whether the dry-run `PUT /pages/999999999999` answers 403 for a read-only token on the
  gateway (the setup scope probe relies on it).
- Whether `_links.next` on v2 lists carries the `/ex/confluence/{cloudId}` prefix or not
  (`resolveNextLink` accepts both).
- A gateway download path for attachments (`attachments.download` stays `false`).
