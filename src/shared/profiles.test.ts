import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: () => "abcd1234",
  }),
}));

import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import {
  readProfileRegistry,
  addToProfileRegistry,
  removeFromProfileRegistry,
  appendAuditLog,
  getProfileRegistryPath,
} from "./profiles.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProfileRegistryPath", () => {
  it("returns path under ~/.config/epimethian-mcp", () => {
    const path = getProfileRegistryPath();
    expect(path).toContain(".config/epimethian-mcp/profiles.json");
  });
});

describe("readProfileRegistry", () => {
  it("returns profile names from valid file", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["jambit", "acme"] })
    );
    const result = await readProfileRegistry();
    expect(result).toEqual(["jambit", "acme"]);
  });

  it("returns empty array when file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockReadFile.mockRejectedValue(err);
    const result = await readProfileRegistry();
    expect(result).toEqual([]);
  });

  it("returns empty array on corrupted JSON", async () => {
    mockReadFile.mockResolvedValue("not-json{{{");
    const result = await readProfileRegistry();
    expect(result).toEqual([]);
  });

  it("returns empty array on unexpected format", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ profiles: "not-array" }));
    const result = await readProfileRegistry();
    expect(result).toEqual([]);
  });

  it("returns empty array when profiles contains non-strings", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: [123, "valid"] })
    );
    const result = await readProfileRegistry();
    expect(result).toEqual([]);
  });
});

describe("addToProfileRegistry", () => {
  it("creates directory with 0700 and writes file with atomic rename", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ profiles: ["existing"] }));

    await addToProfileRegistry("new-profile");

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".config/epimethian-mcp"),
      { recursive: true, mode: 0o700 }
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(".profiles.abcd1234.tmp"),
      expect.stringContaining('"new-profile"'),
      { mode: 0o600 }
    );
    expect(mockRename).toHaveBeenCalled();
  });

  it("does not write when profile already exists", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["already-here"] })
    );

    await addToProfileRegistry("already-here");

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("creates registry from scratch when file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockReadFile.mockRejectedValue(err);

    await addToProfileRegistry("first-profile");

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"first-profile"'),
      { mode: 0o600 }
    );
    expect(mockRename).toHaveBeenCalled();
  });
});

describe("removeFromProfileRegistry", () => {
  it("removes profile and writes atomically", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["keep", "remove-me"] })
    );

    await removeFromProfileRegistry("remove-me");

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    expect(writtenData).toContain('"keep"');
    expect(writtenData).not.toContain('"remove-me"');
    expect(mockRename).toHaveBeenCalled();
  });

  it("does nothing when profile not in registry", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["other"] })
    );

    await removeFromProfileRegistry("not-here");

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("appendAuditLog", () => {
  it("appends timestamped entry to audit log", async () => {
    await appendAuditLog('Removed profile "test"');

    expect(vi.mocked(appendFile)).toHaveBeenCalledWith(
      expect.stringContaining("audit.log"),
      expect.stringMatching(/^\[.*\] Removed profile "test"\n$/),
      { mode: 0o600 }
    );
  });
});
