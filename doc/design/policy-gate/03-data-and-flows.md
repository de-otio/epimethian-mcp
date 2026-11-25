# 3. Data and flows

Status: design, reviewed 2026-11-25. Step 0 (7.6.1) built; steps A and B not built.

## 1. Profile settings: schema additions

No new scope setting (decision 7). New values go in one strict `policy` block (decision 8;
how the two coexist and how step D takes them over: [04 D21](04-decisions.md#d21-scope-in-read_spaces-new-values-in-policy)).

```jsonc
// ~/.config/epimethian-mcp/profiles.json
{
  "profiles": ["work"],
  "settings": {
    "work": {
      "posture": "read-write",
      "read_spaces": ["DEV", "DOCS", "~*", "!~a1b2c3"],
      "read_spaces_enforced": true,
      "spaces": ["DEV"],
      "policy": { "read_budget": { "pages": 100, "window_minutes": 60 } }   // step B
    }
  }
}
```

zod changes in `src/server/config.ts` (CLI-side validation; `projectPolicy` is the only runtime
validator, S13):

```ts
// readScopeShape.read_spaces (:10-19): element narrowed to the key charset plus the two patterns.
read_spaces: z.array(
  z.string().max(256).refine(isSpaceEntry, "must be a space key, ~* or !KEY"),   // SPACE_KEY_RE, "~*", "!"+SPACE_KEY_RE
).max(100).superRefine(spaceEntriesConsistent).optional(),   // parseSpaceEntries rules, 02 §2.1

// ProfileSettingsValidator (:30-46)
policy: policyBlockSchema.optional(),                       // 02 §2.2, z.strictObject
```

| Setting | Meaning after this design |
|---|---|
| `read_spaces` | Entries `KEY`, `~*`, `!KEY`. Without `read_spaces_enforced`: search default, as today. `[]` with enforcement: no read is allowed (mirrors `spaces: []`). |
| `read_spaces_enforced: true` | The read boundary for every read tool and a ceiling for writes (D15). Without `read_spaces`: `invalid-settings` → recovery mode, fix `epimethian-mcp policy setup --profile <p>` (today: search refuses; Changed entry). |
| `spaces` | Write allowlist, unchanged semantics; re-read on change (D18). |
| `policy.read_budget` | `{pages, window_minutes}`; absent = no budget. |
| `redact_patterns` | Unchanged semantics; re-read on change (D18). |

Validation happens in `projectPolicy` for the **active** profile only (looked up with
`Object.hasOwn`) and covers the keys the gate uses. Another profile's broken settings do not
affect this server. For a profile that enforces (the file says `read_spaces_enforced: true` or
the anchor says enforced), a failure is `unreadable` with `invalid-settings` (setting path and
indexes only, never a value or a file-supplied key name): recovery mode at startup, deny
mid-session. For any other profile the invalid entry is dropped, listed in
`EffectivePolicy.ignored`, reported on stderr at startup and by `policy` (D28). A key outside
the charset that was accepted before (`src/server/config.ts:17` allowed anything but control
characters) is now invalid on an enforcing profile (Changed entry names it).

Keychain anchor: a separate item, account `policy-anchor/<profile>` (02 §1.2, D26). It is read at
startup next to the credentials and passed to `projectPolicy` as `AnchorState`.

## 2. Read-log records (step B)

The zod schemas in `src/server/read-log.ts` are the spec. The writer validates with the strict
schemas; `log` reads with the loose variants, so a record from a newer version is counted as
newer, not as a gap (S23).

```ts
const base = {
  v: z.literal(1),
  ts: z.iso.datetime(),                            // UTC, from the injected clock
  session: z.string().regex(/^[0-9a-f]{16}$/),     // random per process
  seq: z.number().int().nonnegative(),             // monotonic per file
  profile: z.string(),
};

export const readRecordSchema = z.strictObject({
  ...base, kind: z.literal("read"),
  client: z.string().max(80).nullable(),           // from the handler ctx, control characters stripped
  apiMode: z.enum(["site", "gateway"]),
  tool: z.enum(KNOWN_TOOLS),
  class: z.enum(["content-read", "listing", "exempt"]),
  decision: z.enum(["allow", "deny", "error"]),
  code: z.string(),                                // AllowCode | DenyCode | "NOT_FOUND" | "API_ERROR"
  rule: z.string().optional(),                     // RuleId
  contentId: z.string().regex(/^\d+$/).optional(), // page or blog post; container for attachments/comments
  subjectId: z.string().regex(/^(att)?\d+$/).optional(),  // attachment or comment id the call named
  contentType: z.enum(["page", "blogpost", "attachment", "comment"]).optional(),
  version: z.number().int().positive().optional(),
  spaceKey: z.string().optional(),                 // resolver-derived only
  spaces: z.array(z.string()).max(100).optional(), // listings: distinct released spaces
  contentIds: z.array(z.string().regex(/^\d+$/)).max(100).optional(),   // listings: released content ids, first 100 (D33)
  moreContentIds: z.number().int().positive().optional(),               // listings: released ids beyond the first 100
  items: z.number().int().nonnegative().optional(),
  withheld: z.number().int().nonnegative().optional(),   // listings: never shown to the agent
  bytes: z.number().int().nonnegative().optional(),
  budget: z.strictObject({ used: z.number().int(), cap: z.number().int(), counted: z.boolean() }).optional(),
  policyHash: z.string().regex(/^[0-9a-f]{16}$/),
  droppedBefore: z.number().int().positive().optional(),
});

export const policyRecordSchema = z.strictObject({
  ...base, kind: z.literal("policy"),
  event: z.enum(["session_start", "changed", "unreadable", "readable", "anchor_mismatch", "capped", "session_end"]),
  policyHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  previousHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  anchorHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),   // hashPolicy of the anchor's content
  startupHash: z.string().regex(/^[0-9a-f]{16}$/),  // posture + tool lists at process start
  pid: z.number().int().positive(),
  version: z.string(),                               // package version
  reason: z.string().optional(),                     // UnreadableReason kind
  extraGets: z.number().int().nonnegative().optional(),   // session_end: Confluence GETs the gate added
  droppedBefore: z.number().int().positive().optional(),
});
```

Never recorded: titles, CQL, search terms, excerpts, bodies, display names, account IDs (as
such), e-mail addresses, file names, output paths, `redact_patterns` values, error messages
from Confluence. Personal space keys (`~…`) can contain an account ID; they are recorded like
any space key in this local file (stated in `05-observability.md`) and never shown to the agent.

Exempt tools are recorded only on deny, except `lookup_user`, whose allows are recorded too
(tool, decision, code; no query, D27). Write-class calls are not recorded in the read log (the
mutation log covers writes). A write refused by the gate before its handler appears in the
profile audit log in step A (deny line) and in neither JSONL log in step B; see
[05 Q8](05-risks-and-open-questions.md).

## 3. Files

| File | Location | Mode | Written by | Rotation |
|---|---|---|---|---|
| Profile registry | `~/.config/epimethian-mcp/profiles.json` (`src/shared/profiles.ts:69`) | file 0600, owned by the user, dir 0700 | CLI only, through `writeWithAnchor` | none |
| Registry lock | `~/.config/epimethian-mcp/profiles.json.lock` | 0600, `O_EXCL` | CLI writers, for the length of one write | removed in `finally`; stale after 60 s with a dead pid |
| Registry temp | `~/.config/epimethian-mcp/.profiles.json.<hex>.tmp` | 0600, `O_EXCL\|O_NOFOLLOW` | CLI writers | removed on failure; older than 1 h swept by the next writer |
| Registry backup | `~/.config/epimethian-mcp/profiles.json.bak` | 0600, fsynced | CLI, before each write of a readable file: its bytes (the version before the last CLI change) | replaced on each write; never touched when the registry is absent (D36) |
| Policy anchor | OS keychain, service as the credentials, account `policy-anchor/<profile>` | keychain | `writeWithAnchor` (kind `policy`); cleared by it and by `profiles --remove` | – |
| Profile audit log | `~/.config/epimethian-mcp/audit.log` (`:70`) | `safeOpenAppend`, O_NOFOLLOW | CLI policy edits (old and new fingerprint); step A server: policy changes and deny lines (code, tool, ID or key, profile), at most 1,000 deny lines per process, then one `further denies suppressed` line | none (unchanged) |
| Read log | `~/.epimethian/logs/reads-<startISO>-<pid>-<session8>.jsonl` | dir 0700 (`verifyDirChain`), file 0600 checked by `fstat`, `O_EXCL\|O_APPEND\|O_NOFOLLOW` only (no fallback), `writeSync` | server, step B | one file per process, capped at 10 MB (then one `capped` record, `EFBIG`); files older than 90 days swept at open, prefix `reads-` only; `log --purge-older-than <days>` |
| Mutation log | `~/.epimethian/logs/mutations-<startISO>.jsonl` | unchanged (keeps its fallback open) | unchanged | sweep prefix `mutations-` only |

- The read log is opened lazily on the first record while `state` is `on`, and at startup
  whenever an anchor exists (so `session_start` is always written for an anchored profile). A
  profile without a policy and without an anchor creates no file (rule 2). There is no switch
  to turn it off (D10).
- Each sweep deletes only its own prefix (today's filter at `src/server/mutation-log.ts:146`
  becomes the parameter) and ignores `ENOENT` (two processes sweeping).
- The sweep runs only when a server opens a log. Copies in exports, backups or synced home
  directories are outside it (DOC-6).
- Volume: about 350 bytes per record (listing records with 100 content IDs about 2.5 KB);
  10,000 reads a day is about 3.5 MB a day. The 10 MB cap bounds one session; the 90-day sweep
  bounds the directory (worst case about 300 MB at that rate).

## 4. Target resolution (`resolveTarget`, GET only)

Every call goes through the Confluence client's existing 429, backoff and timeout handling.

| Target | Resolution | Cache | Failure |
|---|---|---|---|
| `content` | `resolveContentSpace(id)` (`src/server/space-allowlist.ts:121`): page, then blog post, then draft blog post; space from `space.key`+`type` or `getSpaceById(spaceId)` | 5 min per content id (successes only, seeded by handlers, capped at 10,000); space id → `{key, type}` per process | 404 → `notFound` (60 s negative cache); no space → `unresolvable/no-space`; resolved key failing `SPACE_KEY_RE` → `unresolvable/no-space`; network, auth, 429 after retries, 5xx → `apiError` |
| `contents` | `getContentSpaces(ids)` in batches of 250 (v2 `GET /pages?id=…`, then `/blogposts?id=…` for the rest); spaces via `getSpaceById` | same | any id missing → that id's failure |
| `space` | `findSpaceByKey(arg)` → `{id, key, type}`; the decision uses the response key and type | key → space per process; unknown keys 60 s | not found → `unresolvable/unknown-key` (with `argKey` for the case hint) |
| `spaces` | each as `space` | same | any failure → that failure |
| `comment` | `getCommentContainerId(id, type)` (`:3921`) → `content`; `subjectId` = comment id | content cache | no container → `unresolvable/no-space` |
| `attachment` | `getAttachmentMetadata(id)` (`:2932`) → `pageId ?? blogPostId` → `content`; `contentId` = container, `subjectId` = attachment id; only `customContentId` → `unresolvable/custom-content`. The metadata response seeds the container cache, so the handler's own metadata fetch is the only repeat | attachment → container, 5 min, in `gate.ts` | as `content` |
| `all` (allOf) | each part; `none` parts dropped; the first failure wins; every space must pass | – | – |
| `deferred`, `all-spaces`, `none`, `malformed` | none | – | – |

Content IDs are normalised (leading zeros removed) before any cache or ledger key is built.
Caches seeded by handlers store the space type in its own field (`seed(id, contentType,
spaceKey, spaceType)`), so a `~*` match on a cache hit sees the type.

Space identity (H1, D6): an argument key is never compared as typed. It is grammar-checked
(`SPACE_KEY_RE`, so `~x,HR` is `malformed`) and then canonicalised through the tenant; allow
entries match the canonical key exactly, deny entries case-insensitively, `~*` matches the
response `type === "personal"` (not the `~` prefix). When the tenant does not report a type,
`~*` does not match (fails closed). Whether Confluence's `keys=` lookup is case-insensitive is
part of the decision-14 live check ([05 Q2](05-risks-and-open-questions.md)); if it is, a
wrong-case argument resolves to the canonical key and is decided on it; if not, it is
`unknown-key` and the refusal hints the allowed key.

## 5. Policy reload, anchor and fail directions

### 5.1 Reload flow (decision 9)

```
tool call -> store.refresh()                 concurrent callers share one in-flight promise (cleared in finally)
   obs = await fingerprint()                 one lstat({bigint: true}): ino, mtimeNs, ctimeNs, size; or "absent"/errno
   obs equal to snapshot.observed?           -> return cached snapshot (also in a broken state)
   read = await readRegistry()
   read is parse-error or absent, mid-session?
       await sleep(75); obs = fingerprint(); read = readRegistry()      once (torn editor save, D35)
   a = await readAnchor()                    keychain, 2,000 ms timeout; only on a detected change
       present -> remember as last anchor; absent -> forget it; error -> keep the last anchor
   load = applyContinuity(startedOn, read, anchorState, projectPolicy(profile, read, path, anchorState))
   store obs as snapshot.observed whatever the outcome
   hash or state differs from the last snapshot?
       generation++; onChange(prev, next, now)     A: audit.log line; B: PolicyRecord "changed"/"unreadable"/"readable"/"anchor_mismatch"
       arm change note unless the new hash equals the last announced hash
   return snapshot
   (any exception -> unreadable io-error; the next call tries again)
```

- No `fs.watch`. The CLI's `rename` always changes the inode and the CLI `utimes` the file after
  writing the anchor, so running servers re-read both. An editor's save changes mtime or ctime.
  An edit that preserves inode, size and both nanosecond times is missed (accepted, [05
  R7](05-risks-and-open-questions.md)).
- A broken state is read once: 100 calls in an unreadable or absent state make one registry read
  and one keychain read (S16). The one exception is `anchor-unreadable`: while in it, refresh
  retries the anchor read at most once per 5 s by the injected clock, so unlocking the keychain
  takes effect without a file change.
- Hot: read scope, budget, `spaces` and `redact_patterns` (D18). Not hot: posture, `readOnly`,
  `allowed_tools`, `denied_tools` (tool registration is fixed at startup, decision 9); a change
  to them changes `startupHash`, which the change note reports.
- `checkSpaceAllowed` (`src/server/index.ts:1130-1136`) reads `store.current()` (no extra stat:
  the wrapper refreshed it for this call).
- Env-var mode (`profile === null`): no `PolicyStore`, no `lstat`, no anchor read; the gate
  passes every call through as `off` (S9).

### 5.2 Anchor rules (D23)

| File projection | Anchor | Effective policy | `anchor` |
|---|---|---|---|
| any | absent | the file's | `none` |
| equal to the anchor (scope, enforced flag, budget) | present | the file's | `match` |
| differs (narrower, wider, off, file or profile entry gone) | present | intersection: enforced if either is; scope = file `read_spaces` if any, else the anchor scope; ceiling = anchor scope; budget = the tighter | `mismatch` |
| on | read error, none known | unreadable `anchor-unreadable` | – |
| off | read error, none known | the file's (off) | `none` |
| any | read error, one known | as for "present" with the last known anchor | `match` / `mismatch` |

A mismatch is reported by a change note, the instructions line, `policy` and a read-log
`anchor_mismatch` record. It lasts until a terminal `policy setup` or `policy allow` writes the
file and the anchor again, or `policy setup` → `[o]ff` clears both.

### 5.3 Continuity (`applyContinuity`, in this order, S10)

1. The read is `unreadable` → unreadable (after the one re-read of §5.1).
2. An anchor is present or last known → §5.2. This row wins over rows 3 and 4: a removed file
   or profile entry with an anchor enforces the anchor, it does not switch off or deny.
3. No anchor, the session started `on`, and the registry is absent or the profile entry is gone
   → unreadable `removed` (deny).
4. Otherwise → the projection (a session that started `off` stays off when the file goes away).

### 5.4 Fail-direction table (rule 8)

| Situation | Direction | Code / surface |
|---|---|---|
| Env-var mode (no `CONFLUENCE_PROFILE`) | No `PolicyStore`; registry not consulted; off (as today) | – |
| Registry absent at startup, no anchor | Off (today's behaviour) | – |
| Registry, profile entry or policy keys absent at startup, anchor present | Start; enforce the anchor (intersection with nothing = the anchor) | change note, instructions line, `policy` |
| File differs from the anchor at startup or mid-session | Enforce the intersection; the file can narrow, never widen | change note, `policy`, `anchor_mismatch` (B) |
| Anchor read error, file on, no anchor known (startup or later) | Start normally; deny gated calls; each refresh retries the anchor read, at most once per 5 s | `POLICY_UNREADABLE` (`anchor-unreadable`) |
| Anchor read error at startup, file off | Off (the anchor is not known to exist) | – |
| Anchor read error mid-session | Keep the last anchor | – |
| Anchor read times out (2,000 ms) | As a read error | – |
| Registry unreadable at startup | Recovery mode, reason `registry-unreadable` | `setup_profile` text |
| Active profile's gate settings invalid at startup, profile enforces (incl. enforced without `read_spaces`) | Recovery mode, `invalid-settings` (Changed) | `setup_profile` text |
| Active profile's gate settings invalid, profile does not enforce | Start; drop the invalid entries; warn on stderr and in `policy` (D28) | – |
| Registry unreadable mid-session (any start state) | One re-read after 75 ms for a parse error; then deny every gated call except `get_version`, `upgrade`; writes included | `POLICY_UNREADABLE` (the text says the person can call again once after saving) |
| Fingerprint `lstat` fails (other than ENOENT) mid-session | As unreadable (`io-error`) | `POLICY_UNREADABLE` |
| Registry absent or profile entry removed mid-session after an `on` start, no anchor | One re-read after 75 ms; then deny | `POLICY_UNREADABLE` (`removed`) |
| Registry absent or profile removed mid-session after an `off` start, no anchor | Off | – |
| Registry absent or profile removed mid-session, anchor present | Enforce the anchor (§5.3 row 2) | change note |
| Policy turned off with `policy setup` → `[o]ff` | Off: a deliberate edit, logged with old and new fingerprint; the CLI cleared the anchor first | change note |
| `read_spaces: []`, enforced | Every read denied | `POLICY_SPACE_NOT_ALLOWED` |
| Space argument fails `SPACE_KEY_RE`, ID fails its grammar | Deny | `GATE_ARGS_MALFORMED` |
| Space key unknown to the tenant | Deny | `POLICY_SPACE_UNRESOLVED` |
| Space of a content ID unresolvable, or type unknown for a `~*` match | Deny | `POLICY_SPACE_UNRESOLVED` / `POLICY_SPACE_NOT_ALLOWED` |
| `count` spec with no countable id while a budget is set (any mode) | Deny | `POLICY_SPACE_UNRESOLVED` (`read-budget`) |
| Content not found (404) during resolution | Not-found error; handler not called; nothing released | `NOT_FOUND` (B record) |
| Network, auth, 429 after retries or 5xx during resolution | Error with the status class; handler not called | `API_ERROR` (B record) |
| Listing manifest missing or naming an out-of-scope space | Whole result withheld | `GATE_RELEASE_UNREPORTED` / `GATE_RELEASE_OUT_OF_SCOPE` |
| Content-read optional manifest item names another space than the pre-resolved one | Whole result withheld | `GATE_RELEASE_UNREPORTED` |
| Manifest tool returns an error result | Replaced by the fixed text with the status class | `isError` |
| Search scope not expressible in CQL | Search refused; never sent unscoped | `POLICY_SEARCH_NOT_SCOPABLE` |
| Title-tool manifest missing or naming another space | Whole result withheld | `GATE_RELEASE_UNREPORTED` |
| Target kind not checked in this phase (decision fall-through) | Deny | `GATE_TARGET_UNCHECKED` |
| Spec missing for a registered tool, or registration without `inputSchema` | Registration throws; the server does not start | `UndeclaredToolError` |
| `ask` without a person (step C) | Deny (`degradeAsk`) | fallback code |
| Step-A deny lines past 1,000 in one process | One `further denies suppressed` line; later denies not written to `audit.log` | – |
| Read log cannot be written | Release; receipt and `policy` report the gap; `droppedBefore` on the next written record (decision 12) | receipt suffix |
| Read log reaches 10 MB | One `capped` record; later appends return `EFBIG` into the same path | receipt suffix `read log NOT written (EFBIG)` |
| Read-log directory unsafe or file mode wrong at open | As unwritable for the whole session | receipt suffix |
| Policy changes between the gate's snapshot and the handler's `current()` | Both are valid policies; each narrows | accepted ([05 R8](05-risks-and-open-questions.md)) |
| CLI write while the registry is unreadable | Refuse before any temp file; bytes unchanged | `RegistryUnreadableError`, exit 1 |
| CLI write while the registry is absent | Start from `{profiles: []}`; `.bak` untouched | – |
| Crash during a CLI write | Old file intact (rename after fsync) or new file complete; `.bak` holds the version before the last CLI change; a stale lock is cleared after 60 s | – |
| Crash between the registry write and the anchor write | New file, old anchor: intersection until the command is repeated | change note |
| Two concurrent CLI writers | The lock serialises them; the second waits up to 5 s, then refuses | lock message, exit 1 |
| Hand edit during a CLI write | Detected by the pre-rename `lstat`; the change is re-applied to the new file (up to 3 tries) | – |
| Directory fsync fails after a successful rename | Warning on stderr; the write counts as done; skipped on Windows (D30) | stderr |

## 6. Flows per tool class

### 6.1 Content read (`get_page`, `get_comments`, version tools, labels, status, attachments)

Happy path: refresh → grammar-checked `contentArg` → `resolveContentSpace` (cache hit: no
request) → pre decision → (B) reserve the page id in the ledger → handler (which seeds
`pageSpaceCache` and attaches the optional manifest item where it holds `spaceId`) → release
check of the item → settle → read record → receipt. Degradations: out of scope → refusal,
handler not called (no body fetched, no page cache filled); unresolvable →
`POLICY_SPACE_UNRESOLVED`; 404 → not found; budget used up for a page not yet counted → refusal
in the pre phase, handler not called; handler error → settled as failed.

### 6.2 Title tools (`get_page_by_title`, `resolve_page_link`, step A)

Pre-check from the canonicalised `space_key` (`findSpaceByKey`, cached). The handler attaches
`{contentId, space}` from the response (`spaceId` → `getSpaceById`; for `resolve_page_link`,
`spaceKeyFromResponse`, no argument fallback), or `EMPTY_MANIFEST` when nothing was found.
Release: the space equals the pre-resolved one and is in scope; then (B) budget decided and
reserved for `get_page_by_title` on the manifest id. A missing manifest withholds the result
(D34; moved from step B so the step-A title tools do not trust the handler body).

### 6.3 Listings

| Tool | Pre | Handler | Release |
|---|---|---|---|
| `list_pages` | canonical `space_key` in scope | unchanged; manifest from returned pages' `spaceId`; seeds the cache | every manifest space equals the resolved space |
| `get_page_children` | parent's space in scope | unchanged; seeds the cache | pre-resolved space |
| `search_pages` | `all_spaces` → deny when enforced; else deferred | CQL via `scopeCql(cql, cqlScopeOf(scope, ceiling, personalCql))`, never unscoped; post-filter hits with `inScope` on the response space (the `space` expansion where present); hit without a response space dropped; `Some results were withheld by the read policy.` (no count); manifest with up to 100 content IDs; seeds the cache | every manifest space in scope, else whole result withheld |
| `get_recent_changes` | `all_spaces` → deny when enforced; `spaces[]` each canonicalised and in scope; else deferred | as `search_pages` | always a manifest, also with `spaces[]` (X7); as `search_pages` |
| `get_spaces` | deferred | filter with `inScope` on response key and type; `Showing spaces readable under this profile's policy.`; manifest | as `search_pages` |

CQL narrowing is an efficiency; `inScope` on returned items is the boundary. In
`search-default` mode the handlers behave as today, and the manifest is still required (the
release check then tests presence, not scope).

### 6.4 `download_attachment`

Pre: `getAttachmentMetadata` → container → space; budget keyed by the container id. Refused →
no file is created on disk, also with `overwrite: true` (an existing file at `output_path` is
not touched). The handler then fetches metadata again (unchanged code; one extra GET on this
path) and its own `checkSpaceAllowed` (`src/server/index.ts:4802`) still applies `spaces`.

### 6.5 Writes (D15)

Pre only: target space in the read scope (and ceiling) when enforced, else
`POLICY_WRITE_OUTSIDE_READ_SCOPE` before the handler (no request other than GET, no write-budget
use, no mutation-log record: contract C5). The handler's `checkSpaceAllowed` then checks
`spaces`; both must pass. `authorise_destructive_writes`: every id in `page_ids` (batched).
Comment tools: the comment's container; `create_comment` with `parent_comment_id`: page and
parent's container both (`allOf`); `create_page` with `parent_id`: the space and the parent's
space both.

### 6.6 Exempt and recovery

Exempt tools run the handler after rows 1–2 of `decideRead`. Recovery mode registers only
`setup_profile` outside the shim; its text comes from `recoveryText`.

## 7. Budget ledger (step B)

- **Unit:** distinct page or blog post id. `get_comments`, `get_page_version`,
  `diff_page_versions` count the page id; `download_attachment` counts its container id;
  `get_page_by_title` counts the manifest's content id. Reading the outline, a section and the
  whole page is one page. Listings and search excerpts are not counted (L11).
- **No id, no read (S1):** while a budget is set, a `count` call whose id is not known in its
  deciding phase is denied, in every mode.
- **Window:** rolling, `window_minutes` (default 60 when a budget is set). An id counts from its
  reservation and drops out `windowMs` later; re-reading a counted id does not move its time.
  The next slot frees up at `oldestAt + windowMs`, which the refusal states in UTC and local
  time.
- **Reservation:** in the pre phase, whenever the content id is known from the arguments,
  `decideRead` decides and the shell calls `ledger.reserve(ids)` in the same synchronous block
  (no `await` between). Parallel calls cannot overshoot the cap: the later one sees the earlier
  reservation. Every call that touches a counted id holds it (`inFlight + 1`), also when it was
  already counted.
- **Settling (S2):** on success each id is settled `released`; on a handler error or a release
  deny it is settled `failed`, which removes the id only when no other call holds it and it was
  never released. So when call 1 reserves page X, call 2 releases X, and call 1 then fails, X
  stays counted.
- **While no budget is set (N3):** the ledger keeps reserving while the policy is `on`, pruned at
  `DEFAULT_LEDGER_WINDOW_MS` (60 min), so turning a budget on mid-session counts the pages of the
  last window. A budget window longer than 60 minutes therefore starts with at most 60 minutes of
  history.
- **Warning:** the receipt warns when `cap - usedAfter <= max(1, ceil(cap * 0.2))`.
- **Changes:** a cap or window change applies to the next view; the ledger is kept. An anchor
  mismatch applies the tighter of the two budgets.
- **Lifetime:** process-local; a restart clears it (stated in the docs; threat model: accidents).
- **Clock:** `now()` injected at ledger creation; pure functions take `now`; tests pin it.

Invariants (property tests): `usedAfter <= cap`; re-reading a counted id is never denied by the
budget; with `n` distinct ids reserved at one `now`, exactly `min(n, cap)` are allowed; after
`oldestAt + windowMs` at least one new id is allowed; a deny never changes the state; `reserve`
then `settle(failed)` of new ids with no other holder is the identity; an id released by any
call stays counted until it ages out, whatever other calls holding it do; `prune` never removes
an id in flight; the entry count never exceeds the number of distinct ids reserved in the
window.

## 8. Change note

- Armed when a refresh yields a hash different from the last announced one (state changes
  count), and at startup or after a change when the anchor is `mismatch`. Cleared when attached.
- Attached to the next **final** result of any registered tool, refusals included, as its own
  text block: before the handler's blocks on a plain result, after them on a result with
  `structuredContent` (S20). An 8.0.0 `input_required` result is not final and leaves it armed.
- Several changes before the next call produce one note describing the latest policy.
- Independent of step B; in B the same event writes a `PolicyRecord`.

## 9. Read log semantics (step B)

- **Purpose:** operator self-audit and incident scoping (which content IDs went to the MCP
  client, when). It shows what the server handed to the client, not what a model provider
  received or kept.
- **Session start:** `PolicyRecord{event: "session_start", policyHash, anchorHash, startupHash,
  pid, version}` when the log opens. `session_end` (with `extraGets`) best-effort on transport
  close.
- **Per call:** one `ReadRecord` for every content-read and listing call (allow, deny, error),
  for exempt denies and for `lookup_user` allows, written after the decision (contract C5).
  Listing records carry the first 100 released content IDs and a count of the rest (D33).
- **Write failure:** `append` returns `{ok: false, errno}`; the counter of dropped records grows;
  the next successful record carries `droppedBefore`; the receipt shows `read log NOT written
  (<errno>)`.
- **Cap:** at 10 MB a file gets one `capped` record; later appends return `EFBIG` through the
  same path; `session_end` carries the dropped count (D29).
- **Retention:** files older than 90 days are deleted when a server opens a log; `log
  --purge-older-than <days>` deletes older files on demand. Deleting the directory removes the
  log; there is no switch to stop writing it (D10).
- **Changes outside the CLI (M5):** `log` and `policy` pair each `changed` record with a CLI
  line in `audit.log` carrying the same old and new fingerprint; a transition without one is
  reported as "changed outside the CLI". This is tamper evidence, not prevention: a same-user
  agent can also edit both logs.
- **Restart rule:** `policy` states which changes need a restart; it does not scan for running
  servers (D20).
