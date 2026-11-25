import { writeFile, rename, mkdir, lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { safeOpenRead, safeOpenAppend, safeOpenReadWithStat, UnsafePathError } from "./safe-fs.js";

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

interface ProfileRegistry {
  profiles: string[];
  settings?: Record<string, ProfileSettings>;
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
  const path = getProfileRegistryPath();
  try {
    let read: { readonly raw: string; readonly stat: BigIntStats };
    try {
      read = await safeOpenReadWithStat(path);
    } catch (err) {
      const reason = classifyReadError(err);
      const observed = await registryFingerprint();
      if (reason === "absent") return { state: "absent", observed };
      return { state: "unreadable", reason, path, backup: await backupIfPresent(), observed };
    }
    const observed = fingerprintOf(read.stat);
    const parsed = parseRegistryText(read.raw);
    if (!parsed.ok) {
      return { state: "unreadable", reason: parsed.reason, path, backup: await backupIfPresent(), observed };
    }
    return { state: "ok", registry: parsed.registry, observed };
  } catch {
    // Defensive: nothing above should throw; if it does, fail closed.
    return {
      state: "unreadable",
      reason: { kind: "io-error", errno: "EUNKNOWN" },
      path,
      backup: undefined,
      observed: { errno: "EUNKNOWN" },
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

/** The one writer core (D12). Every exported writer calls it. */
export async function writeWithAnchor(
  _change: (prev: Registry | undefined) => Registry,
  _how: WriteKind,
): Promise<{ readonly before: Registry | undefined; readonly after: Registry }> {
  throw new Error("not implemented");
}

/** Whole-value replacement; returning undefined removes the profile's settings entry. */
export async function updateProfileSettings(
  _name: string,
  _fn: (prev: ProfileSettings | undefined) => ProfileSettings | undefined,
  _how?: WriteKind,
): Promise<{ readonly before: ProfileSettings | undefined; readonly after: ProfileSettings | undefined }> {
  throw new Error("not implemented");
}

/** Throws RegistryUnreadableError when unreadable; used by CLI preflights. */
export async function assertRegistryWritable(): Promise<void> {
  const read = await readRegistry();
  if (read.state === "unreadable") throw new RegistryUnreadableError(read.reason, read.path, read.backup);
}

/**
 * Read the full registry object from disk.
 * Returns a default empty registry if the file is missing or corrupted.
 */
async function readFullRegistry(): Promise<ProfileRegistry> {
  try {
    // E2 — TOCTOU-safe read: safeOpenRead opens with O_NOFOLLOW, fstats the
    // resulting fd (so the mode check applies to the exact inode we will read),
    // and rejects symlinks / non-regular files / group- or world-writable
    // modes. Replaces the previous stat→readFile two-syscall pattern.
    const raw = await safeOpenRead(getProfileRegistryPath());
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.profiles) &&
      parsed.profiles.every((p: unknown) => typeof p === "string")
    ) {
      return {
        profiles: parsed.profiles as string[],
        settings: parsed.settings ?? undefined,
      };
    }
    console.error(
      "Warning: Profile registry has unexpected format. Treating as empty."
    );
    return { profiles: [] };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { profiles: [] }; // File doesn't exist yet
    }
    // safeOpenRead reports these with string messages (no Node errno).
    if (err instanceof Error && err.message === "unsafe-permissions") {
      console.error(
        "Error: Profile registry has unsafe permissions (group/world-writable). " +
          `Run: chmod 600 ${getProfileRegistryPath()}`
      );
      return { profiles: [] };
    }
    if (err instanceof Error && err.message === "not-regular-file") {
      console.error(
        "Error: Profile registry is not a regular file (possible symlink or device). Refusing to read."
      );
      return { profiles: [] };
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      console.error(
        "Error: Profile registry appears to be a symlink. Refusing to follow; " +
          "remove the symlink or restore the file with `chmod 600 " +
          getProfileRegistryPath() +
          "`."
      );
      return { profiles: [] };
    }
    console.error("Warning: Could not read profile registry. Treating as empty.");
    return { profiles: [] };
  }
}

/** Atomic write of the full registry to disk. */
async function writeRegistry(registry: ProfileRegistry): Promise<void> {
  await ensureConfigDir();
  const data = JSON.stringify(registry, null, 2) + "\n";
  const tmpFile = join(
    configDir(),
    `.profiles.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, getProfileRegistryPath());
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

/**
 * Set settings for a specific profile (merge with existing).
 */
export async function setProfileSettings(
  name: string,
  settings: ProfileSettings
): Promise<void> {
  const registry = await readFullRegistry();
  if (!registry.settings) {
    registry.settings = {};
  }
  registry.settings[name] = { ...registry.settings[name], ...settings };
  await writeRegistry(registry);
}

/**
 * Add a profile name to the registry (idempotent).
 * Uses atomic write (write to temp file, then rename).
 */
export async function addToProfileRegistry(name: string): Promise<void> {
  await ensureConfigDir();
  const registry = await readFullRegistry();
  if (registry.profiles.includes(name)) return; // Already registered
  registry.profiles.push(name);
  await writeRegistry(registry);
}

/**
 * Remove a profile name from the registry.
 */
export async function removeFromProfileRegistry(name: string): Promise<void> {
  const registry = await readFullRegistry();
  const filtered = registry.profiles.filter((p) => p !== name);
  if (filtered.length === registry.profiles.length) return; // Wasn't in the list
  registry.profiles = filtered;
  // Clean up settings for removed profile
  if (registry.settings) {
    delete registry.settings[name];
    if (Object.keys(registry.settings).length === 0) {
      delete registry.settings;
    }
  }
  await writeRegistry(registry);
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
