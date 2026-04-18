/**
 * Write-ahead mutation log for forensics and recovery.
 *
 * Appends a JSON record to a local JSONL file for every write operation.
 * Survives process crashes. Enables forensics and automated rollback.
 *
 * Security hardening (per design review):
 * - Directory created with mode 0o700 (owner-only)
 * - Files written with mode 0o600 (owner-only read/write)
 * - Symlink checks on the log directory (Finding 4)
 * - Page titles NOT logged to avoid cross-tenant metadata leakage (Finding 5)
 * - Error messages sanitized to prevent body content leakage (Finding 5)
 * - Startup sweep deletes log files older than 30 days (Finding 12)
 */

import {
  appendFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface MutationRecord {
  timestamp: string;
  operation:
    | "create_page"
    | "update_page"
    | "delete_page"
    | "prepend_to_page"
    | "append_to_page"
    | "revert_page"
    | "add_drawio_diagram";
  pageId: string;
  oldVersion?: number;
  newVersion?: number;
  oldBodyLen?: number;
  newBodyLen?: number;
  /** SHA-256 hash of the old body (for integrity verification without storing content). */
  oldBodyHash?: string;
  /** SHA-256 hash of the new body (for integrity verification without storing content). */
  newBodyHash?: string;
  /** MCP client label (e.g. "Claude Code", "Cursor") — identifies which agent made the change. */
  clientLabel?: string;
  replaceBody?: boolean;
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
  error?: string;
}

const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ERROR_LEN = 200;

/**
 * Compute a SHA-256 hash of a body string. Returns the first 16 hex chars
 * (64 bits) — enough for integrity verification without bloating logs.
 * Safe to log: no reverse mapping to content (Finding 5 compliant).
 */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

let logPath: string | null = null;
let logFd: number | null = null;

/**
 * Sanitize an error message to prevent leaking page body content.
 * Truncates to MAX_ERROR_LEN and strips anything after a newline.
 */
function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const firstLine = msg.split("\n")[0]!;
  return firstLine.length > MAX_ERROR_LEN
    ? firstLine.slice(0, MAX_ERROR_LEN) + "..."
    : firstLine;
}

/**
 * Delete log files older than 30 days.
 */
function sweepOldLogs(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("mutations-") || !name.endsWith(".jsonl")) continue;
      const filePath = join(dir, name);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_LOG_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
  } catch {
    // Non-critical — don't break startup for cleanup failures
  }
}

/**
 * Initialize the mutation log. Call once at server startup.
 * @param dir — directory for log files (e.g., ~/.epimethian/logs/)
 */
export function initMutationLog(dir: string): void {
  // Create directory with owner-only permissions
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Verify the directory is not a symlink (Finding 4)
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Mutation log directory ${dir} is a symlink — refusing to write. ` +
          `Remove the symlink and restart.`,
      );
    }
  }

  // Sweep old log files on startup (Finding 12)
  sweepOldLogs(dir);

  // One log file per server process, named by start time
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  logPath = join(dir, `mutations-${ts}.jsonl`);

  // Open with exclusive create + append + owner-only perms (Finding 4)
  try {
    logFd = openSync(logPath, "ax", 0o600);
  } catch {
    // If the file already exists (unlikely with timestamp), fall back
    logFd = openSync(logPath, "a", 0o600);
  }
}

/**
 * Append a mutation record. Synchronous to ensure the record
 * is flushed before the API response is returned to the caller.
 */
export function logMutation(record: MutationRecord): void {
  if (logFd === null) return; // Logging not initialized (tests, etc.)
  try {
    const line = JSON.stringify(record) + "\n";
    writeSync(logFd, line);
  } catch {
    // Non-critical — don't break the write operation for a log failure.
  }
}

/**
 * Build a MutationRecord for an error case with sanitized error message.
 */
export function errorRecord(
  operation: MutationRecord["operation"],
  pageId: string,
  err: unknown,
  extra?: Partial<MutationRecord>,
): MutationRecord {
  return {
    timestamp: new Date().toISOString(),
    operation,
    pageId,
    error: sanitizeErrorMessage(err),
    ...extra,
  };
}

/**
 * Close the log file descriptor. For use in tests and cleanup.
 */
export function closeMutationLog(): void {
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // Ignore
    }
    logFd = null;
    logPath = null;
  }
}

/**
 * Return the current log path. For use in tests.
 */
export function getLogPath(): string | null {
  return logPath;
}
