/**
 * Filesystem helpers that close the TOCTOU window on security-sensitive
 * reads/writes under `~/.config/epimethian-mcp/` and `~/.epimethian/logs/`.
 *
 * Track E2 of `plans/security-audit-fixes.md`. The audit memo at the top of
 * `profiles.ts` enumerates every affected code path and the exact guard each
 * needed.
 *
 * Design:
 * - `safeOpenRead(path)` opens with `O_RDONLY | O_NOFOLLOW`, then fstats the
 *   resulting fd. A mid-op swap of `path` for a symlink cannot change the
 *   inode behind the fd — so the stat/read race is closed.
 * - `verifyDirChain(dir)` walks from `dir` up to the user's home, lstating
 *   each component. Rejects if any ancestor is a symlink, not owned by the
 *   current euid, or group/world-writable. This closes the parent-swap
 *   window that `O_NOFOLLOW` alone does not cover.
 *
 * Both helpers treat Windows pragmatically: `O_NOFOLLOW` is absent, and
 * symlinks require elevation to create, so this class of attack is not the
 * primary concern on that platform. The helpers no-op or degrade gracefully.
 */

import { promises as fsPromises, constants as fsConstants, type BigIntStats } from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// `O_NOFOLLOW` is POSIX. Fall back to 0 on Windows so the open call still
// succeeds — we accept that symlink protection is POSIX-only.
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK: number = fsConstants.O_NONBLOCK ?? 0;

/** A directory in the chain is a symlink, owned by someone else, or group/world-writable. */
export class UnsafePathError extends Error {
  constructor(
    readonly problem: "symlink" | "owner" | "mode",
    readonly dir: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Read a file whose contents must not be mutated behind our back between
 * the permission check and the content read.
 *
 * Opens `path` with `O_RDONLY | O_NOFOLLOW`, fstats the resulting fd (so the
 * mode bits apply to the exact inode we will read from), and returns its
 * contents as a UTF-8 string. Callers still need to wrap this in `try/catch`
 * for ENOENT / permission errors.
 *
 * Throws:
 *   - ELOOP if `path` itself is a symlink.
 *   - ENOENT if the file doesn't exist.
 *   - Error("unsafe-permissions") if mode bits are group- or world-writable.
 *   - Error("not-regular-file") if fstat reports a non-regular file (e.g.
 *     a FIFO or device node planted by an attacker).
 */
export async function safeOpenRead(path: string): Promise<string> {
  const handle = await fsOpen(
    path,
    fsConstants.O_RDONLY | O_NOFOLLOW
  );
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new Error("not-regular-file");
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error("unsafe-permissions");
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Like `safeOpenRead`, plus: the file's owner uid equals the euid, and
 * `verifyDirChain(dirname(path))` passes. Returns the raw text and the fstat
 * of the fd that was read (`{ bigint: true }`, nanosecond times).
 *
 * Errors: Error("unsafe-permissions") (mode), Error("unsafe-owner"),
 * UnsafePathError (directory chain, message starts "unsafe-path"),
 * Error("not-regular-file"), ELOOP, ENOENT, others by errno.
 */
export async function safeOpenReadWithStat(
  path: string,
): Promise<{ readonly raw: string; readonly stat: BigIntStats }> {
  await verifyDirChain(dirname(path));
  // O_NONBLOCK: a FIFO planted at `path` must not hang the open; it is then
  // rejected by the isFile() check. No effect on regular files.
  const handle = await fsPromises.open(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) throw new Error("not-regular-file");
    if ((st.mode & 0o022n) !== 0n) throw new Error("unsafe-permissions");
    const euid = currentEuid();
    if (euid !== undefined && st.uid !== BigInt(euid)) throw new Error("unsafe-owner");
    const bytes = await handle.readFile();
    let raw: string;
    try {
      // Strict: a lenient decode would turn a bad byte into U+FFFD, the text
      // would parse, and the next write would silently replace the user's
      // bytes. ignoreBOM keeps a BOM in the text, as readFile("utf-8") does.
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("invalid-utf8");
    }
    return { raw, stat: st };
  } finally {
    await handle.close();
  }
}

/** euid, or undefined where there is none (Windows, worker threads). */
function currentEuid(): number | undefined {
  if (process.platform === "win32") return undefined;
  const geteuid = (process as { geteuid?: () => number }).geteuid;
  return typeof geteuid === "function" ? geteuid.call(process) : undefined;
}

/** Injectable for tests: temp-name randomness and the stderr warning. */
interface SafeFsHooks {
  readonly randomHex: () => string;
  readonly warn: (message: string) => void;
}

const DEFAULT_HOOKS: SafeFsHooks = {
  randomHex: () => randomBytes(8).toString("hex"),
  warn: (message) => console.error(message),
};

// Mutable on purpose: the only module state, replaced only by tests.
let hooks: SafeFsHooks = DEFAULT_HOOKS;

/** Test seam: override temp-name randomness and/or the warning sink. */
export function _setSafeFsHooksForTests(overrides: Partial<SafeFsHooks>): void {
  hooks = { ...hooks, ...overrides };
}

export function _resetForTests(): void {
  hooks = DEFAULT_HOOKS;
}

/** At most this many temp names are tried when one already exists. */
const TEMP_NAME_TRIES = 3;

/**
 * Atomic, durable write: temp file `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600
 * in the same directory; write; fsync(fd); rename; fsync(dir) best effort
 * (skipped on Windows; elsewhere a failure after a successful rename is a
 * warning on stderr, not a write failure, D30). Removes the temp on any
 * failure.
 *
 * The temp is `.<basename>.<16 hex>.tmp`. An existing file or symlink at a
 * temp name is never opened (O_EXCL): another random name is tried, at most
 * three in all. The caller verifies the directory chain.
 */
export async function safeAtomicWrite(
  path: string,
  bytes: string | Uint8Array,
  opts: SafeAtomicWriteOptions = {},
): Promise<void> {
  const prepared = await prepareAtomicWrite(path, bytes);
  try {
    if (opts.beforeRename) await opts.beforeRename();
  } catch (err) {
    await prepared.abort();
    throw err;
  }
  await prepared.commit();
  await syncDirBestEffort(dirname(path), path);
}

/** A complete, fsynced temp file waiting to be renamed onto its target. */
export interface PreparedWrite {
  /** rename(temp, target); on failure the temp is removed and the error propagates.
   *  No directory fsync: the caller's next safeAtomicWrite in the same directory
   *  (or its own syncDir) flushes the directory. */
  readonly commit: () => Promise<void>;
  /** Removes the temp; the target is untouched. Never throws. */
  readonly abort: () => Promise<void>;
}

/**
 * First half of safeAtomicWrite: temp `.<name>.<16 hex>.tmp` opened
 * O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600, written and fsynced. The target is
 * not touched until `commit`. Used where one rename must happen only once
 * another write is certain (the registry's .bak).
 */
export async function prepareAtomicWrite(path: string, bytes: string | Uint8Array): Promise<PreparedWrite> {
  const { handle, tmp } = await openFreshTemp(dirname(path), basename(path));
  try {
    try {
      // writeFile loops until the buffer is drained (see safeWriteFile).
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => {});
    throw err;
  }
  const abort = async (): Promise<void> => {
    await fsPromises.unlink(tmp).catch(() => {});
  };
  return {
    abort,
    commit: async () => {
      try {
        await fsPromises.rename(tmp, path);
      } catch (err) {
        await abort();
        throw err;
      }
    },
  };
}

async function openFreshTemp(
  dir: string,
  base: string,
): Promise<{ readonly handle: FileHandle; readonly tmp: string }> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
  for (let attempt = 1; ; attempt++) {
    const tmp = join(dir, `.${base}.${hooks.randomHex()}.tmp`);
    try {
      return { handle: await fsPromises.open(tmp, flags, 0o600), tmp };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < TEMP_NAME_TRIES) continue;
      throw err;
    }
  }
}

/** D30: after a successful rename a directory fsync failure only warns. */
async function syncDirBestEffort(dir: string, path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const dh = await fsPromises.open(dir, fsConstants.O_RDONLY);
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    hooks.warn(
      `epimethian-mcp: warning: ${path} was saved, but flushing its directory failed (${code}); ` +
        "the change may not survive a power loss.",
    );
  }
}

export interface SafeAtomicWriteOptions {
  /** Runs after the temp file is complete and fsynced, just before the
   *  rename. A throw aborts the write: the temp is removed, the target is
   *  untouched, and the error propagates. */
  readonly beforeRename?: () => Promise<void>;
}

/**
 * Append `data` (UTF-8) to `path`, creating it with mode 0o600 if missing.
 *
 * Opens with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`. Refuses to
 * follow a symlink planted at `path` — an attacker cannot redirect
 * audit-log entries to a world-readable location by race-creating a link.
 */
export async function safeOpenAppend(path: string, data: string): Promise<void> {
  const handle = await fsOpen(
    path,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW,
    0o600
  );
  try {
    // Pass position: null so the kernel uses the fd's current offset. With
    // O_APPEND that means "end of file" — atomically, even under concurrent
    // writers. Using an explicit position (e.g. 0) would instead seek and
    // overwrite.
    await handle.write(data, null, "utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Find the first `.`-prefixed path segment of `path` below `root`
 * (`.git`, `.claude`, `.github`, `.vscode`, `.env`, ...), or `undefined` when
 * there is none. Pure; no filesystem access.
 *
 * Segments are taken relative to `root`, so a project that itself lives under
 * a dot-directory (a worktree at `.claude/worktrees/x`) is not refused for it.
 * A path outside `root` is reported as its first `..` segment, so a caller
 * that forgot the containment check still fails closed.
 *
 * Why this exists: a downloaded attachment is attacker-influenced content, and
 * dot-directories and dot-files are where tools look for configuration and
 * hooks (`.git/hooks`, `.claude/settings.json`, `.vscode/tasks.json`,
 * `.github/workflows`). Writing there turns a download into code execution.
 */
export function findDotSegment(path: string, root: string): string | undefined {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "") return undefined;
  if (isAbsolute(rel)) return rel; // different drive/root: fail closed
  for (const segment of rel.split(sep)) {
    if (segment === ".." || segment.startsWith(".")) return segment;
  }
  return undefined;
}

/**
 * Write `data` to `path` without ever following a symlink at the final
 * component.
 *
 * Opens with `O_WRONLY | O_CREAT | O_NOFOLLOW`, plus `O_EXCL` unless
 * `overwrite` is set (in which case `O_TRUNC`). The `O_NOFOLLOW` applies to
 * `path` itself, so a symlink planted at the destination cannot redirect the
 * write to a target elsewhere on disk — it fails with `ELOOP` instead. Callers
 * are still responsible for validating the *parent* directory (see
 * `verifyDirChain`, or a `realpath` containment check).
 *
 * Never produces an executable file: a new file is created `0o600`, and when
 * `overwrite` replaces an existing file, any execute, setuid, setgid or sticky
 * bits it had are cleared, so downloaded bytes cannot inherit "runnable".
 *
 * Throws:
 *   - EEXIST when the destination exists and `overwrite` is not set.
 *   - ELOOP when `path` is a symlink.
 */
export async function safeWriteFile(
  path: string,
  data: Uint8Array,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    O_NOFOLLOW |
    (opts.overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
  const handle = await fsOpen(path, flags, 0o600);
  try {
    if (opts.overwrite && process.platform !== "win32") {
      // The mode argument to open() only applies to a newly created file, so
      // an overwritten file keeps whatever it had. Strip the executable bits.
      const { mode } = await handle.stat();
      if ((mode & 0o7111) !== 0) {
        await handle.chmod(mode & 0o666);
      }
    }
    // `writeFile` on the handle, not `write`: a raw `write(2)` may complete
    // having written fewer bytes than requested, and a single unchecked call
    // would leave a silently truncated file that the caller reports as a
    // success. `FileHandle.writeFile` loops until the buffer is drained.
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Walk from `dir` upwards, lstat-ing each ancestor up to (and including) the
 * `stopAt` boundary. Throws if any ancestor is a symlink, not owned by the
 * current euid, or group/world-writable.
 *
 * `stopAt` defaults to the user's home directory. Paths that are not under
 * `stopAt` walk to the filesystem root (e.g. CI tempdirs that live in
 * `/tmp` outside of `$HOME`); callers who want a narrower boundary should
 * pass one explicitly.
 *
 * Intended to run once at startup for long-lived paths (`CONFIG_DIR`,
 * mutation-log dir). The result is not cached here — callers are expected
 * to do their own memoisation if they need it.
 *
 * Skips on Windows and when `process.geteuid` is undefined (e.g. worker
 * threads, older Node): there's no reliable owner check without it.
 */
export async function verifyDirChain(
  dir: string,
  stopAt: string = homedir(),
): Promise<void> {
  if (process.platform === "win32") return;
  const geteuid = (process as any).geteuid as (() => number) | undefined;
  if (typeof geteuid !== "function") return;
  const euid = geteuid.call(process);
  const stop = resolve(stopAt);
  let current = resolve(dir);

  let previous = "";
  while (current !== previous) {
    let st;
    try {
      st = await fsPromises.lstat(current);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Not yet created — skip, but keep climbing so ancestors are still
        // verified. Once the caller's mkdir runs with a safe mode, a later
        // call to verifyDirChain will cover this rung.
        previous = current;
        current = dirname(current);
        continue;
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      throw new UnsafePathError("symlink", current, `unsafe-path: symlink at ${current}`);
    }
    if (st.uid !== euid) {
      throw new UnsafePathError(
        "owner",
        current,
        `unsafe-path: ${current} is not owned by the current user (uid ${st.uid} vs euid ${euid})`
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw new UnsafePathError(
        "mode",
        current,
        `unsafe-path: ${current} is group- or world-writable (mode ${(st.mode & 0o777).toString(8)})`
      );
    }

    if (current === stop) break;
    previous = current;
    current = dirname(current);
  }
}

/** Re-export so callers can test O_NOFOLLOW availability. */
export const SAFE_FS_HAS_O_NOFOLLOW = O_NOFOLLOW !== 0;
