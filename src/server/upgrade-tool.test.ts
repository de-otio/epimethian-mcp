/**
 * The `upgrade` MCP tool asks the registry rather than trusting the cached
 * record alone, and never reports a failed check as "up to date".
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockCheckLatestNow = vi.fn();
const mockGetPendingUpdate = vi.fn();
const mockPerformUpgrade = vi.fn();
const mockClearPendingUpdate = vi.fn();

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  checkLatestNow: (...a: unknown[]) => mockCheckLatestNow(...a),
  getPendingUpdate: (...a: unknown[]) => mockGetPendingUpdate(...a),
  clearPendingUpdate: (...a: unknown[]) => mockClearPendingUpdate(...a),
  performUpgrade: (...a: unknown[]) => mockPerformUpgrade(...a),
}));

const mockRegisterTool = vi.fn();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      registerTool: mockRegisterTool,
      server: {
        getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
        getClientCapabilities: () => ({}),
        elicitInput: vi.fn(),
      },
    };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    validateStartup: vi.fn().mockResolvedValue(undefined),
    setClientLabel: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => ({
      url: "https://test.atlassian.net",
      email: "user@example.com",
      profile: "upgrade-test",
      readOnly: false,
      effectivePosture: "read-write",
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
      sealedCloudId: "cloud-upgrade-test",
    })),
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

type ToolResult = { isError?: boolean; content: { text: string }[] };
let upgrade: () => Promise<ToolResult>;

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find((c) => c[0] === "upgrade");
  if (!call) throw new Error("upgrade was not registered");
  upgrade = () => (call[2] as (a: Record<string, unknown>) => Promise<ToolResult>)({});
});

beforeEach(() => {
  mockCheckLatestNow.mockReset();
  mockGetPendingUpdate.mockReset().mockResolvedValue(null);
  mockPerformUpgrade.mockReset().mockResolvedValue("Installed into /opt/x.");
  mockClearPendingUpdate.mockReset().mockResolvedValue(undefined);
});

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("upgrade tool", () => {
  it("installs a release the registry reports, with no cached record", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "available", info: { current: "1.0.0", latest: "9.9.9", type: "major" } });
    const r = await upgrade();
    expect(r.isError).toBeFalsy();
    expect(mockPerformUpgrade).toHaveBeenCalledWith("9.9.9");
    expect(text(r)).toContain("to v9.9.9");
  });

  it("says up to date only when the registry says so", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "up-to-date", latest: "1.0.0" });
    const r = await upgrade();
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("already up to date");
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("an unreachable registry with no cached record is an error, not up to date", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "unreachable", reason: "the npm registry could not be reached (ENOTFOUND)" });
    const r = await upgrade();
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ENOTFOUND");
    expect(text(r)).not.toContain("up to date");
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("an unreachable registry falls back to the cached record", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "unreachable", reason: "offline" });
    mockGetPendingUpdate.mockResolvedValue({ current: "1.0.0", latest: "9.9.9", type: "major" });
    const r = await upgrade();
    expect(r.isError).toBeFalsy();
    expect(mockPerformUpgrade).toHaveBeenCalledWith("9.9.9");
  });

  it("an install failure is reported as an error", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "available", info: { current: "1.0.0", latest: "9.9.9", type: "major" } });
    mockPerformUpgrade.mockRejectedValue(new Error("npm reported success, but the running copy was not replaced"));
    const r = await upgrade();
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not replaced");
    expect(mockClearPendingUpdate).not.toHaveBeenCalled();
  });
});
