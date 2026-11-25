# 2. Interfaces

Status: design, reviewed 2026-11-25. Not built.

All types are `readonly`; functions in `src/shared/policy.ts` and `src/server/gate-core.ts` are
pure (no I/O, no clock, no randomness). The clock enters as `now: number` (epoch ms). Record and
input types are derived from their zod schemas with `z.infer`. Tests pin codes and line
prefixes, not whole messages (D37).

## 1. `src/shared/safe-fs.ts`, `src/shared/profiles.ts`, `src/shared/keychain.ts`

### 1.1 Registry read and write (step 0)

```ts
// safe-fs.ts
/** Like safeOpenRead (:48), plus: owner uid equals euid, verifyDirChain(parent); returns the
 *  fstat of the fd that was read ({ bigint: true }). Errors: "unsafe-permissions" (mode),
 *  "unsafe-owner", "unsafe-path" (directory chain), ELOOP, ENOENT, others by errno. */
export function safeOpenReadWithStat(path: string): Promise<{ readonly raw: string; readonly stat: BigIntStats }>;
/** temp O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600 in the same directory; write; fsync(fd);
 *  rename; fsync(dir) best effort (skipped on Windows; elsewhere a failure after a successful
 *  rename is a warning on stderr, not a write failure, D30). Removes the temp on any failure. */
export function safeAtomicWrite(path: string, bytes: string | Uint8Array): Promise<void>;
```

```ts
// profiles.ts
/** From lstat/fstat with { bigint: true }: nanosecond times. */
export interface FileFingerprint {
  readonly ino: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint; readonly size: bigint;
}
/** What the last lstat saw, kept whatever the read outcome (S16). */
export type Observation = FileFingerprint | "absent" | { readonly errno: string };

/** Gate setting names; an invalid-settings path holds only these and array indexes. */
export type SettingKey = "read_spaces" | "read_spaces_enforced" | "redact_patterns" | "spaces"
  | "policy" | "read_budget" | "pages" | "window_minutes";

/** Never carries file content or a JSON.parse message (S5). */
export type UnreadableReason =
  | { readonly kind: "parse-error"; readonly line?: number; readonly column?: number } // from the digits of the error position only
  | { readonly kind: "unexpected-shape" }
  | { readonly kind: "unsafe-permissions"; readonly target: "file" | "directory"; readonly problem: "mode" | "owner" }
  | { readonly kind: "not-regular-file" }            // symlink (ELOOP), device, directory
  | { readonly kind: "io-error"; readonly errno: string }                        // EACCES, EIO, …
  | { readonly kind: "invalid-settings"; readonly profile: string;
      readonly path: readonly (SettingKey | number)[] }                          // A: enforcing profiles only (D28)
  | { readonly kind: "removed"; readonly what: "file" | "profile" }              // A: mid-session, after an "on" start, no anchor
  | { readonly kind: "anchor-unreadable"; readonly profile: string; readonly errno: string }; // A: keychain error, no anchor known, file on

export interface Registry {
  readonly profiles: readonly string[];
  readonly settings?: Readonly<Record<string, ProfileSettings>>;
  readonly extra: Readonly<Record<string, unknown>>;   // unknown top-level keys, written back unchanged
}

export type RegistryRead =
  | { readonly state: "absent"; readonly observed: Observation }                   // ENOENT only
  | { readonly state: "ok"; readonly registry: Registry; readonly observed: FileFingerprint }   // fstat of the fd read
  | { readonly state: "unreadable"; readonly reason: UnreadableReason; readonly path: string;
      readonly backup: string | undefined; readonly observed: Observation };       // profiles.json.bak if present

/** Never throws. Reads through safeOpenReadWithStat. */
export function readRegistry(): Promise<RegistryRead>;
/** One lstat (a symlink is reported, not followed). */
export function registryFingerprint(): Promise<Observation>;

export const REGISTRY_UNREADABLE = "REGISTRY_UNREADABLE";
export class RegistryUnreadableError extends Error {
  readonly code: typeof REGISTRY_UNREADABLE;
  constructor(readonly reason: UnreadableReason, readonly path: string, readonly backup?: string);
}

export interface BackupFacts { readonly path: string; readonly fitsAnchor: boolean | undefined }  // undefined: no anchor or not checked
/** Pure. One sentence of what is wrong, one fix line; no file content. */
export function describeUnreadable(r: UnreadableReason, path: string, profile: string | null, backup?: BackupFacts):
  { readonly what: string; readonly fix: string };

// Lookups use Object.hasOwn: a profile named "__proto__" or "constructor" is not found via the prototype.
//   getProfileSettings(name)  -> undefined / settings[name] if own / throws RegistryUnreadableError
//   readProfileRegistry()     -> []        / profiles             / throws RegistryUnreadableError

export type WriteKind =
  | { readonly kind: "other" }                                   // setup, profiles flags: may not change any policy projection
  | { readonly kind: "policy"; readonly profile: string };       // policy setup / allow, after a terminal confirmation
/** The one writer core (D23, D12). Every exported writer below calls it. */
export function writeWithAnchor(
  change: (prev: Registry | undefined) => Registry, how: WriteKind,
): Promise<{ readonly before: Registry | undefined; readonly after: Registry }>;

export function setProfileSettings(name: string, settings: ProfileSettings): Promise<void>;   // shallow merge, as today; kind "other"
export function addToProfileRegistry(name: string): Promise<void>;                           // kind "other"
export function removeFromProfileRegistry(name: string): Promise<void>;                      // kind "other"; removed profiles exempt from the projection check
/** Whole-value replacement; returning undefined removes the profile's settings entry. */
export function updateProfileSettings(
  name: string, fn: (prev: ProfileSettings | undefined) => ProfileSettings | undefined, how?: WriteKind,
): Promise<{ readonly before: ProfileSettings | undefined; readonly after: ProfileSettings | undefined }>;
/** Throws RegistryUnreadableError when unreadable; used by CLI preflights. */
export function assertRegistryWritable(): Promise<void>;
```

`writeWithAnchor`, in order (the lock and `.bak` steps ship in step 0, the anchor steps in A):

1. `verifyDirChain(CONFIG_DIR)`. Take `profiles.json.lock` (`O_CREAT|O_EXCL`, 0600, holds pid
   and ISO time); retry every 50 ms for up to 5 s. A lock older than 60 s whose pid is not
   alive is removed with a warning. Otherwise refuse: `Another epimethian-mcp command is
   changing the profile registry. Try again in a moment; nothing was changed.` (exit 1). The
   lock is released in `finally`.
2. Remove `.profiles.json.*.tmp` files older than one hour (left by a crash).
3. `readRegistry()`. `unreadable` → throw `RegistryUnreadableError` before any temp file.
   `absent` → start from `{profiles: []}` and leave any `.bak` untouched (D36).
4. `next = change(prev)`. Kind `other`: for every profile present in `next`,
   `anchorOf(projection)` before and after must be equal; otherwise throw (a programming
   error: only `policy` commands change policy keys).
5. Kind `policy` and the projection of `profile` in `next` is off: `clearPolicyAnchor(profile)`
   first.
6. `ok` read: copy its bytes to `profiles.json.bak` with `safeAtomicWrite` (0600, fsync).
7. Write `next` with `safeAtomicWrite`; just before the rename, one `lstat` compared with the
   step-3 observation. A difference (a hand edit during the write) removes the temp and repeats
   from step 3, at most three times, then refuses.
8. Kind `policy` and the projection is on: `readRegistry()` again; the committed projection's
   `anchorOf` must equal the intended one, else stop with `The file changed while saving;
   nothing was anchored. Run the command again.` Then `writePolicyAnchor(profile, anchor)`, then
   `utimes` the registry so running servers re-read the file and the anchor.

Crash orders: a crash after step 5 leaves the file on and no anchor (the file's policy
applies). A crash between steps 7 and 8 leaves a new file and the old anchor: the intersection
applies until the command is repeated. Both fail narrow.

`describeUnreadable` fix lines:

| Kind | `fix` |
|---|---|
| `parse-error` | `Fix the JSON near line <l>, column <c> of <path>, then run: epimethian-mcp policy --profile <p>` (without position: `Fix the JSON in <path>, then run: …`) |
| `unexpected-shape` | `Fix the top level of <path> ({"profiles": [...], "settings": {...}}), then run: epimethian-mcp policy --profile <p>` |
| `unsafe-permissions`, file, mode | `chmod 600 <path>` |
| `unsafe-permissions`, file, owner | `Replace <path> with a copy you own (cp, then chmod 600); it is owned by another user` |
| `unsafe-permissions`, directory | `chmod 700 <dir> and make sure you own it and every directory above it` |
| `not-regular-file` | `Replace <path> with a regular file (it is a symlink or not a file)` |
| `io-error` | `Check that you can read <path> (error <errno>)` |
| `invalid-settings` | `Run: epimethian-mcp policy setup --profile <p> (the setting <path> is invalid; setup proceeds and replaces it)` |
| `removed` | `The read policy of profile <p> was in <path>, which is gone. Run: epimethian-mcp policy setup --profile <p> to set it again, or choose [o]ff there to let the agent read every space.` |
| `anchor-unreadable` | `Unlock the keychain (error <errno>); the server checks it again on a tool call a few seconds later.` |

The `.bak` clause is appended only when the backup exists: `The version before the last CLI
change is <path>.bak; run epimethian-mcp policy --check --profile <p> before restoring it.` When
`fitsAnchor` is false the clause adds `Restoring it would limit reads to what it and the last
policy set with policy setup both allow.` (X3, D36).

### 1.2 Keychain anchor (step A)

A separate keychain item, not a field of the credential record (D26): same service, account
`policy-anchor/<profile>` (profile name validated by `accountForProfile`'s rule). The seal
re-save and `setup` write only the credential item, so neither can drop or overwrite it.

```ts
// keychain.ts
export interface PolicyAnchor {
  readonly v: 1;
  readonly enforced: boolean;
  readonly scope?: readonly string[];      // present iff enforced: formatSpaceEntries of the enforced scope (canonical, sorted)
  readonly budget?: { readonly pages: number; readonly windowMinutes: number };
  readonly setAt: string;                  // ISO; not compared
}
export type AnchorRead =
  | { readonly state: "present"; readonly anchor: PolicyAnchor }
  | { readonly state: "absent" }                                  // the item positively does not exist
  | { readonly state: "error"; readonly errno: string };          // timeout, locked keychain, prompt denied, unparseable item
/** Never throws. Its own timeout (the caller passes 2,000 ms), below exec's 5 s (:125).
 *  absent only on the tool's documented not-found result (macOS `security` exit 44; Linux
 *  `secret-tool lookup` exit 1 with empty output); every other failure is error (X2, assumption 9). */
export function readPolicyAnchor(profile: string, opts: { readonly timeoutMs: number }): Promise<AnchorRead>;
export function writePolicyAnchor(profile: string, anchor: PolicyAnchor): Promise<void>;
/** Absent is success. */
export function clearPolicyAnchor(profile: string): Promise<void>;
```

Rules (D23):

1. The anchor is set if and only if the written projection is `on`; otherwise it is cleared.
   Only `writeWithAnchor` with kind `policy` sets or clears it; `profiles --remove` also clears
   it together with the credentials.
2. It holds the canonical enforced scope, the enforced flag and the budget, nothing else, so
   edits to `spaces`, `redact_patterns`, posture or tool lists never make it stale.
3. On a mismatch the gate enforces the intersection of file and anchor (§2.2
   `reconcileAnchor`): the file may narrow, never widen, until a terminal `policy setup` or
   `policy allow` re-anchors.
4. A read `error` keeps the last anchor known to the process. With none known and the file on,
   the load is `unreadable` (`anchor-unreadable`).

The anchor holds no secret; a same-user agent with keychain access can still remove or rewrite
it (stated in `06-limitations.md`). Profiles enforcing today have no anchor until `policy setup`
runs once (Changed entry).

## 2. `src/shared/policy.ts` (step A)

### 2.1 Scope grammar

```ts
/** Space keys: letters, digits, ".", "_", ":", "-"; personal keys start with "~". */
export const SPACE_KEY_RE = /^~?[A-Za-z0-9._:-]{1,255}$/;

/** A read_spaces entry: "DEV" (exact) | "~*" (all personal spaces) | "!KEY" (deny exception). */
export type SpaceEntry =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "all-personal" }
  | { readonly kind: "deny"; readonly key: string };

export interface SpaceScope {
  readonly keys: ReadonlySet<string>;      // exact, compared to the canonical resolved key
  readonly allPersonal: boolean;           // "~*": spaces whose resolved type is "personal"
  readonly deny: ReadonlySet<string>;      // stored upper-cased; matched case-insensitively
}
/** What the resolver knows about a space. `key` matches SPACE_KEY_RE or the space is
 *  unresolvable (S4). `type` is any v2 value (global, personal, collaboration,
 *  knowledge_base, …); only `=== "personal"` is ever tested (S22). */
export interface ResolvedSpace { readonly key: string; readonly type: string | undefined }

export function parseSpaceEntries(entries: readonly string[]):
  | { readonly ok: true; readonly scope: SpaceScope }
  | { readonly ok: false; readonly index: number };            // the entry index, never the value
export function formatSpaceEntries(scope: SpaceScope): readonly string[];   // inverse; sorted, canonical
/** deny (case-insensitive) beats keys (exact) beats allPersonal (type === "personal"). */
export function inScope(scope: SpaceScope, space: ResolvedSpace): boolean;
/** For hints only: the allowed key equal to `arg` ignoring case, if any. */
export function caseHint(scope: SpaceScope, arg: string): string | undefined;
export interface CqlScope { readonly keys: readonly string[]; readonly personal: boolean; readonly deny: readonly string[] }
/** With a ceiling: keys of `scope` that the ceiling allows by key (exact, or "~" prefix with
 *  ceiling.allPersonal), personal only if both allow it, deny = union. */
export function cqlScopeOf(scope: SpaceScope, ceiling: SpaceScope | undefined, personalCql: boolean):
  | { readonly ok: true; readonly cql: CqlScope; readonly personalOmitted: boolean }
  | { readonly ok: false };                                   // nothing expressible: search refused
```

`parseSpaceEntries` accepts `KEY` matching `SPACE_KEY_RE`, exactly `~*`, and `!KEY`. It rejects
`*` and every other `*`; `!~*`; a deny entry with nothing to except (`!KEY` with KEY not
personal when `~*` is absent); a list of only deny entries. `read_spaces: []` is valid: with
`read_spaces_enforced` it denies every read (mirrors `spaces: []` for writes). Plain-key lists
valid today parse unchanged unless a key has characters outside the charset: on an enforcing
profile that is `invalid-settings`; otherwise the entry is ignored with a warning (D28).

`personalCql` comes from the decision-14 live check (open question Q5). When it is false and
the scope has `~*`, `cqlScopeOf` omits the personal disjunct (`personalOmitted: true`; the
result says personal spaces were not searched); when the scope then has no exact key, it
returns `{ok: false}` and search is refused. A query is never sent unscoped.

### 2.2 Policy block, anchor reconciliation and effective policy

```ts
export const policyBlockSchema = z.strictObject({
  read_budget: z.strictObject({
    pages: z.number().int().min(1).max(10_000),
    window_minutes: z.number().int().min(1).max(1_440),
  }).optional(),                                                // step B (parsed from A)
});                                                             // unknown key -> invalid-settings
export type PolicyBlock = z.infer<typeof policyBlockSchema>;

export type PolicyHash = string & { readonly __brand: "PolicyHash" };   // sha256 of canonical JSON (sorted keys, sets as sorted arrays), 16 hex

export interface ReadBudgetPolicy { readonly pages: number; readonly windowMs: number }
export const DEFAULT_LEDGER_WINDOW_MS = 60 * 60_000;   // ledger window while no budget is set (N3)

export interface EffectivePolicy {
  readonly profile: string;                       // PolicyStore does not exist in env-var mode (S9)
  readonly state: "off" | "on";                   // on: read.mode "enforced" or budget set
  readonly read:
    | { readonly mode: "none" }
    | { readonly mode: "search-default"; readonly scope: SpaceScope }   // read_spaces without the flag (decision 7)
    | { readonly mode: "enforced"; readonly scope: SpaceScope;
        readonly ceiling?: SpaceScope };          // anchor scope while file and anchor disagree; inScope must pass both
  readonly writeSpaces: readonly string[] | undefined;                  // `spaces`, unchanged semantics
  readonly redactPatterns: readonly string[];
  readonly budget: ReadBudgetPolicy | undefined;                        // step B
  readonly ignored: readonly (readonly (SettingKey | number)[])[];     // invalid entries dropped on a non-enforcing profile (D28)
  readonly hash: PolicyHash;
  // Extension slots (step C-F); `never` until their step, so adding one is compile-guided.
  readonly approvals?: never; readonly clearance?: never; readonly metadata?: never; readonly detectors?: never;
}

/** What the shell knows about the anchor: a read error falls back to the last anchor seen by
 *  this process ("present"), or "unknown" when none was ever read. */
export type AnchorState =
  | { readonly state: "present"; readonly anchor: PolicyAnchor }
  | { readonly state: "absent" } | { readonly state: "unknown"; readonly errno: string };

export type PolicyLoad =
  | { readonly state: "ok"; readonly policy: EffectivePolicy;
      readonly anchor: "none" | "match" | "mismatch" }
  | { readonly state: "unreadable"; readonly reason: UnreadableReason; readonly what: string; readonly fix: string };

/** Pure projection of the active profile's gate keys (read_spaces grammar, read_spaces_enforced,
 *  redact_patterns, spaces, policy), looked up with Object.hasOwn, then reconcileAnchor.
 *  The only runtime validator of these keys (S13). A profile enforces when the file says
 *  read_spaces_enforced: true or the anchor says enforced. Invalid values on an enforcing profile
 *  -> invalid-settings; on any other profile -> dropped and listed in `ignored`.
 *  read_spaces_enforced without read_spaces -> invalid-settings. */
export function projectPolicy(profile: string, read: RegistryRead, path: string, anchor: AnchorState): PolicyLoad;
/** The anchor of a policy: undefined iff state is off. */
export function anchorOf(p: EffectivePolicy): PolicyAnchor | undefined;
/** absent -> file as is ("none"); equal -> "match"; otherwise "mismatch" and the intersection:
 *  enforced if either is; scope = the file's read_spaces if it has one, else the anchor scope;
 *  ceiling = the anchor scope when both exist; budget = the tighter (fewer pages, longer window;
 *  either alone applies). unknown with the file on -> unreadable "anchor-unreadable"; unknown
 *  with the file off -> the file. */
export function reconcileAnchor(file: EffectivePolicy, anchor: AnchorState): PolicyLoad;
/** Mid-session continuity (03 §5.3), in this order: unreadable stays unreadable; an anchor
 *  (present or last known) decides through reconcileAnchor, also when the file or profile
 *  entry is gone; with no anchor, after an "on" start, a file or profile entry that disappeared
 *  is unreadable "removed"; otherwise the projection. */
export function applyContinuity(startedOn: boolean, read: RegistryRead, anchor: AnchorState, load: PolicyLoad): PolicyLoad;
export function hashPolicy(p: Omit<EffectivePolicy, "hash">): PolicyHash;   // key and set order independent
/** Hash of what needs a restart: posture, readOnly, allowed_tools, denied_tools. */
export function startupHash(settings: ProfileSettings | undefined): PolicyHash;
```

### 2.3 Renderers

```ts
export interface FileFacts { readonly path: string; readonly state: "absent" | "readable" | "unreadable";
  readonly mode?: number; readonly writableByUser: boolean; readonly backup?: BackupFacts }
export interface LogFacts {                                   // step B; undefined in A
  readonly dir: string; readonly writable: boolean;
  readonly lastRecordAt?: string; readonly droppedSeen: number;
  readonly changedOutsideCli: readonly { readonly at: string; readonly from: string; readonly to: string }[];
}
export interface KeyCheck { readonly configured: string; readonly found: boolean; readonly suggestion?: string }  // --check
export function policySentences(load: PolicyLoad, file: FileFacts, anchor: AnchorState,
  log: LogFacts | undefined, keys: readonly KeyCheck[] | undefined,
  opts: { readonly verbose: boolean }): readonly string[];
export function instructionLines(load: PolicyLoad, opts: { readonly maxKeys: number }): readonly string[];
/** Defined here so gate-core imports it from policy.ts (never the reverse). */
export type ToolClass = "content-read" | "listing" | "write" | "exempt";
/** Names the readable spaces (≤ 5 keys, then "+N more") only for get_page, search_pages,
 *  get_spaces, get_recent_changes, list_pages; other gated tools get the fixed suffix (S34).
 *  undefined when off or exempt. Never a personal key. */
export function descriptionSuffix(tool: KnownTool, cls: ToolClass, load: PolicyLoad): string | undefined;   // import type only
export function changeSentence(prev: EffectivePolicy, next: EffectivePolicy): string;
```

Every renderer that names spaces writes a personal space as `a personal space` (or `N personal
spaces`) in agent-facing text (S25); local `policy` and `log` output shows keys.

## 3. `src/server/gate-core.ts` (step A; budget and receipt: B)

### 3.1 Spec types and combinators

```ts
import type { KnownTool } from "./tool-allowlist.js";

export type Args = Readonly<Record<string, unknown>>;

export type Target =
  | { readonly kind: "content"; readonly id: string }                  // page or blog post id, normalised
  | { readonly kind: "contents"; readonly ids: readonly string[] }      // authorise_destructive_writes
  | { readonly kind: "space"; readonly key: string }                   // argument form, not yet canonical
  | { readonly kind: "spaces"; readonly keys: readonly string[] }       // get_recent_changes spaces[]
  | { readonly kind: "comment"; readonly id: string; readonly type: "footer" | "inline" }
  | { readonly kind: "attachment"; readonly id: string }
  | { readonly kind: "deferred" }                                       // space known from the response
  | { readonly kind: "all-spaces" }                                     // all_spaces: true
  | { readonly kind: "none" }                                           // exempt, or an absent optional part
  | { readonly kind: "all"; readonly targets: readonly Target[] }       // allOf: every part must pass
  | { readonly kind: "malformed"; readonly arg: string };               // missing / wrong type / bad grammar

export interface TargetOf { (args: Args): Target; readonly argNames: readonly string[] }

export const CONTENT_ID_RE = /^\d{1,20}$/;   // page, blog post, comment ids; leading zeros stripped after the match
export const ATTACHMENT_ID_RE = /^(att)?\d{1,20}$/;

/** The only way a spec reads args. Each checks its grammar; a failure is `malformed`, so an
 *  argument string that is not an identifier never reaches a resolver, a refusal or a log.
 *  Content ids are normalised (leading zeros removed) for cache and ledger keys. */
export function contentArg(name: string): TargetOf;                       // CONTENT_ID_RE
export function contentsArg(name: string): TargetOf;                      // array of CONTENT_ID_RE, 1..250
export function spaceArg(name: string): TargetOf;                         // SPACE_KEY_RE
export function commentArg(idName: string, type: "footer" | "inline" | { readonly arg: string }): TargetOf;
export function attachmentArg(name: string): TargetOf;                    // ATTACHMENT_ID_RE
export function optional(part: TargetOf): TargetOf;                       // absent -> none; present -> part
export function allOf(...parts: readonly TargetOf[]): TargetOf;           // argNames = union; none parts dropped
export const searchTarget: TargetOf;          // all_spaces: true -> all-spaces; else deferred
export const recentChangesTarget: TargetOf;   // all_spaces -> all-spaces; spaces[] -> spaces; else deferred
export const deferredTarget: TargetOf;        // argNames []; get_spaces
export const noTarget: TargetOf;              // argNames []; exempt

export type Identities = "none" | "display-names" | "account-ids" | "contact";   // inventory for step E1

export type GateSpec =
  | { readonly class: "content-read"; readonly target: TargetOf;
      readonly release: "pre" | "manifest-id";      // manifest-id: handler attaches {contentId, space}; pre: optional manifest item checked if present
      readonly budget: "count" | "free"; readonly identities: Identities }
  | { readonly class: "listing"; readonly target: TargetOf;
      readonly release: "pre" | "manifest-spaces";
      readonly identities: Identities }
  | { readonly class: "write"; readonly target: TargetOf }   // read-scope ceiling (D15)
  | { readonly class: "exempt"; readonly reason: string;
      readonly onUnreadable: "deny" | "allow"; readonly logAllows: boolean; readonly identities: Identities };
// GateSpec["class"] is exactly ToolClass from shared/policy.ts (a type test pins the equality).

/** 8.1.0 (C6): each tool module exports its own row; this list is the only assembly point.
 *  Looked up with Object.hasOwn (a name like "constructor" is not found, S8). */
export const GATE_SPECS = {
  ...CORE_SPECS,               // the 41 tools of 7.6.0, table §3.2
  // ...from "./tools/<tool>.js" in 8.1.0, e.g. move_page: moveGateSpec,
} as const satisfies Record<KnownTool, GateSpec>;
```

### 3.2 `GATE_SPECS` (all registered tools)

Extra call = Confluence GET added by the gate on a cache miss; 0 on a hit. Caches: content→space
5 min (`src/server/space-allowlist.ts:61`), capped at 10,000 entries, seeded by handlers and
listings that already hold a `spaceId`; space id→`{key, type}` per process
(`confluence-client.ts:1527`, extended); space key→space per process (new, `findSpaceByKey`);
attachment→container 5 min (new, `gate.ts`); unknown keys and 404s 60 s, at most 1,000 entries.
Space caches have no TTL although Cloud allows a space key to change (accepted, R28).

| Tool | Class | Target | Release | Budget | Identities | Extra call on miss |
|---|---|---|---|---|---|---|
| `get_page` | content-read | `contentArg("page_id")` | pre (+ optional item) | count | none | 1 (+1 new space id) |
| `get_page_by_title` | content-read | `spaceArg("space_key")` | manifest-id | count (B) | none | 1 first time per key |
| `resolve_page_link` | content-read | `spaceArg("space_key")` | manifest-id | free | none | 1 first time per key |
| `get_attachments` | content-read | `contentArg("page_id")` | pre | free | none | 1 |
| `download_attachment` | content-read | `attachmentArg("attachment_id")` | pre | count (by container) | none | 1 (metadata, then container from the cache seeded by it) |
| `get_labels` | content-read | `contentArg("page_id")` | pre | free | none | 1 |
| `get_page_status` | content-read | `contentArg("page_id")` | pre | free | none | 1 |
| `get_comments` | content-read | `contentArg("page_id")` | pre | count | account-ids | 1 |
| `get_page_versions` | content-read | `contentArg("page_id")` | pre | free | display-names | 1 |
| `get_page_version` | content-read | `contentArg("page_id")` | pre (+ optional item) | count | none | 1 |
| `diff_page_versions` | content-read | `contentArg("page_id")` | pre | count | none | 1 |
| `list_pages` | listing | `spaceArg("space_key")` | manifest-spaces (returned `spaceId`s) | – | none | 1 first time per key |
| `get_page_children` | listing | `contentArg("page_id")` (children share the parent's space) | pre | – | none | 1 |
| `search_pages` | listing | `searchTarget` | manifest-spaces | – | display-names | 0 |
| `get_spaces` | listing | `deferredTarget` | manifest-spaces | – | none | 0 |
| `get_recent_changes` | listing | `recentChangesTarget` | manifest-spaces (always, also with `spaces[]`, X7) | – | display-names | 0 (1 per new key in `spaces[]`) |
| `check_permissions` | exempt (`deny` on unreadable) | – | – | – | none | 0 |
| `lookup_user` | exempt (`deny` on unreadable; allows logged in B; outside the space scope until step E, D27) | – | – | – | contact | 0 |
| `get_version` | exempt (`allow`) | – | – | – | none | 0 |
| `upgrade` | exempt (`allow`) | – | – | – | none | 0 |
| `create_page` | write | `allOf(spaceArg("space_key"), optional(contentArg("parent_id")))` | – | – | – | 1 first time per key |
| `create_blog_post` | write | `spaceArg("space_key")` | – | – | – | 1 first time per key |
| `update_page`, `delete_page`, `update_page_section`, `update_page_sections`, `prepend_to_page`, `append_to_page`, `revert_page`, `add_attachment`, `add_drawio_diagram`, `update_drawio_diagram`, `add_label`, `remove_label`, `set_page_status`, `remove_page_status` | write | `contentArg("page_id")` | – | – | – | 0 net (the handler's `checkSpaceAllowed` then hits the cache) |
| `create_comment` | write | `allOf(contentArg("page_id"), optional(commentArg("parent_comment_id", {arg: "type"})))` | – | – | – | 0 net |
| `update_blog_post` | write | `contentArg("blog_post_id")` | – | – | – | 0 net |
| `authorise_destructive_writes` | write | `contentsArg("page_ids")` | – | – | – | 1–2 per 250 ids (batched) |
| `resolve_comment` | write | `commentArg("comment_id", "inline")` | – | – | – | 0 net |
| `delete_comment` | write | `commentArg("comment_id", { arg: "type" })` | – | – | – | 0 net |
| `setup_profile` | not shimmed: registered by `startRecoveryServer` (`src/server/index.ts:6296`) on a bare server; no profile, no content | | | | | |

Argument names were read from the registrations (`src/server/index.ts:1335-6219`).

Added latency: with the policy on, a content read costs at most one extra metadata GET per
distinct page per 5 minutes, plus one GET the first time a space id or key is seen in the
process; a page reached from a listing (`list_pages`, `get_page_children`, `search_pages`) or
read before by another tool costs 0. At a typical Cloud round trip of 100–300 ms this is the
added latency of the first read of a page. Extra GETs are counted per session (`extraGets` in
the `session_end` record, B).

Not budgeted (L11): search excerpts and every listing (titles, excerpts, change summaries) are
released without counting; `get_attachments`, labels, status and the version list are free.
Attachments count per container page, so downloading ten attachments of one page is one page.

### 3.3 Decision core

```ts
export type ResolvedTarget =
  | { readonly kind: "space"; readonly space: ResolvedSpace;
      /** Scope and budget id: page or blog post id; for attachments and comments the container id. */
      readonly contentId?: string;
      readonly contentType?: "page" | "blogpost" | "attachment" | "comment";
      /** Log only: the attachment or comment id the call named. */
      readonly subjectId?: string;
      readonly argKey?: string }                    // the space_key argument as given, for caseHint only
  | { readonly kind: "spaces"; readonly spaces: readonly ResolvedSpace[]; readonly contentIds?: readonly string[] }
  | { readonly kind: "all-spaces" } | { readonly kind: "deferred" } | { readonly kind: "none" }
  | { readonly kind: "unresolvable"; readonly why: "no-space" | "custom-content" | "unknown-key" }
  | { readonly kind: "malformed"; readonly arg: string };

export type Phase = "pre" | "release";

export interface BudgetView {                       // step B
  readonly cap: number; readonly windowMs: number;
  readonly counted: ReadonlySet<string>;            // content ids reserved (in flight) or released inside the window
  readonly oldestAt: number | undefined;            // reservation time of the oldest counted id
}

export interface DecisionInput {
  readonly tool: KnownTool;
  readonly spec: GateSpec;
  readonly phase: Phase;
  readonly target: ResolvedTarget;
  readonly release?: ReleaseManifest;               // release phase
  readonly policy: PolicyLoad;
  readonly budget: BudgetView | undefined;
  readonly now: number;
  readonly capabilities: { readonly elicitation: boolean };
  // C: readonly approvals: readonly ApprovalView[];   D: readonly classification?: ClassificationView
}

export type RuleId = "policy-file" | "read-scope" | "all-spaces" | "read-budget" | "write-ceiling" | "gate-integrity";
//                     C: | "approval"   D: | "clearance" | "unmarked"   F: | "detector"

export type DenyCode =
  | "POLICY_UNREADABLE" | "POLICY_SPACE_NOT_ALLOWED" | "POLICY_SPACE_UNRESOLVED"
  | "POLICY_ALL_SPACES_REFUSED" | "POLICY_SEARCH_NOT_SCOPABLE" | "POLICY_BUDGET_EXHAUSTED"  // budget: B
  | "POLICY_WRITE_OUTSIDE_READ_SCOPE"                              // D15
  | "GATE_ARGS_MALFORMED" | "GATE_RELEASE_UNREPORTED" | "GATE_RELEASE_OUT_OF_SCOPE"
  | "GATE_TARGET_UNCHECKED";                                       // fall-through (X7)
export type AllowCode = "ALLOW" | "ALLOW_POLICY_OFF" | "ALLOW_EXEMPT";

/** Identifiers only, all grammar-checked: no title, CQL, excerpt, body, display name, file name or
 *  free argument string can be expressed. `spaceKey` is set only from a resolver result;
 *  `personal` makes the renderer write "a personal space" instead of the key. */
export interface Subject {
  readonly tool: KnownTool; readonly verb: "read" | "write";
  readonly contentId?: string; readonly spaceKey?: string; readonly personal?: boolean;
  readonly spaceKeys?: readonly string[];
}
export type Alternative =
  | { readonly kind: "use-spaces"; readonly keys: readonly string[]; readonly more: number;
      readonly personal: boolean; readonly caseHint?: string }
  | { readonly kind: "reread-counted"; readonly windowMinutes: number }
  | { readonly kind: "check-id" } | { readonly kind: "without-all-spaces" } | { readonly kind: "none" };
export interface Fix {
  readonly command: string | undefined;             // the one command for the person
  readonly also?: string;                           // D32: the --write form when a write also needs `spaces`
  readonly freesAt?: number;                        // budget: when the next page frees up
  readonly restart: "not-needed" | "needed";
}

export type Deny = {
  readonly verdict: "deny"; readonly code: DenyCode; readonly rule: RuleId;
  readonly subject: Subject; readonly fix: Fix; readonly alternative: Alternative; readonly profile: string;
};
export type Decision =
  | { readonly verdict: "allow"; readonly code: AllowCode;
      readonly budget?: { readonly reserve: readonly string[];   // every counted id this call touches (new and already counted)
                          readonly added: number; readonly usedAfter: number; readonly cap: number;
                          readonly windowMs: number; readonly warn: boolean } }
  | Deny
  | { readonly verdict: "ask"; readonly code: "ASK_APPROVAL"; readonly rule: RuleId;   // never produced in A/B
      readonly scope: { readonly kind: "page"; readonly id: string } | { readonly kind: "space"; readonly key: string };
      readonly fallback: Deny };

export function decideRead(input: DecisionInput): Decision;
/** Rule 7: the single point where `ask` is settled. Without a real person (elicitation now,
 *  terminal approval from C) it returns `fallback`. The soft-confirmation token never counts. */
export function degradeAsk(d: Decision, caps: { readonly elicitation: boolean }): Exclude<Decision, { verdict: "ask" }>;
```

`decideRead` is a fixed table of `(guard, outcome)` rows; the first match wins. It is
implemented as an exhaustive `switch` over `phase`, `spec.class` and `target.kind` whose
`default` assigns to `never`; there is no default allow (D34).

| # | Guard | Outcome |
|---|---|---|
| 1 | `policy.state === "unreadable"` and not (`exempt` with `onUnreadable: "allow"`) | deny `POLICY_UNREADABLE` (`policy-file`) |
| 2 | `exempt` | allow `ALLOW_EXEMPT` |
| 3 | `policy.policy.state === "off"` | allow `ALLOW_POLICY_OFF` |
| 4 | `target.kind === "malformed"` | deny `GATE_ARGS_MALFORMED` (`gate-integrity`) |
| 5 | read mode `enforced`, `all-spaces` | deny `POLICY_ALL_SPACES_REFUSED` (`all-spaces`) |
| 6 | `unresolvable` (any mode while on) | deny `POLICY_SPACE_UNRESOLVED` (`read-scope` when enforced, else `read-budget`) |
| 7 | release phase, manifest spec, no manifest | deny `GATE_RELEASE_UNREPORTED` (`gate-integrity`) |
| 8 | release phase, `manifest-id` or optional item naming another space than the pre-resolved one | deny `GATE_RELEASE_UNREPORTED` |
| 9 | read mode `enforced`, any space (target or manifest) not in scope (and ceiling) | write: deny `POLICY_WRITE_OUTSIDE_READ_SCOPE` (`write-ceiling`, D15); read pre: `POLICY_SPACE_NOT_ALLOWED`; read release: `GATE_RELEASE_OUT_OF_SCOPE` |
| 10 | write class, target `space` or `spaces` | allow `ALLOW` |
| 11 | budget set, `budget: "count"`, deciding phase (pre for `pre` specs, release for `manifest-id`), no content id known and the manifest is not empty | deny `POLICY_SPACE_UNRESOLVED` (`read-budget`, S1) |
| 12 | budget set, `budget: "count"`, `new = ids ∉ counted`, `counted.size + new.length > cap` | deny `POLICY_BUDGET_EXHAUSTED`, `fix.freesAt = oldestAt + windowMs` |
| 13 | the target was checked in this phase: pre with `space`/`spaces` on a non-write spec; pre on a manifest spec with `space`, `spaces`, `deferred` or (not enforced) `all-spaces` (decided again at release); release with a manifest | allow `ALLOW`; `budget.reserve` = the counted ids in this phase (also when no budget is set, N3); `warn = cap - usedAfter <= max(1, ceil(cap * 0.2))` |
| 14 | otherwise (e.g. `deferred` or `none` on a non-manifest spec) | deny `GATE_TARGET_UNCHECKED` (`gate-integrity`) |

The budget is decided once per id: in the pre phase when the id is known from the arguments, in
the release phase only for the title tools. The shell reserves `budget.reserve` synchronously
right after the decision and settles each id on the handler outcome or a release deny (§3.6).

Fix command rule (M3): the person line names `policy allow <KEY>` only when `subject.spaceKey`
came from the resolver (canonical, `SPACE_KEY_RE`) and the space is not personal. A personal
space, an unresolvable target or a malformed argument name `epimethian-mcp policy setup
--profile <p>` (scope) or nothing (call error).

### 3.4 Release manifest

```ts
export const RELEASE: unique symbol;                      // never serialised by either SDK
export interface ReleaseItem { readonly space: ResolvedSpace; readonly contentId?: string; readonly version?: number }
export interface ReleaseManifest { readonly items: readonly ReleaseItem[]; readonly withheld: number;
  readonly contentIds?: readonly string[] }               // listings: for the read log only (D33)
export const EMPTY_MANIFEST: ReleaseManifest;             // explicit "nothing released" (not found)
export type GatedResult<R> = R & { readonly [RELEASE]?: ReleaseManifest };
export function withRelease<R extends object>(result: R, m: ReleaseManifest): GatedResult<R>;   // new object
export function takeRelease<R extends object>(r: GatedResult<R>): readonly [R, ReleaseManifest | undefined];
```

Rules (M4): manifest spaces come from response space ids through `getSpaceById`, or from a
response `space` expansion with both `key` and `type`, never from arguments.
`searchPagesByTitle`'s fallback to the argument key (`confluence-client.ts:2463`) is not used; a
hit without a response space is dropped (and counts as withheld). Required for `search_pages`,
`get_spaces`, `list_pages`, `get_recent_changes` (always), `get_page_by_title` and
`resolve_page_link` (step A). Optional for other content reads: a handler that holds the
response `spaceId` attaches one item, checked by row 8 (B adds `version`). An error result from
a manifest tool is replaced by the fixed text `The request failed (<class>); nothing was
returned.` (`isError: true`), with `<class>` one of `rate limited`, `authentication`, `not
found`, `server error`, `network`, so an error message cannot carry names.

### 3.5 Refusal

```ts
export interface RefusalContext { readonly now: number; readonly tzOffsetMinutes: number; readonly readable?: Alternative }
/** Exactly five lines with fixed prefixes. */
export function renderRefusal(d: Deny, ctx: RefusalContext): string;
export const REFUSAL_PREFIXES = ["Withheld [", "Rule: ", "For the person: ", "Instead: ", "Restart: "] as const;
//                       write verb: "Not performed [" replaces "Withheld ["
```

Returned as `{ content: [{ type: "text", text }], isError: true }`.

### 3.6 Budget ledger (step B)

Pure functions take `now`; the shell cell (§5) is the only stateful signature and gets its
clock at creation.

```ts
export interface LedgerEntry { readonly at: number; readonly inFlight: number; readonly released: boolean }
export interface LedgerState { readonly entries: ReadonlyMap<string, LedgerEntry> }   // content id -> entry
export const emptyLedger: LedgerState;
/** Removes entries older than windowMs that no call holds (inFlight 0). */
export function prune(s: LedgerState, now: number, windowMs: number): LedgerState;
export function budgetView(s: LedgerState, p: ReadBudgetPolicy, now: number): BudgetView;
/** New ids get `at = now`; existing ids keep their time; every id's inFlight + 1. */
export function reserve(s: LedgerState, ids: readonly string[], now: number): LedgerState;
/** inFlight - 1 per id. "released" marks the id released. "failed" removes the id only when
 *  inFlight reaches 0 and it was never released (S2: a concurrent call that released the id
 *  keeps it counted). */
export function settle(s: LedgerState, ids: readonly string[], outcome: "released" | "failed"): LedgerState;
```

The view prunes with the budget window while a budget is set and with
`DEFAULT_LEDGER_WINDOW_MS` while none is set; the ledger holds at most one entry per id read in
the window (property-tested).

### 3.7 Receipt and change note

```ts
export interface ReceiptInput {
  readonly cls: "content-read" | "listing";
  readonly spaces: readonly ResolvedSpace[]; readonly contentId?: string; readonly version?: number;
  readonly items?: number; readonly someWithheld: boolean; readonly bytes: number;
  readonly budget?: { readonly used: number; readonly cap: number; readonly windowMinutes: number; readonly warn: boolean };
  readonly log: { readonly ok: true } | { readonly ok: false; readonly errno: string };
}
export function renderReceipt(r: ReceiptInput): string;
export function renderChangeNote(at: number, tzOffsetMinutes: number, sentence: string,
  opts: { readonly restartNeeded: boolean; readonly anchorMismatch: boolean }): string;
```

## 4. Recovery text (step 0, `src/server/index.ts` next to `startRecoveryServer`)

```ts
export type RecoveryReason =
  | { readonly kind: "profile-missing" }                                        // today's text
  | { readonly kind: "registry-unreadable"; readonly what: string; readonly fix: string };  // A: also invalid-settings on an enforcing profile
export function recoveryText(profile: string, r: RecoveryReason): {
  readonly serverName: string;      // confluence-<p>-setup-needed | confluence-<p>-config-error
  readonly instructions: string; readonly description: string; readonly text: string;
};
export function startRecoveryServer(profile: string, reason: RecoveryReason): Promise<void>;
```

Tool name stays `setup_profile` (golden name kept). `text` for `registry-unreadable`, in the
refusal shape:

```
Withheld [REGISTRY_UNREADABLE]: no Confluence tool is available in this session. This is final until the person fixes the file: do not retry, and do not edit the file yourself.
Rule: the profile registry ~/.config/epimethian-mcp/profiles.json has a JSON syntax error near line 14, column 3; an unreadable policy is refused, never ignored.
For the person: Fix the JSON near line 14, column 3 of ~/.config/epimethian-mcp/profiles.json, then run: epimethian-mcp policy --profile work. The version before the last CLI change is ~/.config/epimethian-mcp/profiles.json.bak; run epimethian-mcp policy --check --profile work before restoring it.
Instead: tell the user this message.
Restart: needed; restart the MCP client after the fix.
```

## 5. `src/server/gate.ts` (shell)

```ts
import type { CallToolResult } from "@modelcontextprotocol/server";   // SDK 2.x (8.0.0)

export interface PolicySnapshot {
  readonly load: PolicyLoad;
  readonly generation: number;
  readonly startHash: PolicyHash;
  readonly startedOn: boolean;
  readonly observed: Observation;             // last lstat, whatever the outcome (S16)
  readonly anchor: AnchorState;               // last anchor known to this process
}
export interface PolicyStoreDeps {
  readonly profile: string;                   // no store in env-var mode
  readonly fingerprint: () => Promise<Observation>;
  readonly read: () => Promise<RegistryRead>;
  readonly readAnchor: () => Promise<AnchorRead>;          // keychain, 2,000 ms timeout; on a detected change, or ≤ once per 5 s while anchor-unreadable
  readonly project: (read: RegistryRead, anchor: AnchorState) => PolicyLoad;
  readonly sleep: (ms: number) => Promise<void>;           // the one torn-save re-read (75 ms)
  readonly now: () => number;
  readonly onChange: (prev: PolicyLoad, next: PolicyLoad, at: number) => void;   // A: appendAuditLog; B: read log
}
export interface PolicyStore {
  /** Single flight: concurrent callers await the same promise, cleared in finally; any exception
   *  becomes unreadable io-error. One lstat; read, anchor and project only when it differs from
   *  `observed`. A mid-session parse-error or ENOENT is re-lstat'ed and re-read once after 75 ms. */
  refresh(): Promise<PolicySnapshot>;
  current(): PolicySnapshot;                  // sync, for handlers (checkSpaceAllowed, search scoping)
  takeChangeNote(): string | undefined;       // once per generation whose hash differs from the last announced
  _resetForTests(): void;
}
export function createPolicyStore(initial: { readonly read: RegistryRead; readonly anchor: AnchorState;
  readonly load: PolicyLoad }, deps: PolicyStoreDeps): PolicyStore;

export type ResolveResult = ResolvedTarget
  | { readonly notFound: true; readonly id: string }
  | { readonly apiError: true; readonly status: "rate-limited" | "authentication" | "server" | "network" };
/** GET only, through the client's 429/backoff/timeout handling. Space targets are
 *  canonicalised: findSpaceByKey(arg) -> {id, key, type}; the decision uses the response key and
 *  type, never the argument string. `contents` are looked up in batches (getContentSpaces). */
export function resolveTarget(t: Target): Promise<ResolveResult>;
/** Extension point (S3, step D labels): resolvers registered per Target kind, composed in order. */
export type TargetResolver = (t: Target, next: (t: Target) => Promise<ResolveResult>) => Promise<ResolveResult>;

export interface ReadBudgetLedger {
  view(windowMs: number, cap: number): BudgetView;   // prunes with the injected clock
  reserve(ids: readonly string[]): void;            // synchronous
  settle(ids: readonly string[], outcome: "released" | "failed"): void;   // synchronous
  _resetForTests(): void;
}
export function createReadBudgetLedger(now: () => number): ReadBudgetLedger;

export type Handler = (args: Args, ctx: unknown) => Promise<CallToolResult>;
export interface GateDeps {
  readonly store: PolicyStore | undefined;                               // undefined in env-var mode
  readonly resolve: (t: Target) => Promise<ResolveResult>;
  readonly ledger: ReadBudgetLedger | undefined;                         // B
  readonly log: ReadLog | undefined;                                     // B
  readonly denyLine: (d: Deny) => void;                                  // A: appendAuditLog, swallow errors, 1,000 per process then one suppression line
  readonly clientLabel: (ctx: unknown) => string | undefined;            // from the handler ctx (8.0.0)
  readonly capabilities: (ctx: unknown) => { readonly elicitation: boolean };   // per request
  readonly apiMode: "site" | "gateway";
  readonly now: () => number;
  readonly tzOffsetMinutes: () => number;
}
export class UndeclaredToolError extends Error { readonly code: "GATE_SPEC_MISSING" }
/** Returns the handler's whole result (structuredContent, _meta, isError kept); only appends or
 *  prepends text blocks (01 §1.4 step 11). */
export function gateHandler(name: KnownTool, spec: GateSpec, handler: Handler, deps: GateDeps): Handler;
/** False only for an SDK 2.x `inputRequired(...)` (non-final) result. */
export function isFinalResult(r: CallToolResult): boolean;
```

The stored fingerprint is the `fstat` of the fd `readRegistry` read from (nanosecond times);
`refresh` compares it with one `lstat({bigint: true})`. An edit that keeps inode, size and both
nanosecond times is missed until the next change (R7).

## 6. `src/server/read-log.ts` (step B)

```ts
export interface ReadLog {
  append(r: ReadRecord | PolicyRecord): { readonly ok: true } | { readonly ok: false; readonly errno: string };   // EFBIG at the cap
  readonly path: string | null;
  readonly session: string;
}
export function openReadLog(dir: string, deps: { readonly now: () => number; readonly randomHex: (n: number) => string;
  readonly maxBytes: number /* 10 MB */; readonly retentionDays: number /* 90 */ }): ReadLog;
export const readRecordSchema;       // writer: z.strictObject; records: 03 §2
export const policyRecordSchema;
export const readRecordReaderSchema; // log reader: z.looseObject variants, so newer fields are not gaps (S23)
export type ReadRecord = z.infer<typeof readRecordSchema>;
export type PolicyRecord = z.infer<typeof policyRecordSchema>;
```

`mutation-log.ts` exports (behaviour for `mutations-` unchanged):

```ts
export function openOwnerOnlyLog(dir: string, prefix: "mutations-" | "reads-", name: string,
  opts: { readonly allowExistingFallback: boolean }): { readonly path: string; readonly fd: number };
/** Deletes files of this prefix older than retentionDays; ENOENT on delete is ignored (two
 *  processes sweeping). */
export function sweepOldLogs(dir: string, prefix: "mutations-" | "reads-", now: number, retentionDays: number): void;
```

`openReadLog` calls `verifyDirChain(dir)` (`src/shared/safe-fs.ts:182`), opens
`reads-<startISO>-<pid>-<session8>.jsonl` with `allowExistingFallback: false` (`O_EXCL` only;
the session hex makes the name unpredictable), and checks `fstat` mode 0600 and owner; any
failure makes the log unwritable for the session (reported, decision 12). At `maxBytes` minus a
1 KB reserve it writes one `PolicyRecord{event: "capped"}` and returns `EFBIG` for every later
append; `session_end` uses the reserve and carries `droppedBefore`.

## 7. Server instructions and descriptions

`buildServerInstructions` gains `policyLines?: readonly string[]` from `instructionLines(load,
{maxKeys: 20})`, appended after the existing lines. Enforced scope, budget set:

```
Read scope (enforced by the server): content in spaces DEV, DOCS and in personal spaces (except 1 excluded personal space) can be read. Reads elsewhere return a "Withheld [POLICY_...]" result. It is final for that call: relay it to the user, quote its "For the person" line, and do not retry it or read it through another tool until the user says the policy was changed. search_pages, get_spaces and get_recent_changes only show these spaces. Writes are limited to the same spaces.
Read budget: 50 distinct pages per 60 minutes. Each read that returns content ends with a "[epimethian-mcp receipt]" line showing the count; re-reading a page does not count. When the receipt warns, tell the user before starting more reads.
```

More than 20 keys: `DEV, DOCS, … and 37 more (get_spaces lists them)`. Anchor mismatch adds: `The
policy file differs from the policy last set with epimethian-mcp policy setup; the server
applies only what both allow.` Test: `instructions.length <= 4096` with 100 keys in gateway mode,
read-write.

Description suffixes (`descriptionSuffix`, appended by the shim when `state` is `on`, S34):

| Tools | Suffix |
|---|---|
| `get_page` | ` Policy: only content in DEV, DOCS and personal spaces is returned; other IDs are withheld.` |
| `search_pages`, `get_spaces`, `get_recent_changes`, `list_pages` | ` Policy: results are limited to DEV, DOCS and personal spaces.` |
| every other content-read, listing and write tool | ` Read policy applies; see instructions.` |
| exempt | none |

At most 5 keys, then `+N more`. Descriptions are fixed at registration; after a mid-session
change the change note supersedes them (stated in the agent guide). Test: every description
stays ≤ 1,800 characters (8.1.0 W-META-8.1 cap) with the suffix and 100 configured keys.

## 8. Templates

Pinned: the codes, the five prefixes, and the line-1 sentence `This is final for this call`.
The rest of each line may be reworded without a contract change (D37).

### 8.1 Refusals

Page outside the scope (`get_page`):

```
Withheld [POLICY_SPACE_NOT_ALLOWED]: page 12345 was not returned. This is final for this call: do not retry it or read it through another tool until the person says the policy was changed.
Rule: the read scope of profile "work" does not include space HR.
For the person: epimethian-mcp policy allow HR --profile work
Instead: work with content in DEV, DOCS (search_pages and get_spaces only show those).
Restart: not needed; policy changes apply on the next tool call.
```

Wrong-case argument (`list_pages` with `space_key: "dev"`, tenant lookup not found):
`Instead: use DEV (space keys are case-sensitive).` Content in a personal space: `Rule: the read
scope of profile "work" does not include this personal space.` and `For the person:
epimethian-mcp policy setup --profile work`.

| Code | Rule line | For the person | Instead | Restart |
|---|---|---|---|---|
| `POLICY_UNREADABLE` | `the policy file <path> cannot be read (<what>); an unreadable policy is refused, never ignored.` | `<fix>` from `describeUnreadable` | `tell the user. If the person was just saving the file, call again once; otherwise nothing in this server can be read until it is fixed.` | standard |
| `POLICY_SPACE_UNRESOLVED` (`unknown-key`) | `that space key does not exist in this tenant, so it is outside the read scope of profile "work".` | `nothing; the key does not exist here.` | `check the key (space keys are case-sensitive)`, or the case hint | standard |
| `POLICY_SPACE_UNRESOLVED` (`no-space`, `custom-content`) | `the space of content 12345 could not be determined, so it is outside the read scope of profile "work".` | `nothing; this content has no space the policy can check.` | `check the ID; attachments and comments on custom content cannot be read under this policy.` | standard |
| `POLICY_SPACE_UNRESOLVED` (`read-budget`) | `the read budget of profile "work" counts pages, and this call names none it can count.` | `nothing needed.` | `read the page by ID with get_page.` | standard |
| `POLICY_ALL_SPACES_REFUSED` | `profile "work" enforces its read scope, so all_spaces cannot widen a call.` | `nothing needed.` | `call again without all_spaces; results are limited to DEV, DOCS.` | standard |
| `POLICY_SEARCH_NOT_SCOPABLE` | `the read scope of profile "work" contains only personal spaces, which search cannot be limited to.` | `epimethian-mcp policy setup --profile work` | `read pages by ID instead.` | standard |
| `POLICY_BUDGET_EXHAUSTED` | `the read budget of profile "work" (50 distinct pages per 60 minutes) is used up.` | `nothing needed; the next page frees up at 14:05 UTC (15:05 local, in 12 minutes). To raise the limit: epimethian-mcp policy setup --profile work` | `pages already read in the last 60 minutes can be read again and do not count; summarise from them.` | standard |
| `POLICY_WRITE_OUTSIDE_READ_SCOPE` | `profile "work" may not write to space HR because HR is outside its read scope.` | `epimethian-mcp policy allow HR --profile work` (when HR is not in `spaces`, adds: `; writes there also need: epimethian-mcp policy allow HR --write --profile work`) | `write only to pages in DEV, DOCS.` | standard |
| `GATE_ARGS_MALFORMED` | `argument page_id is missing or not a valid ID.` | `nothing; this is a call error.` | `call again with page_id as a numeric ID.` | standard |
| `GATE_RELEASE_UNREPORTED`, `GATE_RELEASE_OUT_OF_SCOPE`, `GATE_TARGET_UNCHECKED` | `the server could not confirm the spaces of this result, so all of it was withheld.` | `report this as a bug: https://github.com/de-otio/epimethian-mcp/issues` | `use list_pages with space_key DEV, or get_page with a page ID in DEV.` | standard |

Standard restart line: `Restart: not needed; policy changes apply on the next tool call.` (D18).
`Restart: needed; …` appears only in recovery text.

API error during resolution (not a refusal; `isError: true`, two lines):

```
The server could not check the space of content 12345 (rate limited); nothing was returned.
For the person: if this keeps happening, run: epimethian-mcp status --profile work
```

Only these values are interpolated: grammar-checked content IDs, resolver-derived non-personal
space keys, keys from the policy (personal ones as "a personal space"), the profile name,
argument names (from the spec, not from the call), the file path, a time, counts, `what`/`fix`
from `describeUnreadable`. Argument strings never appear. The listed alternative keys follow the
same 20-key cap as the instructions.

### 8.2 Receipts (B)

Appended as its own text content block, outside any untrusted fence:

```
[epimethian-mcp receipt] space DEV · page 12345 v7 · 18204 bytes · budget 12/50 pages per 60 min
[epimethian-mcp receipt] space DOCS · page 777 · 3010 bytes · budget 41/50 pages per 60 min · 9 pages left: tell the user before starting more reads
[epimethian-mcp receipt] 14 results from DEV, DOCS and 1 personal space · some results withheld by the read policy · 3100 bytes
[epimethian-mcp receipt] a personal space · page 12345 · 18204 bytes · read log NOT written (ENOSPC)
```

`bytes` = UTF-8 length of the handler's text blocks. Listing receipts never state how many
results were withheld (M7); the count goes to the read log only. Receipts appear only when
`state` is `on`.

### 8.3 Change note (A)

Attached once per changed generation to the next final result:

```
[epimethian-mcp] The policy changed at 14:02 UTC (15:02 local) since this session started: the agent may now read DEV, DOCS and HR. No restart needed: policy changes apply on the next tool call.
```

Additions: startup hash differs → `Changes to posture or tool lists apply after a restart of the
MCP client.`; anchor mismatch → `The policy file differs from the policy last set with
epimethian-mcp policy setup; the server applies only what both allow.`

## 9. CLI

### 9.1 Synopses

```
epimethian-mcp policy [--check] [--verbose] [--profile P]     --check contacts the tenant
epimethian-mcp policy setup [--profile P]                     terminal required
epimethian-mcp policy allow <KEY> [--write] [--profile P]     terminal required; reads, or with --write writes only
epimethian-mcp log [--since 24h|7d|<ISO>] [--until <ISO>] [--profile P] [--format summary|jsonl]
epimethian-mcp log --purge-older-than <days>                  terminal required
```

Flags are parsed with `node:util` `parseArgs` (`strict: true`; D31). Profile resolution:
`resolveProfileArg` (`src/cli/profile-arg.ts`), i.e. `--profile` or `CONFLUENCE_PROFILE`. Exit
codes: 0 success; 1 refused or failed (unreadable registry, no terminal, unknown key, network
error; `policy --check` when a configured key is not in the tenant); 2 usage error. `log` writes
records to stdout and diagnostics to stderr. Filters by space or tool are documented as `log
--format jsonl | jq …`.

Terminal requirement (`requireTerminal()`, `src/cli/terminal.ts`): `process.stdin.isTTY`, and
`/dev/tty` opens; the confirmation is read from `/dev/tty` as a `tty.ReadStream` (not stdin) and
the stream is closed afterwards. Stdout may be piped. This keeps a piped or tool-driven
invocation from confirming. It is a speed bump: `script`, `expect` or a pseudo-terminal defeat
it (stated in `06-limitations.md`). The same requirement is added to `profiles
--set-read-write` (`src/cli/profiles.ts:45-54`), which widens access and runs without a terminal
today.

### 9.2 Credentials and the space list in the CLI

`getConfig()` is a process singleton (`src/server/confluence-client.ts:141`, `:240`) that reads
`CONFLUENCE_PROFILE`. `policy --check`, `policy setup` and `policy allow` follow
`src/cli/permissions.ts:29-46`: validate the profile name, set
`process.env.CONFLUENCE_PROFILE`, then `await import("../server/confluence-client.js")` and
`await getConfig()`. The CLI is a one-shot process, so the singleton's lifetime is the
command's; `getConfig`'s own `process.exit` on a broken keychain record is acceptable here.
`validateStartup` is not run (no write probe). All three run `readRegistry()` first and stop on
`unreadable` before any keychain or network access, except `policy setup` when the only problem
is the active profile's `invalid-settings` (it replaces them). New client functions:

```ts
/** v2 /spaces, limit=250, follows every _links.next via resolveV2NextLink; stops at maxSpaces.
 *  No type filter: v2 also returns collaboration, knowledge_base and other types. */
export function listAllSpaces(opts: { readonly maxSpaces: number }):
  Promise<{ readonly spaces: readonly { readonly id: string; readonly key: string; readonly name: string; readonly type: string }[];
            readonly truncated: boolean }>;
/** v2 /spaces?keys=K: exact lookup; cached per process; a key failing SPACE_KEY_RE is not returned. */
export function findSpaceByKey(key: string): Promise<{ readonly id: string; readonly key: string; readonly type: string; readonly name: string } | undefined>;
/** v2 /spaces/{id}; shares getSpaceKeyById's cache. */
export function getSpaceById(id: string): Promise<{ readonly key: string; readonly type: string } | undefined>;
/** v2 GET /pages?id=…, then /blogposts?id=… for ids not found (≤ 250 per request); seeds the cache. */
export function getContentSpaces(ids: readonly string[]): Promise<ReadonlyMap<string, { readonly spaceId: string; readonly type: "page" | "blogpost" }>>;
```

`policy setup` uses `maxSpaces: 10_000`; when `truncated` is still true it says so and offers
`/text` filtering, never an "all" option.

### 9.3 `policy` output

```
Profile "work".
The agent may read pages, blog posts and comments in DEV and DOCS, and in personal spaces except 1 excluded personal space.
Reads outside these spaces are withheld; searches and space lists are limited to them.
The agent may change pages in DEV only.
Read budget: 50 distinct pages per 60 minutes.
Reads are recorded in ~/.epimethian/logs (last record 14:02 UTC; no gaps; kept 90 days).
Policy file: ~/.config/epimethian-mcp/profiles.json, readable, mode 0600, writable by you. An agent with file access could change it; changes made with this CLI are recorded, and the read log shows changes made outside it.
Changes outside the CLI: 1 (14:02 UTC).
This policy is the one last set with policy setup.
No restart needed: policy changes apply on the next tool call. Changes to posture or tool lists need a restart of the MCP client.
```

`--verbose` adds the fingerprints (`fingerprint 3f9a01c2d4e5b6a7`, `3f9a01c2 -> 9b7e44d1`) and the
anchor's `setAt`.

Variants:

- `--check` adds one line per configured key that is not in the tenant: `Space key "dev" is not
  in this tenant; did you mean DEV? Reads there are withheld.` (exit 1), and, when
  `profiles.json.bak` exists, one line on it: `profiles.json.bak (the version before the last
  CLI change) matches the policy last set with policy setup.` or `… does not match the policy
  last set with policy setup; restoring it would limit reads to what both allow until you run
  policy setup.`
- Anchor mismatch: `The file differs from the policy last set with policy setup (reads: DEV,
  DOCS). Running servers apply only what both allow. To keep the file's version, run
  epimethian-mcp policy setup --profile work; to turn the policy off, choose [o]ff there.`
- Anchor read error: `The keychain could not be read (<errno>), so the policy last set with
  policy setup was not checked.`
- Ignored entries (D28, non-enforcing profile): `1 entry in read_spaces is not a valid space key
  and is ignored (entry 3).`
- Off: `Profile "work" has no read policy: the agent can read every space the token can read.
  Run epimethian-mcp policy setup to limit it.`
- Unreadable: the `what` and `fix` lines, then `Until this is fixed, servers for every profile
  start without Confluence tools; their one tool explains this.`, exit 1.

Budget, log and "outside the CLI" lines appear from step B.

### 9.4 `policy setup` transcript

```
$ epimethian-mcp policy setup --profile work
Spaces in this tenant (42). Tick the ones the agent may read; it will not read the others.
  [x]  1  DEV    Development
  [ ]  2  HR     Human Resources
  [x]  3  DOCS   Documentation
  ...
  [ ]  p  All personal spaces
Numbers or ranges toggle (1,3,5-7); /text filters; o turns the read policy off; Enter confirms.
> 
Limit reads to a number of distinct pages per hour? [n]o / number (suggested 100): 100
Which spaces may the agent change? [k]eep (now: DEV) / [s]ame as read / [p]ick / [n]one: k
The agent will read DEV and DOCS and nothing else, at most 100 distinct pages per 60 minutes, and change pages in DEV only.
Save? [y/N] y
Done. No restart needed: policy changes apply on the next tool call.
```

Ticks show the current `read_spaces`; on a first run nothing is ticked. Saving always sets
`read_spaces_enforced: true` (there is no separate enforce question, S30). The budget question
appears from step B. Existing `!` entries are kept and shown as `Excluded: 1 personal space
(kept)`. There is no option that selects all spaces. Saving goes through `writeWithAnchor`
(kind `policy`): registry, anchor and an `audit.log` line with the old and new fingerprint.

Other states:

| State | Output | Exit |
|---|---|---|
| Nothing ticked, Enter | `No spaces ticked: the agent will not be able to read any page. [b]ack / [s]ave anyway` | – |
| `o` | `Turn the read policy off? The agent will read every space the token can read again. [y/N]`; on `y`: removes `read_spaces_enforced` and `policy`, keeps `read_spaces` as the search default, clears the anchor; `Done. The read policy is off. No restart needed: policy changes apply on the next tool call.` | 0 |
| Active profile's gate settings invalid | `The current read settings of profile "work" are invalid (read_spaces entry 3); this setup replaces them.`, then the picker | – |
| Tenant unreachable | `Could not list the spaces of this tenant (<class>). Nothing was changed. Check the connection with: epimethian-mcp status --profile work` | 1 |
| Zero spaces listed | `The token cannot see any space in this tenant. Nothing was changed. Check its scopes with: epimethian-mcp status --profile work` (gateway mode names the space-read scope) | 1 |
| List truncated | `Showing the first 10,000 spaces; the tenant has more. Type /text to find a space by key or name.` | – |
| No terminal | `policy setup needs a person at a terminal; nothing was changed.` | 1 |
| Registry locked | the lock message of §1.1 | 1 |

### 9.5 `policy allow` transcript

```
$ epimethian-mcp policy allow HR --profile work
Allow the agent to read space HR (Human Resources)? [y/N] y
Done. The agent may now read DEV, DOCS and HR. No restart needed: policy changes apply on the next tool call.

$ epimethian-mcp policy allow HR --write --profile work
Allow the agent to change pages in space HR (Human Resources)? [y/N] y
Done. The agent may now change pages in DEV and HR. No restart needed: policy changes apply on the next tool call.

$ epimethian-mcp policy allow hr --profile work
No space "hr" in this tenant. Did you mean HR? Nothing was changed.
```

`<KEY>` must match `SPACE_KEY_RE` and exist in the tenant (`findSpaceByKey`); the canonical key
from the response is written. Plain `policy allow` widens reads only (adds to `read_spaces`,
removes a matching `!KEY`); `--write` widens writes only (adds to `spaces`, D32). `--write` for
a space outside an enforced read scope adds: `HR is outside the read scope, so writes there stay
refused until you also run: epimethian-mcp policy allow HR --profile work`. A personal key is
accepted (Q9). Both go through `writeWithAnchor` (kind `policy`). No terminal: `policy allow
needs a person at a terminal; nothing was changed.`, exit 1.

### 9.6 `log` output

```
$ epimethian-mcp log --since 24h
2026-11-24 15:00 to 2026-11-25 15:00 UTC: 142 reads of 37 distinct pages by 1 client (vscode), 3 withheld.
  DEV   30 pages  118 reads  1.2 MB
  DOCS   7 pages   21 reads  0.3 MB
Withheld: 2 outside the scope (HR), 1 budget; 6 search results filtered out.
Policy changes: 14:02 UTC, not made with the CLI.
Gaps: none.
```

Empty period: `2026-11-24 15:00 to 2026-11-25 15:00 UTC: no reads recorded for profile "work".`
`--format jsonl` writes the matching records to stdout unchanged. Unparseable lines are counted
(`Gaps: 1 unparseable line in reads-2026-11-25T09-12-00Z-4242-a1b2c3d4.jsonl`); `droppedBefore`
totals are reported as `Gaps: 4 records not written between 10:01 and 10:03 UTC`; a `capped`
record as `Gaps: the read log of one session reached 10 MB at 11:40 UTC; later reads of that
session were not recorded.` Records of a newer schema are counted as `newer records`, not gaps.
A policy fingerprint transition with no matching CLI line in `audit.log` is labelled "not made
with the CLI".

`log --purge-older-than 30`: `Deleted 4 read-log files older than 30 days (2.1 MB). Copies in
backups or synced folders are not affected.`

## 10. Extension points (C–G)

| Step | Hook in A/B |
|---|---|
| C approvals | `Decision.ask` with `scope` and `fallback`; `degradeAsk` is the only settle point; `DecisionInput` slot `approvals`; `EffectivePolicy.approvals?: never`; `RuleId` `approval`; `ReadRecord.approvalId` reserved; budget refusal's person line names `policy approve` when C lands |
| D classification | `TargetResolver` chain gains a cached label resolver feeding `DecisionInput.classification`; `GateSpec` gains `classify?: true`; release manifest carries `version` (check and body from the same version); allow code `ALLOW_REPORT_ONLY`; `policyBlockSchema` gains clearance keys; named policies (D21) |
| E metadata | `identities` per spec is the E1 inventory; `lookup_user` is exempt with `contact` and logged from B, so E's switch is a spec change (D27) |
| F detectors | Post-handler slot between `takeRelease` and the receipt: `transformResult(tool, result, policy) -> { result, counts }`; `ReadRecord.detectorHits` |
| G | None beyond F |
