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

import { promises as fsPromises, constants as fsConstants } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// `O_NOFOLLOW` is POSIX. Fall back to 0 on Windows so the open call still
// succeeds — we accept that symlink protection is POSIX-only.
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

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
      throw new Error(`unsafe-path: symlink at ${current}`);
    }
    if (st.uid !== euid) {
      throw new Error(
        `unsafe-path: ${current} is not owned by the current user (uid ${st.uid} vs euid ${euid})`
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(
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
