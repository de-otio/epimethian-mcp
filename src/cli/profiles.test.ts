import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFromKeychain = vi.fn();
const mockDeleteFromKeychain = vi.fn().mockResolvedValue(undefined);

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  deleteFromKeychain: (...args: unknown[]) => mockDeleteFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockReadProfileRegistry = vi.fn();
const mockRemoveFromProfileRegistry = vi.fn().mockResolvedValue(undefined);
const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
const mockGetProfileSettings = vi.fn().mockResolvedValue(undefined);
const mockSetProfileSettings = vi.fn().mockResolvedValue(undefined);

vi.mock("../shared/profiles.js", () => ({
  readProfileRegistry: () => mockReadProfileRegistry(),
  removeFromProfileRegistry: (...args: unknown[]) =>
    mockRemoveFromProfileRegistry(...args),
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  getProfileSettings: (...args: unknown[]) => mockGetProfileSettings(...args),
  setProfileSettings: (...args: unknown[]) => mockSetProfileSettings(...args),
}));

import { runProfiles } from "./profiles.js";

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "index.js", "profiles"];
});

describe("runProfiles", () => {
  it("shows message when no profiles exist", async () => {
    mockReadProfileRegistry.mockResolvedValue([]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("No profiles configured")
    );
    spy.mockRestore();
  });

  it("lists profile names without verbose", async () => {
    mockReadProfileRegistry.mockResolvedValue(["globex", "acme"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("globex"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("acme"));
    spy.mockRestore();
  });

  it("shows URL and email with --verbose", async () => {
    process.argv = ["node", "index.js", "profiles", "--verbose"];
    mockReadProfileRegistry.mockResolvedValue(["globex"]);
    mockReadFromKeychain.mockResolvedValue({
      url: "https://globex.atlassian.net",
      email: "user@globex.com",
      apiToken: "tok",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("globex.atlassian.net");
    expect(output).toContain("user@globex.com");
    spy.mockRestore();
  });

  it("shows 'credentials missing' when keychain entry not found", async () => {
    process.argv = ["node", "index.js", "profiles", "--verbose"];
    mockReadProfileRegistry.mockResolvedValue(["gone"]);
    mockReadFromKeychain.mockResolvedValue(null);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("credentials missing");
    spy.mockRestore();
  });

  it("shows read-only status in non-verbose listing", async () => {
    mockReadProfileRegistry.mockResolvedValue(["acme", "globex"]);
    mockGetProfileSettings
      .mockResolvedValueOnce({ readOnly: true })
      .mockResolvedValueOnce(undefined);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("acme (read-only)");
    expect(output).not.toContain("globex (read-only)");
    spy.mockRestore();
  });

  it("shows Read-Only column in verbose listing", async () => {
    process.argv = ["node", "index.js", "profiles", "--verbose"];
    mockReadProfileRegistry.mockResolvedValue(["acme"]);
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "u@acme.com",
      apiToken: "tok",
    });
    mockGetProfileSettings.mockResolvedValue({ readOnly: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Read-Only");
    expect(output).toContain("YES");
    spy.mockRestore();
  });
});

describe("--set-read-only / --set-read-write", () => {
  const originalExit = process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    process.exit = vi.fn((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("--set-read-only sets readOnly: true", async () => {
    process.argv = ["node", "index.js", "profiles", "--set-read-only", "acme"];
    mockReadProfileRegistry.mockResolvedValue(["acme"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { readOnly: true });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("read-only");
    expect(output).toContain("Restart any running MCP servers");
    spy.mockRestore();
  });

  it("--set-read-write sets readOnly: false", async () => {
    process.argv = ["node", "index.js", "profiles", "--set-read-write", "acme"];
    mockReadProfileRegistry.mockResolvedValue(["acme"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { readOnly: false });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("read-write");
    spy.mockRestore();
  });

  it("--set-read-only errors on nonexistent profile", async () => {
    process.argv = ["node", "index.js", "profiles", "--set-read-only", "nope"];
    mockReadProfileRegistry.mockResolvedValue(["acme"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runProfiles()).rejects.toThrow("process.exit(1)");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
    spy.mockRestore();
  });

  it("--set-read-only errors on invalid profile name", async () => {
    process.argv = ["node", "index.js", "profiles", "--set-read-only", "-BAD"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runProfiles()).rejects.toThrow("process.exit(1)");
    spy.mockRestore();
  });
});
