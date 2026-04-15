import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: () => "abcd1234",
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: Function) => vi.fn(),
  };
});

import { readFile, writeFile, rename } from "node:fs/promises";
import {
  parseSemVer,
  classifyUpdate,
  checkForUpdates,
  getPendingUpdate,
  clearPendingUpdate,
  performUpgrade,
} from "./update-check.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EPIMETHIAN_NO_UPDATE_CHECK;
});

// --- Unit tests for pure functions ---

describe("parseSemVer", () => {
  it("parses a valid version string", () => {
    expect(parseSemVer("5.2.1")).toEqual({ major: 5, minor: 2, patch: 1 });
  });

  it("parses 0.0.0", () => {
    expect(parseSemVer("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it("returns null for invalid version", () => {
    expect(parseSemVer("not-a-version")).toBeNull();
  });

  it("returns null for prerelease versions", () => {
    expect(parseSemVer("1.2.3-beta.1")).toBeNull();
  });

  it("returns null for incomplete version", () => {
    expect(parseSemVer("1.2")).toBeNull();
  });
});

describe("classifyUpdate", () => {
  it("detects major update", () => {
    expect(
      classifyUpdate({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })
    ).toBe("major");
  });

  it("detects minor update", () => {
    expect(
      classifyUpdate({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 1, patch: 0 })
    ).toBe("minor");
  });

  it("detects patch update", () => {
    expect(
      classifyUpdate({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 1 })
    ).toBe("patch");
  });

  it("returns null when versions are equal", () => {
    expect(
      classifyUpdate({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })
    ).toBeNull();
  });

  it("returns null when current is ahead", () => {
    expect(
      classifyUpdate({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })
    ).toBeNull();
  });

  it("classifies major even when minor/patch are lower", () => {
    expect(
      classifyUpdate({ major: 1, minor: 5, patch: 3 }, { major: 2, minor: 0, patch: 0 })
    ).toBe("major");
  });

  it("classifies minor even when patch is lower", () => {
    expect(
      classifyUpdate({ major: 1, minor: 2, patch: 9 }, { major: 1, minor: 3, patch: 0 })
    ).toBe("minor");
  });
});

// --- Integration-style tests ---

describe("checkForUpdates", () => {
  it("skips check when EPIMETHIAN_NO_UPDATE_CHECK is set", async () => {
    process.env.EPIMETHIAN_NO_UPDATE_CHECK = "true";
    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips fetch when last check was less than 24h ago", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: new Date().toISOString() })
    );
    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns cached pending update when throttled", async () => {
    const pending = { current: "5.2.0", latest: "6.0.0", type: "major" as const };
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        lastCheck: new Date().toISOString(),
        pendingUpdate: pending,
      })
    );
    const result = await checkForUpdates("5.2.0");
    expect(result).toEqual(pending);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when already on latest version", async () => {
    // Stale last check — will fetch
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.1" }),
    });

    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockRejectedValue(new Error("network timeout"));

    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
  });

  it("returns null when registry returns non-OK", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({ ok: false });

    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
  });

  it("detects minor update and stores as pending", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.3.0" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkForUpdates("5.2.1");

    expect(result).toEqual({
      current: "5.2.1",
      latest: "5.3.0",
      type: "minor",
    });
    // Should persist the pending update
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.pendingUpdate.type).toBe("minor");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Minor update available")
    );
    stderrSpy.mockRestore();
  });

  it("detects major update and stores as pending", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "6.0.0" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkForUpdates("5.2.1");

    expect(result).toEqual({
      current: "5.2.1",
      latest: "6.0.0",
      type: "major",
    });
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.pendingUpdate.type).toBe("major");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Major update available")
    );
    stderrSpy.mockRestore();
  });

  it("handles first run with no state file", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.1" }),
    });

    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
    // Should still write the state with lastCheck
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("handles corrupted state file gracefully", async () => {
    mockReadFile.mockResolvedValue("not valid json{{{");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.1" }),
    });

    const result = await checkForUpdates("5.2.1");
    expect(result).toBeNull();
  });

  it("writes state atomically (tmp + rename)", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.1" }),
    });

    await checkForUpdates("5.2.1");

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(".update-check.abcd1234.tmp"),
      expect.any(String),
      { mode: 0o600 }
    );
    expect(mockRename).toHaveBeenCalled();
  });
});

describe("getPendingUpdate", () => {
  it("returns null when no state file exists", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);

    const result = await getPendingUpdate();
    expect(result).toBeNull();
  });

  it("returns null when state has no pending update", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: new Date().toISOString() })
    );
    const result = await getPendingUpdate();
    expect(result).toBeNull();
  });

  it("returns the pending update info", async () => {
    const pending = { current: "5.2.1", latest: "6.0.0", type: "major" as const };
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: new Date().toISOString(), pendingUpdate: pending })
    );
    const result = await getPendingUpdate();
    expect(result).toEqual(pending);
  });
});

describe("clearPendingUpdate", () => {
  it("removes pending update from state", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        lastCheck: new Date().toISOString(),
        pendingUpdate: { current: "5.2.1", latest: "6.0.0", type: "major" },
      })
    );

    await clearPendingUpdate();

    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.pendingUpdate).toBeUndefined();
    expect(parsed.lastCheck).toBeDefined();
  });

  it("does nothing when no state file exists", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);

    await clearPendingUpdate();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
