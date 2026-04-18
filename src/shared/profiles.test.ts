import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ mode: 0o100600 }), // default: safe permissions
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

// safe-fs wraps fs/promises with O_NOFOLLOW + fstat-on-fd. For unit tests we
// mock it directly — the integration tests in safe-fs.test.ts cover the
// real-fd behaviour. Track E2 of plans/security-audit-fixes.md.
vi.mock("./safe-fs.js", () => ({
  safeOpenRead: vi.fn(),
  safeOpenAppend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: () => "abcd1234",
  }),
}));

import { readFile, writeFile, rename, mkdir, appendFile, stat } from "node:fs/promises";
import { safeOpenRead, safeOpenAppend } from "./safe-fs.js";
import {
  readProfileRegistry,
  addToProfileRegistry,
  removeFromProfileRegistry,
  appendAuditLog,
  getProfileRegistryPath,
  getProfileSettings,
  setProfileSettings,
} from "./profiles.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockMkdir = vi.mocked(mkdir);
const mockStat = vi.mocked(stat);
const mockSafeOpenRead = vi.mocked(safeOpenRead);
const mockSafeOpenAppend = vi.mocked(safeOpenAppend);

beforeEach(() => {
  vi.clearAllMocks();
  // Tests set up registry contents via mockReadFile.mockResolvedValueOnce.
  // Track E2 replaced the direct readFile call with safeOpenRead; bridge the
  // two so the existing tests exercise the same queued return values.
  mockSafeOpenRead.mockImplementation((path: string) => {
    return (mockReadFile as any)(path, "utf-8");
  });
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
      JSON.stringify({ profiles: ["globex", "acme"] })
    );
    const result = await readProfileRegistry();
    expect(result).toEqual(["globex", "acme"]);
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

describe("removeFromProfileRegistry", () => {
  it("cleans up settings for removed profile", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["keep", "remove-me"],
        settings: { "remove-me": { readOnly: true }, keep: { readOnly: false } },
      })
    );

    await removeFromProfileRegistry("remove-me");

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.settings).toEqual({ keep: { readOnly: false } });
    expect(parsed.settings["remove-me"]).toBeUndefined();
  });

  it("removes settings key entirely when last profile with settings is removed", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["only"],
        settings: { only: { readOnly: true } },
      })
    );

    await removeFromProfileRegistry("only");

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.settings).toBeUndefined();
  });
});

describe("getProfileSettings", () => {
  it("returns readOnly: true when set", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["acme"],
        settings: { acme: { readOnly: true } },
      })
    );
    const settings = await getProfileSettings("acme");
    expect(settings).toEqual({ readOnly: true });
  });

  it("returns undefined for unknown profile", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["acme"] })
    );
    const settings = await getProfileSettings("unknown");
    expect(settings).toBeUndefined();
  });

  it("returns undefined when settings key is absent from registry", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["acme"] })
    );
    const settings = await getProfileSettings("acme");
    expect(settings).toBeUndefined();
  });
});

describe("setProfileSettings", () => {
  it("persists and round-trips", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["acme"] })
    );

    await setProfileSettings("acme", { readOnly: true });

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.settings.acme).toEqual({ readOnly: true });
    expect(parsed.profiles).toEqual(["acme"]);
  });

  it("preserves existing profiles and other settings", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["acme", "globex"],
        settings: { globex: { readOnly: false } },
      })
    );

    await setProfileSettings("acme", { readOnly: true });

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.profiles).toEqual(["acme", "globex"]);
    expect(parsed.settings.globex).toEqual({ readOnly: false });
    expect(parsed.settings.acme).toEqual({ readOnly: true });
  });

  it("merges with existing settings for the same profile", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["acme"],
        settings: { acme: { readOnly: true } },
      })
    );

    await setProfileSettings("acme", { readOnly: false });

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.settings.acme).toEqual({ readOnly: false });
  });
});

describe("permission verification", () => {
  // E2: permission rejection moved into safe-fs.ts's safeOpenRead. The bridge
  // in beforeEach delegates to mockReadFile; here we short-circuit that and
  // throw the string error shape that safeOpenRead produces.
  it("rejects world-writable registry file", async () => {
    mockSafeOpenRead.mockRejectedValueOnce(new Error("unsafe-permissions"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await readProfileRegistry();

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("unsafe permissions")
    );
    spy.mockRestore();
  });

  it("rejects group-writable registry file", async () => {
    mockSafeOpenRead.mockRejectedValueOnce(new Error("unsafe-permissions"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await readProfileRegistry();

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("unsafe permissions")
    );
    spy.mockRestore();
  });

  it("rejects a registry file that is a symlink (E2 regression guard)", async () => {
    const eloop = new Error("symlink") as NodeJS.ErrnoException;
    eloop.code = "ELOOP";
    mockSafeOpenRead.mockRejectedValueOnce(eloop);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await readProfileRegistry();

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("symlink")
    );
    spy.mockRestore();
  });

  it("accepts owner-only permissions", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ profiles: ["acme"] })
    );

    const result = await readProfileRegistry();
    expect(result).toEqual(["acme"]);
  });
});

describe("addToProfileRegistry preserves settings", () => {
  it("preserves existing settings when adding a new profile", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        profiles: ["existing"],
        settings: { existing: { readOnly: true } },
      })
    );

    await addToProfileRegistry("new-one");

    const writtenData = (mockWriteFile.mock.calls[0]?.[1] as string) ?? "";
    const parsed = JSON.parse(writtenData);
    expect(parsed.profiles).toEqual(["existing", "new-one"]);
    expect(parsed.settings).toEqual({ existing: { readOnly: true } });
  });
});

describe("appendAuditLog", () => {
  it("appends timestamped entry to audit log via safeOpenAppend (E2)", async () => {
    await appendAuditLog('Removed profile "test"');

    // E2: migrated from node:fs/promises.appendFile to safe-fs.safeOpenAppend
    // (O_NOFOLLOW). The signature is now (path, data) — no mode argument
    // because safeOpenAppend hardcodes 0o600 in the open flags.
    expect(mockSafeOpenAppend).toHaveBeenCalledWith(
      expect.stringContaining("audit.log"),
      expect.stringMatching(/^\[.*\] Removed profile "test"\n$/)
    );
  });
});
