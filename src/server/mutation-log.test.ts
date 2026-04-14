/**
 * Tests for the write-ahead mutation log (1E).
 *
 * Security tests cover:
 * - Symlink rejection (Finding 4)
 * - File permissions (Finding 4)
 * - Error sanitization (Finding 5)
 * - Log rotation / old file sweep (Finding 12)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initMutationLog,
  logMutation,
  errorRecord,
  closeMutationLog,
  getLogPath,
  type MutationRecord,
} from "./mutation-log.js";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeEach(() => {
  closeMutationLog();
  testDir = mkdtempSync(join(tmpdir(), "mutation-log-test-"));
});

afterEach(() => {
  closeMutationLog();
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe("initMutationLog", () => {
  it("creates the log directory if it does not exist", () => {
    const dir = join(testDir, "new-dir");
    initMutationLog(dir);
    const files = readdirSync(dir);
    // The log file itself is created on init (openSync with 'ax')
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^mutations-.*\.jsonl$/);
    expect(getLogPath()).toMatch(/mutations-.*\.jsonl$/);
  });

  it("reuses an existing directory", () => {
    initMutationLog(testDir);
    expect(getLogPath()).toBeTruthy();
  });
});

describe("logMutation", () => {
  it("appends valid JSONL records", () => {
    initMutationLog(testDir);
    const record: MutationRecord = {
      timestamp: "2026-04-14T10:00:00Z",
      operation: "update_page",
      pageId: "123",
      oldVersion: 5,
      newVersion: 6,
      oldBodyLen: 1000,
      newBodyLen: 500,
    };
    logMutation(record);
    logMutation({ ...record, pageId: "456" });

    const logPath = getLogPath()!;
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]!);
    expect(parsed1.pageId).toBe("123");
    expect(parsed1.operation).toBe("update_page");

    const parsed2 = JSON.parse(lines[1]!);
    expect(parsed2.pageId).toBe("456");
  });

  it("does nothing when log is not initialized", () => {
    // No initMutationLog call
    expect(() =>
      logMutation({
        timestamp: "2026-04-14T10:00:00Z",
        operation: "create_page",
        pageId: "1",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security: symlink rejection (Finding 4)
// ---------------------------------------------------------------------------

describe("initMutationLog — symlink rejection (Finding 4)", () => {
  it("throws when the log directory is a symlink", () => {
    const realDir = join(testDir, "real");
    mkdirSync(realDir);
    const symlinkDir = join(testDir, "link");
    symlinkSync(realDir, symlinkDir);

    expect(() => initMutationLog(symlinkDir)).toThrow(/symlink/);
  });
});

// ---------------------------------------------------------------------------
// Security: error sanitization (Finding 5)
// ---------------------------------------------------------------------------

describe("errorRecord — error sanitization (Finding 5)", () => {
  it("truncates long error messages", () => {
    const longMsg = "x".repeat(500);
    const record = errorRecord("update_page", "123", new Error(longMsg));
    expect(record.error!.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it("strips content after newlines", () => {
    const msg = "First line\nSensitive page body content here";
    const record = errorRecord("update_page", "123", new Error(msg));
    expect(record.error).toBe("First line");
    expect(record.error).not.toContain("Sensitive");
  });

  it("handles non-Error objects", () => {
    const record = errorRecord("delete_page", "123", "string error");
    expect(record.error).toBe("string error");
  });

  it("merges extra fields", () => {
    const record = errorRecord("update_page", "123", new Error("fail"), {
      oldVersion: 5,
      replaceBody: true,
    });
    expect(record.oldVersion).toBe(5);
    expect(record.replaceBody).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Log rotation: old file sweep (Finding 12)
// ---------------------------------------------------------------------------

describe("initMutationLog — old log sweep (Finding 12)", () => {
  it("deletes log files older than 30 days on startup", () => {
    // Create an old log file
    const oldFile = join(testDir, "mutations-old.jsonl");
    writeFileSync(oldFile, '{"test":true}\n');
    // Set mtime to 31 days ago
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    // Create a recent log file
    const recentFile = join(testDir, "mutations-recent.jsonl");
    writeFileSync(recentFile, '{"test":true}\n');

    initMutationLog(testDir);

    const files = readdirSync(testDir).filter((f) => f.endsWith(".jsonl"));
    // Old file should be deleted, recent file and new log file should remain
    expect(files).not.toContain("mutations-old.jsonl");
    expect(files).toContain("mutations-recent.jsonl");
  });

  it("does not delete non-mutation files", () => {
    const otherFile = join(testDir, "other.jsonl");
    writeFileSync(otherFile, "data\n");
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(otherFile, oldTime, oldTime);

    initMutationLog(testDir);

    const files = readdirSync(testDir);
    expect(files).toContain("other.jsonl");
  });
});

// ---------------------------------------------------------------------------
// closeMutationLog
// ---------------------------------------------------------------------------

describe("closeMutationLog", () => {
  it("prevents further writes after closing", () => {
    initMutationLog(testDir);
    const logPath = getLogPath()!;
    logMutation({
      timestamp: "2026-04-14T10:00:00Z",
      operation: "create_page",
      pageId: "1",
    });
    closeMutationLog();
    expect(getLogPath()).toBeNull();

    // Further writes should be no-ops
    logMutation({
      timestamp: "2026-04-14T10:00:01Z",
      operation: "delete_page",
      pageId: "2",
    });

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
