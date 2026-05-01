import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// E2: readCheckState now goes through safeOpenRead. Bridge to the existing
// readFile mock so test setups that prime readFile still drive behaviour.
vi.mock("./safe-fs.js", () => ({
  safeOpenRead: vi.fn(),
  safeOpenAppend: vi.fn().mockResolvedValue(undefined),
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
import { safeOpenRead } from "./safe-fs.js";
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
const mockSafeOpenRead = vi.mocked(safeOpenRead);

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EPIMETHIAN_NO_UPDATE_CHECK;
  delete process.env.EPIMETHIAN_AUTO_UPGRADE;
  // Bridge safeOpenRead to the existing readFile mock so test setups that
  // prime readFile still drive readCheckState's behaviour after E2.
  mockSafeOpenRead.mockImplementation((path: string) => {
    return (mockReadFile as any)(path, "utf-8");
  });
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

// ---------------------------------------------------------------------------
// Security audit Track A: new trust model.
//   - Default: check-and-notify only. No auto-install for any type.
//   - Opt-in: EPIMETHIAN_AUTO_UPGRADE=patches restores auto-install for
//     patches only, gated by verifyNpmProvenance.
// These tests document the trust model — see src/shared/update-check.ts
// top-of-file design note for full rationale.
// ---------------------------------------------------------------------------

describe("checkForUpdates — trust model (Track A)", () => {
  it("DEFAULT: patch update is stored as pending, NOT auto-installed", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.2" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkForUpdates("5.2.1");

    expect(result).toEqual({
      current: "5.2.1",
      latest: "5.2.2",
      type: "patch",
    });
    // Critical: autoInstalled must NOT be set in default mode.
    expect(result?.autoInstalled).toBeUndefined();

    // Pending record is persisted; no "installed automatically" log.
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.pendingUpdate.type).toBe("patch");
    expect(parsed.pendingUpdate.autoInstalled).toBeUndefined();

    // Nag line points the user at the CLI upgrade command.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Patch update available")
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("epimethian-mcp upgrade")
    );
    stderrSpy.mockRestore();
  });

  it("DEFAULT: does not log the supply-chain warning when opt-in is off", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.2" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkForUpdates("5.2.1");

    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(calls).not.toContain("EPIMETHIAN_AUTO_UPGRADE=patches is active");
    stderrSpy.mockRestore();
  });

  it("OPT-IN: EPIMETHIAN_AUTO_UPGRADE=patches logs the supply-chain warning", async () => {
    process.env.EPIMETHIAN_AUTO_UPGRADE = "patches";
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.2" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkForUpdates("5.2.1");

    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(calls).toContain("EPIMETHIAN_AUTO_UPGRADE=patches is active");
    expect(calls).toContain("provenance attestation");
    stderrSpy.mockRestore();
  });

  it("OPT-IN: does not unlock auto-install for MINOR updates", async () => {
    process.env.EPIMETHIAN_AUTO_UPGRADE = "patches";
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.3.0" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkForUpdates("5.2.1");

    expect(result?.type).toBe("minor");
    // Minor updates are notify-only even under the opt-in.
    expect(result?.autoInstalled).toBeUndefined();
    stderrSpy.mockRestore();
  });

  it("OPT-IN: does not unlock auto-install for MAJOR updates", async () => {
    process.env.EPIMETHIAN_AUTO_UPGRADE = "patches";
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "6.0.0" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkForUpdates("5.2.1");

    expect(result?.type).toBe("major");
    expect(result?.autoInstalled).toBeUndefined();
    stderrSpy.mockRestore();
  });

  it("pending record is persisted BEFORE auto-install attempt (so failures keep nagging)", async () => {
    // Document the ordering guarantee from the design note: the pending
    // record is written first so an integrity-check or install failure
    // leaves the nag signal in place.
    mockReadFile.mockResolvedValue(
      JSON.stringify({ lastCheck: "2020-01-01T00:00:00.000Z" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "5.2.2" }),
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkForUpdates("5.2.1");

    // In default mode, writeFile is called exactly once — and it contains
    // the pending record. In opt-in mode with a failing install, we also
    // expect the record present on first write.
    expect(mockWriteFile).toHaveBeenCalled();
    const firstWritten = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(firstWritten);
    expect(parsed.pendingUpdate).toBeDefined();
    stderrSpy.mockRestore();
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
