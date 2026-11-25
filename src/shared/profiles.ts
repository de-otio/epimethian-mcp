import { mkdir, lstat, type FileHandle } from "node:fs/promises";
import { promises as fsPromises, constants as fsConstants, type BigIntStats } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import {
  safeOpenAppend,
  safeOpenReadWithStat,
  safeAtomicWrite,
  verifyDirChain,
  UnsafePathError,
} from "./safe-fs.js";

/**
 * Track E1 — Symlink / TOCTOU audit memo (see `plans/security-audit-fixes.md`).
 * Audit only — no behaviour change in this commit. E2 will implement the fixes
 * recommended at the bottom of this memo.
 *
 * Scope: every security-sensitive file read or write under the user's home
 * directory that we control. All live under either
 *   ~/.config/epimethian-mcp/   (registry, audit log, update-check state)
 *   ~/.epimethian/logs/          (mutation JSONL)
 * Out of scope: `src/server/index.ts` add_attachment / add_drawio_diagram file
 * I/O — those are user-supplied paths already gated by a `realpath` + CWD
 * prefix check, with no fd reuse, so a mid-op swap is bounded to content the
 * user could have supplied directly.
 *
 * | Path                            | Operation       | Current guard                                         | Parent dirs checked?   | O_NOFOLLOW + fstat fixes it? | TOCTOU risk |
 * |---------------------------------|-----------------|-------------------------------------------------------|------------------------|------------------------------|-------------|
 * | profiles.json (read)            | stat + readFile | stat → mode & 0o022 check, then readFile (2 syscalls) | NO                     | YES — open(RDONLY|NOFOLLOW), fstat fd, read fd | HIGH: stat→readFile race; symlinked parent dir bypasses entirely |
 * | profiles.json (write)           | writeFile tmp + rename                  | mkdir 0o700 recursive; writeFile mode 0o600; rename   | NO (recursive mkdir does not verify existing dirs) | Partially — open tmp with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW; rename is atomic but still resolves symlinks on the target path | MEDIUM: attacker-owned parent dir could redirect final rename target |
 * | audit.log (append)              | appendFile mode 0o600                   | mkdir 0o700; appendFile creates if missing            | NO                     | YES — open(WRONLY|APPEND|CREAT|NOFOLLOW), writeSync | MEDIUM: symlinked audit.log could redirect appended entries to an attacker-writable file |
 * | update-check.json (read)        | readFile                                | none (try/catch → null)                               | NO                     | YES — open(RDONLY|NOFOLLOW), fstat fd, read fd | LOW-MEDIUM: pending-update record could be poisoned to suppress upgrade nag, but no code execution path from parsed content |
 * | update-check.json (write)       | writeFile tmp + rename                  | mkdir 0o700 recursive; writeFile mode 0o600; rename   | NO                     | Partially — same as profiles.json write | MEDIUM: same parent-dir-swap risk as profiles.json write |
 * | ~/.epimethian/logs/ (init)      | existsSync → mkdirSync | lstatSync(dir) rejects if dir itself is a symlink (Finding 4) | NO — only the leaf dir is checked, not ~/.epimethian or ~ | Parent check needed in addition to NOFOLLOW on the file open | MEDIUM: attacker who controls ~/.epimethian can symlink it to a world-readable location; lstat on /logs sees a real dir but the ancestor was swapped |
 * | mutations-*.jsonl (create)      | openSync "ax" mode 0o600                | O_CREAT | O_EXCL already via "ax"                    | NO (relies on dir check above) | YES — add O_NOFOLLOW to the openSync flag mask | LOW: O_EXCL prevents overwriting an attacker-planted symlink at the exact final path, but a symlinked ancestor still redirects |
 * | mutations-*.jsonl (sweep)       | readdirSync + statSync + unlinkSync     | none                                                  | NO                     | N/A (unlink by path, no fd read) | LOW: worst case is unlinking an attacker-planted file, which requires dir write access they already have |
 *
 * OS / Node.js notes on O_NOFOLLOW:
 *   - `fs.constants.O_NOFOLLOW` is defined on Linux and macOS (POSIX). It is
 *     NOT defined on Windows — guard the flag with `?? 0` so the open call
 *     still works on Windows (where symlinks require elevation and this class
 *     of attack is not the main concern).
 *   - `fs.promises.open(path, flags, mode)` accepts a numeric flag mask and
 *     returns a `FileHandle` whose `.stat()` is fstat-on-fd (not lstat on
 *     the path), which is exactly the post-open check we want.
 *   - Effect: if the final path component is a symlink, open() fails with
 *     ELOOP — no file content is ever read. Combined with fstat-on-fd for
 *     the mode-bits check, the classic stat/readFile race is closed.
 *   - O_NOFOLLOW does NOT protect ancestor directories. A separate walk of
 *     each ancestor (lstat, reject if symlink, require owner == euid,
 *     reject group/world-writable) is needed — do this once at startup and
 *     cache the result (the paths don't change during a process lifetime).
 *
 * Recommendations (to be implemented in E2):
 *   1. Introduce a `safeOpenRead(path)` helper: open with
 *      O_RDONLY | O_NOFOLLOW, fstat the fd, verify regular file + mode &
 *      0o022 === 0, then read via the FileHandle. Use from `readFullRegistry`
 *      and `readCheckState`. Removes the stat→readFile race entirely.
 *   2. Introduce a `safeOpenAppend(path)` helper using O_WRONLY | O_APPEND |
 *      O_CREAT | O_NOFOLLOW with mode 0o600. Use from `appendAuditLog` and
 *      `initMutationLog` (OR the flag onto the existing "ax" → numeric mask).
 *   3. Introduce a `verifyDirChain(dir)` helper that walks from `dir` up to
 *      `homedir()`, lstat-ing each component; reject if any is a symlink,
 *      not owned by euid, or group/world-writable. Call once at startup for
 *      both CONFIG_DIR and the mutation-log dir. Cache the result.
 *   4. Add `O_NOFOLLOW` to the mutation-log `openSync(logPath, "ax", 0o600)`
 *      call — use the numeric flag form since string mode "ax" doesn't
 *      compose with extra flags.
 *   5. Keep the `rename(tmpFile, target)` pattern — rename is atomic and a
 *      pre-flight `verifyDirChain` makes the parent-swap window negligible.
 *      Do NOT attempt `renameat2` (not available from Node).
 */

// Paths are derived from homedir() on each call (not frozen at import), so a
// test can point HOME at a temp directory. In a server or CLI process HOME
// does not change, so this is the same path every time.
function configDir(): string {
  return join(homedir(), ".config", "epimethian-mcp");
}

export function getProfileRegistryPath(): string {
  return join(configDir(), "profiles.json");
}

/** profiles.json.bak: the version before the last CLI change (D36). */
export function getProfileRegistryBackupPath(): string {
  return `${getProfileRegistryPath()}.bak`;
}

export function getAuditLogPath(): string {
  return join(configDir(), "audit.log");
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
}

// --- Registry types ---

export interface ProfileSettings {
  /**
   * @deprecated Use `posture` instead. Retained as a legacy alias:
   *   readOnly: true  → posture: "read-only"
   *   readOnly: false → posture: "read-write"
   * An explicitly-set `posture` wins over `readOnly`.
   */
  readOnly?: boolean;
  /**
   * Tri-state MCP access posture (design doc #14). Independent of the API
   * token's underlying capability — a user can pin the server to read-only
   * even when the token grants writes.
   *   "read-only"  → write tools not registered
   *   "read-write" → write tools registered
   *   "detect"     → startup probe infers from the token
   */
  posture?: "read-only" | "read-write" | "detect";
  attribution?: boolean;
  /**
   * Design doc #13 — default "AI-edited" status badge on pages the MCP
   * creates or edits. Defaults to true; set false to disable.
   */
  unverifiedStatus?: boolean;
  /** Optional override of the BCP-47 locale used for the badge label. */
  unverifiedStatusLocale?: string;
  /** Optional override of the badge label. Bypasses the locale table; must be ≤20 chars. */
  unverifiedStatusName?: string;
  /** Optional override of the badge color. Must be one of Confluence's 5 palette values. */
  unverifiedStatusColor?: "#FFC400" | "#2684FF" | "#57D9A3" | "#FF7452" | "#8777D9";
  /**
   * Track F2: per-tool allowlist. When set, only listed tools are
   * registered with the MCP server on startup. Names are validated
   * against the server's known-tool set; unknown names are rejected at
   * startup. Mutually exclusive with `denied_tools`.
   */
  allowed_tools?: string[];
  /**
   * Track F2: per-tool denylist. When set, every tool EXCEPT the listed
   * ones is registered. Mutually exclusive with `allowed_tools`.
   */
  denied_tools?: string[];
  /**
   * Track F3: per-space allowlist. When set, writes targeting a space
   * (either via `space_key` input or resolved from `page_id`) are
   * restricted to this set. Space keys are case-sensitive and must
   * match Confluence's canonical casing.
   *
   * An empty array is NOT the same as undefined: `spaces: []` rejects
   * every write (useful for paranoid no-write-anywhere profiles while
   * still allowing reads).
   */
  spaces?: string[];
  /**
   * Read scope for `search_pages` and `get_recent_changes`: when set, CQL is conjoined with
   * `space in (<these keys>)` unless the call passes `all_spaces: true`.
   * Set by editing the profile registry JSON, like `spaces`. An empty array
   * means "no space is searchable by default". Hygiene only unless
   * `read_spaces_enforced` is true, and even then it covers `search_pages`
   * and `get_recent_changes` only, not page reads.
   */
  read_spaces?: string[];
  /**
   * When true, `all_spaces: true` on `search_pages` and `get_recent_changes` is an error, so the agent
   * cannot widen the search scope. Requires `read_spaces`. Default false
   * (scope is a convenience, and the agent may widen it per call).
   *
   * This scopes `search_pages` and `get_recent_changes` ONLY. It is NOT a read boundary: `get_page`,
   * `get_page_by_title`, `list_pages`, `get_page_children`,
   * `resolve_page_link` and the version tools read any space the token can
   * see. To keep an agent out of a space, use a token without access to it.
   */
  read_spaces_enforced?: boolean;
  /**
   * Literal strings (1-200 chars each, at most 100) replaced with
   * `[redacted]` in `search_pages` titles and excerpts and in
   * `get_recent_changes` titles. Matching is
   * case-insensitive after entity decoding and Unicode normalisation. Never
   * applied to page bodies. Hygiene, not a security boundary.
   */
  redact_patterns?: string[];
}

// --- Three-state registry read and the writer core (policy gate, step 0) ---
// Contract PG-C1, doc/design/policy-gate/02-interfaces.md §1.1.

/** From lstat/fstat with { bigint: true }: nanosecond times. */
export interface FileFingerprint {
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly size: bigint;
}

/** What the last lstat saw, kept whatever the read outcome. */
export type Observation = FileFingerprint | "absent" | { readonly errno: string };

/**
 * Why the registry could not be used. Never carries file content or a
 * JSON.parse message: a parse error keeps only a line and column derived from
 * the digits of the error position. Step A adds `invalid-settings`, `removed`
 * and `anchor-unreadable`.
 */
export type UnreadableReason =
  | { readonly kind: "parse-error"; readonly line?: number; readonly column?: number }
  | { readonly kind: "unexpected-shape" }
  | {
      readonly kind: "unsafe-permissions";
      readonly target: "file" | "directory";
      readonly problem: "mode" | "owner";
    }
  | { readonly kind: "not-regular-file" }
  | { readonly kind: "io-error"; readonly errno: string };

export interface Registry {
  readonly profiles: readonly string[];
  readonly settings?: Readonly<Record<string, ProfileSettings>>;
  /** Unknown top-level keys, written back unchanged. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export type RegistryRead =
  | { readonly state: "absent"; readonly observed: Observation }
  | { readonly state: "ok"; readonly registry: Registry; readonly observed: FileFingerprint }
  | {
      readonly state: "unreadable";
      readonly reason: UnreadableReason;
      readonly path: string;
      readonly backup: string | undefined;
      readonly observed: Observation;
    };

export const REGISTRY_UNREADABLE = "REGISTRY_UNREADABLE";

export class RegistryUnreadableError extends Error {
  readonly code: typeof REGISTRY_UNREADABLE = REGISTRY_UNREADABLE;
  constructor(
    readonly reason: UnreadableReason,
    readonly path: string,
    readonly backup?: string,
  ) {
    super(`The profile registry ${path} cannot be used (${reason.kind}).`);
    this.name = "RegistryUnreadableError";
  }
}

/** `fitsAnchor` is step A; step 0 always passes `undefined`. */
export interface BackupFacts {
  readonly path: string;
  readonly fitsAnchor: boolean | undefined;
}

/** Never throws. Reads through safeOpenReadWithStat. */
export async function readRegistry(): Promise<RegistryRead> {
  return (await readRegistryWithText()).read;
}

/**
 * readRegistry plus, for an `ok` read, the exact text that was parsed. The
 * text was strictly decoded from valid UTF-8, so re-encoding it gives the
 * file's bytes back unchanged (that is what `.bak` receives).
 */
async function readRegistryWithText(): Promise<{ readonly read: RegistryRead; readonly raw?: string }> {
  const path = getProfileRegistryPath();
  try {
    let file: { readonly raw: string; readonly stat: BigIntStats };
    try {
      file = await safeOpenReadWithStat(path);
    } catch (err) {
      const reason = classifyReadError(err);
      const observed = await registryFingerprint();
      if (reason === "absent") return { read: { state: "absent", observed } };
      return { read: { state: "unreadable", reason, path, backup: await backupIfPresent(), observed } };
    }
    const observed = fingerprintOf(file.stat);
    const parsed = parseRegistryText(file.raw);
    if (!parsed.ok) {
      return {
        read: { state: "unreadable", reason: parsed.reason, path, backup: await backupIfPresent(), observed },
      };
    }
    return { read: { state: "ok", registry: parsed.registry, observed }, raw: file.raw };
  } catch {
    // Defensive: nothing above should throw; if it does, fail closed.
    return {
      read: {
        state: "unreadable",
        reason: { kind: "io-error", errno: "EUNKNOWN" },
        path,
        backup: undefined,
        observed: { errno: "EUNKNOWN" },
      },
    };
  }
}

/** One lstat (a symlink is reported, not followed). Never throws. */
export async function registryFingerprint(): Promise<Observation> {
  try {
    return fingerprintOf(await lstat(getProfileRegistryPath(), { bigint: true }));
  } catch (err) {
    const code = errnoOf(err);
    return code === "ENOENT" ? "absent" : { errno: code };
  }
}

function fingerprintOf(st: BigIntStats): FileFingerprint {
  return { ino: st.ino, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size };
}

/** True when two observations describe the same file state. */
export function sameObservation(a: Observation, b: Observation): boolean {
  if (a === "absent" || b === "absent") return a === b;
  if ("errno" in a || "errno" in b) {
    return "errno" in a && "errno" in b && a.errno === b.errno;
  }
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.size === b.size;
}

/** An errno-shaped code (EACCES, EIO, ...) or EUNKNOWN; never free text. */
function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,20}$/.test(code) ? code : "EUNKNOWN";
}

/** Maps a safeOpenReadWithStat failure to a reason; "absent" for ENOENT only. */
function classifyReadError(err: unknown): UnreadableReason | "absent" {
  if (err instanceof UnsafePathError) {
    // A symlinked directory has no kind of its own; the directory fix line
    // covers ownership and symlinks of the whole chain.
    return { kind: "unsafe-permissions", target: "directory", problem: err.problem === "mode" ? "mode" : "owner" };
  }
  const message = err instanceof Error ? err.message : "";
  if (message === "unsafe-permissions") return { kind: "unsafe-permissions", target: "file", problem: "mode" };
  if (message === "unsafe-owner") return { kind: "unsafe-permissions", target: "file", problem: "owner" };
  if (message === "not-regular-file") return { kind: "not-regular-file" };
  if (message === "invalid-utf8") return { kind: "parse-error" };
  const code = errnoOf(err);
  if (code === "ENOENT") return "absent";
  if (code === "ELOOP" || code === "EISDIR") return { kind: "not-regular-file" };
  return { kind: "io-error", errno: code };
}

async function backupIfPresent(): Promise<string | undefined> {
  const path = getProfileRegistryBackupPath();
  try {
    return (await lstat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure. Parses and shape-checks the registry text. A parse error keeps only a
 * line and column computed from the digits in the error message (and, for
 * "at position N", from counting newlines in `raw`); the message itself and
 * every byte of the text are dropped (S5).
 */
export function parseRegistryText(
  raw: string,
): { readonly ok: true; readonly registry: Registry } | { readonly ok: false; readonly reason: UnreadableReason } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: { kind: "parse-error", ...positionOf(err, raw) } };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: { kind: "unexpected-shape" } };
  const profiles = parsed.profiles;
  if (!Array.isArray(profiles) || !profiles.every((p) => typeof p === "string")) {
    return { ok: false, reason: { kind: "unexpected-shape" } };
  }
  const hasSettings = Object.hasOwn(parsed, "settings");
  const settings = parsed.settings;
  if (hasSettings && (!isPlainObject(settings) || !Object.values(settings).every(isPlainObject))) {
    return { ok: false, reason: { kind: "unexpected-shape" } };
  }
  const extra = Object.fromEntries(
    Object.entries(parsed).filter(([k]) => k !== "profiles" && k !== "settings"),
  );
  return {
    ok: true,
    registry: {
      profiles: [...(profiles as string[])],
      ...(hasSettings ? { settings: settings as Record<string, ProfileSettings> } : {}),
      extra,
    },
  };
}

function positionOf(err: unknown, raw: string): { line?: number; column?: number } {
  const message = err instanceof Error ? err.message : "";
  const lc = /\(line (\d{1,9}) column (\d{1,9})\)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /at position (\d{1,9})/.exec(message);
  if (pos) {
    const offset = Number(pos[1]);
    if (offset <= raw.length) {
      const before = raw.slice(0, offset);
      const lastNl = before.lastIndexOf("\n");
      return { line: before.split("\n").length, column: offset - lastNl };
    }
  }
  return {};
}

/** The settings of `name` from a read; throws on unreadable. Own keys only. */
export function profileSettingsOf(read: RegistryRead, name: string): ProfileSettings | undefined {
  if (read.state === "unreadable") throw new RegistryUnreadableError(read.reason, read.path, read.backup);
  if (read.state === "absent") return undefined;
  const settings = read.registry.settings;
  return settings !== undefined && Object.hasOwn(settings, name) ? settings[name] : undefined;
}

/** `~/…` for paths under the home directory, so agent-facing text names no user directory. */
function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Pure. One sentence of what is wrong, one fix line; no file content. */
export function describeUnreadable(
  r: UnreadableReason,
  path: string,
  _profile: string | null,
  backup?: BackupFacts,
): { readonly what: string; readonly fix: string } {
  const p = displayPath(path);
  const check = "then run: epimethian-mcp profiles";
  const base = ((): { what: string; fix: string } => {
    switch (r.kind) {
      case "parse-error":
        return r.line !== undefined && r.column !== undefined
          ? {
              what: `the profile registry ${p} has a JSON syntax error near line ${r.line}, column ${r.column}`,
              fix: `Fix the JSON near line ${r.line}, column ${r.column} of ${p}, ${check}`,
            }
          : { what: `the profile registry ${p} is not valid JSON`, fix: `Fix the JSON in ${p}, ${check}` };
      case "unexpected-shape":
        return {
          what: `the profile registry ${p} does not have the expected top level`,
          fix: `Fix the top level of ${p} ({"profiles": [...], "settings": {...}}), ${check}`,
        };
      case "unsafe-permissions":
        if (r.target === "directory") {
          const dir = displayPath(dirname(path));
          return {
            what:
              r.problem === "mode"
                ? `a directory holding the profile registry ${p} is group- or world-writable`
                : `a directory holding the profile registry ${p} is a symlink or owned by another user`,
            fix: `chmod 700 ${dir} and make sure you own it and every directory above it (none of them may be a symlink)`,
          };
        }
        return r.problem === "mode"
          ? { what: `the profile registry ${p} is group- or world-writable`, fix: `chmod 600 ${p}` }
          : {
              what: `the profile registry ${p} is owned by another user`,
              fix: `Replace ${p} with a copy you own (cp, then chmod 600); it is owned by another user`,
            };
      case "not-regular-file":
        return {
          what: `the profile registry ${p} is a symlink or not a regular file`,
          fix: `Replace ${p} with a regular file (it is a symlink or not a file)`,
        };
      case "io-error":
        return {
          what: `the profile registry ${p} could not be read (error ${r.errno})`,
          fix: `Check that you can read ${p} (error ${r.errno})`,
        };
    }
  })();
  if (backup === undefined) return base;
  // D36: .bak is one CLI write behind; it is not "the last good file".
  // (The step-A anchor clause, for fitsAnchor === false, is not in 7.6.1.)
  const bak = displayPath(backup.path);
  return {
    what: base.what,
    fix:
      `${base.fix}. The version before the last CLI change is ${bak}; ` +
      `it may not hold the last change, so compare it with ${p} before restoring it.`,
  };
}

/**
 * Step 0 has only kind "other" (setup, profiles flags). Step A adds
 * `{ kind: "policy"; profile }` with the keychain anchor steps.
 */
export type WriteKind = { readonly kind: "other" };

/** Code of the refusal when another CLI command holds the registry lock. */
export const REGISTRY_BUSY = "REGISTRY_BUSY";
/** Code of the refusal when the file kept changing under a write. */
export const REGISTRY_CHANGING = "REGISTRY_CHANGING";

/** A CLI registry write was refused before anything was changed. */
export class RegistryWriteRefusedError extends Error {
  constructor(
    readonly code: typeof REGISTRY_BUSY | typeof REGISTRY_CHANGING,
    message: string,
  ) {
    super(message);
    this.name = "RegistryWriteRefusedError";
  }
}

/** Retry interval, wait limit and stale age of the writer lock (02 §1.1 step 1). */
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
/** Temp files older than this were left by a crash (step 2). */
const TEMP_STALE_MS = 60 * 60 * 1000;
/** Re-applies after a detected concurrent change, on top of the first attempt (step 7). */
const MAX_REAPPLIES = 3;

/**
 * Temp names this module (and 7.6.0) creates in the config directory; the
 * sweep removes nothing else: `.profiles.json.<16 hex>.tmp` (registry),
 * `.profiles.json.bak.<16 hex>.tmp` (backup), `.profiles.<8 hex>.tmp` (7.6.0).
 */
const SWEEPABLE_TEMP = /^\.profiles(?:\.json(?:\.bak)?\.[0-9a-f]{16}|\.[0-9a-f]{8})\.tmp$/;

/** Clock, pid, liveness, sleep and stderr, injected so tests pin them. */
interface RegistryWriterEnv {
  readonly now: () => number;
  readonly pid: number;
  readonly isPidAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly warn: (message: string) => void;
  /** Test seam: runs just before the pre-rename lstat compare; `attempt` is 0-based. */
  readonly beforeCompare?: (attempt: number) => Promise<void>;
}

function defaultIsPidAlive(pid: number): boolean {
  // pid 0 and negatives address process groups in kill(2): never probe them.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DEFAULT_WRITER_ENV: RegistryWriterEnv = {
  now: () => Date.now(),
  pid: process.pid,
  isPidAlive: defaultIsPidAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn: (message) => console.error(message),
};

// Mutable on purpose: replaced only by tests (house contract _resetForTests).
let writerEnv: RegistryWriterEnv = DEFAULT_WRITER_ENV;

/** Test seam: override the writer's clock, pid, liveness, sleep, warning sink or hook. */
export function _setRegistryWriterEnvForTests(overrides: Partial<RegistryWriterEnv>): void {
  writerEnv = { ...writerEnv, ...overrides };
}

export function _resetForTests(): void {
  writerEnv = DEFAULT_WRITER_ENV;
}

export function getProfileRegistryLockPath(): string {
  return `${getProfileRegistryPath()}.lock`;
}

const EMPTY_REGISTRY: Registry = { profiles: [], extra: {} };

/** Pure. The file text for a registry: profiles, settings, then unknown keys. */
export function serializeRegistry(r: Registry): string {
  const obj = Object.fromEntries([
    ["profiles", r.profiles],
    ...(r.settings !== undefined ? [["settings", r.settings] as const] : []),
    ...Object.entries(r.extra).filter(([k]) => k !== "profiles" && k !== "settings"),
  ]);
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Thrown inside the pre-rename hook when the file is not the one that was read. */
class ChangedDuringWrite extends Error {}

interface LockToken {
  readonly ino: bigint;
}

/** Step 1: O_EXCL lock file holding pid and ISO time; 50 ms retries for up to 5 s. */
async function acquireLock(lockPath: string): Promise<LockToken> {
  const env = writerEnv;
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const start = env.now();
  for (;;) {
    let handle: FileHandle | undefined;
    try {
      handle = await fsPromises.open(lockPath, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (handle !== undefined) {
      try {
        await handle.writeFile(`${env.pid}\n${new Date(env.now()).toISOString()}\n`);
        return { ino: (await handle.stat({ bigint: true })).ino };
      } catch (err) {
        await handle.close().catch(() => {});
        handle = undefined;
        await fsPromises.unlink(lockPath).catch(() => {});
        throw err;
      } finally {
        await handle?.close();
      }
    }
    if (await removeIfStale(lockPath)) continue;
    if (env.now() - start >= LOCK_WAIT_MS) {
      throw new RegistryWriteRefusedError(
        REGISTRY_BUSY,
        "Another epimethian-mcp command is changing the profile registry. Try again in a moment; nothing was changed.",
      );
    }
    await env.sleep(LOCK_RETRY_MS);
  }
}

/** The pid on the lock's first line, or undefined (unparseable, unreadable, not a file). */
async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const handle = await fsPromises.open(
      lockPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
      const first = buffer.subarray(0, bytesRead).toString("latin1").split("\n")[0] ?? "";
      return /^[1-9][0-9]{0,9}$/.test(first) ? Number(first) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Removes a lock older than 60 s whose pid is not alive (an unparseable pid
 * counts as not alive). A live pid, even a reused one, is never removed. The
 * lock is re-lstat'ed just before the unlink and left alone if it changed.
 * Returns true when the caller should retry at once (removed, or gone).
 */
async function removeIfStale(lockPath: string): Promise<boolean> {
  const env = writerEnv;
  let seen: BigIntStats;
  try {
    seen = await fsPromises.lstat(lockPath, { bigint: true });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  const ageMs = env.now() - Number(seen.mtimeNs / 1_000_000n);
  if (ageMs <= LOCK_STALE_MS) return false;
  const pid = await readLockPid(lockPath);
  if (pid !== undefined && env.isPidAlive(pid)) return false;
  try {
    const again = await fsPromises.lstat(lockPath, { bigint: true });
    if (again.ino !== seen.ino || again.mtimeNs !== seen.mtimeNs) return false;
    await fsPromises.unlink(lockPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  env.warn(
    `epimethian-mcp: removed a stale lock ${displayPath(lockPath)} ` +
      `(left by process ${pid ?? "unknown"}, which is no longer running).`,
  );
  return true;
}

/** Released in `finally`; only our own lock (same inode) is removed. */
async function releaseLock(lockPath: string, token: LockToken): Promise<void> {
  try {
    const st = await fsPromises.lstat(lockPath, { bigint: true });
    if (st.ino === token.ino) await fsPromises.unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      writerEnv.warn(`epimethian-mcp: could not remove the lock ${displayPath(lockPath)} (${errnoOf(err)}).`);
    }
  }
}

/** Step 2: removes our own temp names older than one hour (left by a crash). */
async function sweepStaleTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsPromises.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!SWEEPABLE_TEMP.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = await fsPromises.lstat(path);
      if (st.isFile() && writerEnv.now() - st.mtimeMs > TEMP_STALE_MS) await fsPromises.unlink(path);
    } catch {
      // Gone already, or not ours to touch: leave it.
    }
  }
}

/**
 * The writer core. Steps (02 §1.1; the anchor steps 4, 5 and 8 are step A):
 *   1. mkdir + verifyDirChain(config dir); take profiles.json.lock.
 *   2. Sweep our temp files older than one hour.
 *   3. Read. Unreadable → RegistryUnreadableError before any temp file;
 *      absent → start from {profiles: []}, .bak untouched (D36).
 *   4. next = change(prev). `undefined` (internal callers) or `prev` itself
 *      means "no change": nothing is written.
 *   6. ok read: its exact bytes → profiles.json.bak (safeAtomicWrite).
 *   7. next → profiles.json (safeAtomicWrite); just before the rename one
 *      lstat is compared with the step-3 observation. A difference (hand
 *      edit, or a writer that ignored the lock) removes the temp and repeats
 *      from step 3, at most three times, then refuses.
 * The lock is released in `finally`.
 */
async function commitRegistryChange(
  change: (prev: Registry | undefined) => Registry | undefined,
): Promise<{ readonly before: Registry | undefined; readonly after: Registry | undefined; readonly written: boolean }> {
  const dir = configDir();
  const path = getProfileRegistryPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await verifyDirChain(dir);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      throw new RegistryUnreadableError(
        { kind: "unsafe-permissions", target: "directory", problem: err.problem === "mode" ? "mode" : "owner" },
        path,
        await backupIfPresent(),
      );
    }
    throw err;
  }
  const lockPath = getProfileRegistryLockPath();
  const token = await acquireLock(lockPath);
  try {
    await sweepStaleTemps(dir);
    for (let attempt = 0; ; attempt++) {
      const { read, raw } = await readRegistryWithText();
      if (read.state === "unreadable") throw new RegistryUnreadableError(read.reason, read.path, read.backup);
      const prev = read.state === "ok" ? read.registry : undefined;
      const next = change(prev);
      if (next === undefined || next === prev) return { before: prev, after: prev, written: false };
      const text = serializeRegistry(next);
      // A change function must produce a registry this module can read back.
      if (!parseRegistryText(text).ok) throw new Error("internal error: the new profile registry would be unreadable");
      if (read.state === "ok" && raw !== undefined) {
        await safeAtomicWrite(getProfileRegistryBackupPath(), raw);
      }
      try {
        await safeAtomicWrite(path, text, {
          beforeRename: async () => {
            await writerEnv.beforeCompare?.(attempt);
            if (!sameObservation(await registryFingerprint(), read.observed)) throw new ChangedDuringWrite();
          },
        });
        return { before: prev, after: next, written: true };
      } catch (err) {
        if (!(err instanceof ChangedDuringWrite)) throw err;
        if (attempt >= MAX_REAPPLIES) {
          throw new RegistryWriteRefusedError(
            REGISTRY_CHANGING,
            `The profile registry ${displayPath(path)} kept changing while saving; nothing was changed. ` +
              "Try again when no editor is saving it.",
          );
        }
      }
    }
  } finally {
    await releaseLock(lockPath, token);
  }
}

/** The one writer core (D12). Every exported writer calls it. Returning `prev` writes nothing. */
export async function writeWithAnchor(
  change: (prev: Registry | undefined) => Registry,
  _how: WriteKind,
): Promise<{ readonly before: Registry | undefined; readonly after: Registry }> {
  const { before, after } = await commitRegistryChange(change);
  // after is undefined only when change(undefined) returned undefined, which its type forbids.
  return { before, after: after ?? EMPTY_REGISTRY };
}

/** Pure. `settings` with `name` set to `value` (in place, keeping key order) or removed. */
function withProfileSettings(
  settings: Readonly<Record<string, ProfileSettings>> | undefined,
  name: string,
  value: ProfileSettings | undefined,
): Readonly<Record<string, ProfileSettings>> | undefined {
  const entries = Object.entries(settings ?? {});
  const kept = entries
    .filter(([k]) => !(k === name && value === undefined))
    .map(([k, v]) => [k, k === name ? (value as ProfileSettings) : v] as const);
  const present = entries.some(([k]) => k === name);
  const all = present || value === undefined ? kept : [...kept, [name, value] as const];
  // Object.fromEntries defines own properties, so a "__proto__" key stays a key.
  return all.length === 0 ? undefined : Object.fromEntries(all);
}

function withSettings(r: Registry, settings: Readonly<Record<string, ProfileSettings>> | undefined): Registry {
  return settings === undefined
    ? { profiles: r.profiles, extra: r.extra }
    : { profiles: r.profiles, settings, extra: r.extra };
}

/** Whole-value replacement; returning undefined removes the profile's settings entry. */
export async function updateProfileSettings(
  name: string,
  fn: (prev: ProfileSettings | undefined) => ProfileSettings | undefined,
  _how: WriteKind = { kind: "other" },
): Promise<{ readonly before: ProfileSettings | undefined; readonly after: ProfileSettings | undefined }> {
  // Reassigned on each attempt; the values of the attempt that committed are returned.
  let before: ProfileSettings | undefined;
  let after: ProfileSettings | undefined;
  await commitRegistryChange((prev) => {
    const base = prev ?? EMPTY_REGISTRY;
    before = base.settings !== undefined && Object.hasOwn(base.settings, name) ? base.settings[name] : undefined;
    after = fn(before);
    if (after === before) return prev;
    return withSettings(base, withProfileSettings(base.settings, name, after));
  });
  return { before, after };
}

/** Throws RegistryUnreadableError when unreadable; used by CLI preflights. */
export async function assertRegistryWritable(): Promise<void> {
  const read = await readRegistry();
  if (read.state === "unreadable") throw new RegistryUnreadableError(read.reason, read.path, read.backup);
}

/**
 * Read the list of known profile names from the registry.
 * Returns [] if the file is absent; throws RegistryUnreadableError if it
 * cannot be used (never treats a broken file as empty).
 */
export async function readProfileRegistry(): Promise<string[]> {
  const read = await readRegistry();
  if (read.state === "unreadable") throw new RegistryUnreadableError(read.reason, read.path, read.backup);
  return read.state === "ok" ? [...read.registry.profiles] : [];
}

/**
 * Get settings for a specific profile (own keys only: a profile named
 * "constructor" is not found through Object.prototype).
 * Returns undefined if the profile has no settings, is unknown, or the file
 * is absent; throws RegistryUnreadableError if it cannot be used.
 */
export async function getProfileSettings(
  name: string
): Promise<ProfileSettings | undefined> {
  return profileSettingsOf(await readRegistry(), name);
}

/** Shallow merge into the profile's settings, as in 7.6.0. Through the writer core. */
export async function setProfileSettings(
  name: string,
  settings: ProfileSettings
): Promise<void> {
  await updateProfileSettings(name, (prev) => ({ ...prev, ...settings }));
}

/** Add a profile name to the registry (idempotent: no write when present). */
export async function addToProfileRegistry(name: string): Promise<void> {
  await commitRegistryChange((prev) => {
    const base = prev ?? EMPTY_REGISTRY;
    if (base.profiles.includes(name)) return prev;
    return { ...base, profiles: [...base.profiles, name] };
  });
}

/** Remove a profile name and its settings entry (no write when not listed). */
export async function removeFromProfileRegistry(name: string): Promise<void> {
  await commitRegistryChange((prev) => {
    if (prev === undefined || !prev.profiles.includes(name)) return prev;
    return withSettings(
      { ...prev, profiles: prev.profiles.filter((p) => p !== name) },
      withProfileSettings(prev.settings, name, undefined),
    );
  });
}

/**
 * Append an audit log entry for profile removal.
 */
export async function appendAuditLog(message: string): Promise<void> {
  await ensureConfigDir();
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  // E2: use safeOpenAppend so the file is opened with O_NOFOLLOW. Refuses to
  // follow a symlink planted at AUDIT_LOG that would otherwise redirect
  // audit-log entries to an attacker-controlled file.
  await safeOpenAppend(getAuditLogPath(), entry);
}
