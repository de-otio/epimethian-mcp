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

vi.mock("../shared/profiles.js", () => ({
  readProfileRegistry: () => mockReadProfileRegistry(),
  removeFromProfileRegistry: (...args: unknown[]) =>
    mockRemoveFromProfileRegistry(...args),
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
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
    mockReadProfileRegistry.mockResolvedValue(["jambit", "acme"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("jambit"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("acme"));
    spy.mockRestore();
  });

  it("shows URL and email with --verbose", async () => {
    process.argv = ["node", "index.js", "profiles", "--verbose"];
    mockReadProfileRegistry.mockResolvedValue(["jambit"]);
    mockReadFromKeychain.mockResolvedValue({
      url: "https://jambit.atlassian.net",
      email: "user@jambit.com",
      apiToken: "tok",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProfiles();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("jambit.atlassian.net");
    expect(output).toContain("user@jambit.com");
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
});
