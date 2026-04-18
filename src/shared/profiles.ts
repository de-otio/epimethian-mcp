import { readFile, writeFile, rename, mkdir, chmod, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { safeOpenRead, safeOpenAppend } from "./safe-fs.js";

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

const CONFIG_DIR = join(homedir(), ".config", "epimethian-mcp");
const REGISTRY_FILE = join(CONFIG_DIR, "profiles.json");
const AUDIT_LOG = join(CONFIG_DIR, "audit.log");

export function getProfileRegistryPath(): string {
  return REGISTRY_FILE;
}

export function getAuditLogPath(): string {
  return AUDIT_LOG;
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

// --- Registry types ---

export interface ProfileSettings {
  readOnly?: boolean;
  attribution?: boolean;
}

interface ProfileRegistry {
  profiles: string[];
  settings?: Record<string, ProfileSettings>;
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
    const raw = await safeOpenRead(REGISTRY_FILE);
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
          `Run: chmod 600 ${REGISTRY_FILE}`
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
          REGISTRY_FILE +
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
    CONFIG_DIR,
    `.profiles.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, REGISTRY_FILE);
}

/**
 * Read the list of known profile names from the registry.
 * Returns [] if the file is missing or corrupted (with a warning to stderr).
 */
export async function readProfileRegistry(): Promise<string[]> {
  const registry = await readFullRegistry();
  return registry.profiles;
}

/**
 * Get settings for a specific profile.
 * Returns undefined if the profile has no settings or is unknown.
 */
export async function getProfileSettings(
  name: string
): Promise<ProfileSettings | undefined> {
  const registry = await readFullRegistry();
  return registry.settings?.[name];
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
  await safeOpenAppend(AUDIT_LOG, entry);
}
