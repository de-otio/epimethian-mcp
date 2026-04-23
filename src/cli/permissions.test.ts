import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetConfig = vi.fn();
const mockValidateStartup = vi.fn();
const mockBuildPayload = vi.fn();

vi.mock("../server/confluence-client.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  validateStartup: (...args: unknown[]) => mockValidateStartup(...args),
}));

vi.mock("../server/check-permissions.js", () => ({
  buildCheckPermissionsPayload: (...args: unknown[]) => mockBuildPayload(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

import { runPermissions } from "./permissions.js";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CONFLUENCE_PROFILE;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("runPermissions", () => {
  it("errors out and exits 1 when no profile is given and env is empty", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((() => {
        throw new Error("exit called");
      }) as never) as never);

    await expect(runPermissions()).rejects.toThrow("exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls[0][0]).toContain("Usage: epimethian-mcp permissions");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("rejects an invalid profile name", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((() => {
        throw new Error("exit called");
      }) as never) as never);

    await expect(runPermissions("BAD NAME")).rejects.toThrow("exit called");
    expect(errSpy.mock.calls[0][0]).toContain("Invalid profile name");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runs the pipeline and prints the payload as JSON", async () => {
    const fakeConfig = { profile: "acme", effectivePosture: "read-only" } as unknown;
    const fakePayload = {
      profile: "acme",
      posture: { effective: "read-only", configured: "read-only", source: "profile" },
    };
    mockGetConfig.mockResolvedValue(fakeConfig);
    mockValidateStartup.mockResolvedValue(undefined);
    mockBuildPayload.mockReturnValue(fakePayload);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runPermissions("acme");

    expect(process.env.CONFLUENCE_PROFILE).toBe("acme");
    expect(mockGetConfig).toHaveBeenCalled();
    expect(mockValidateStartup).toHaveBeenCalledWith(fakeConfig);
    expect(mockBuildPayload).toHaveBeenCalledWith(fakeConfig);

    const printed = logSpy.mock.calls[0][0];
    expect(printed).toBe(JSON.stringify(fakePayload, null, 2));

    logSpy.mockRestore();
  });

  it("falls back to CONFLUENCE_PROFILE env var when no arg is given", async () => {
    process.env.CONFLUENCE_PROFILE = "preset";
    mockGetConfig.mockResolvedValue({} as unknown);
    mockValidateStartup.mockResolvedValue(undefined);
    mockBuildPayload.mockReturnValue({ profile: "preset" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runPermissions();

    expect(mockGetConfig).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
