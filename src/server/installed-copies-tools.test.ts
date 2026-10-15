/**
 * `get_version` and `upgrade` show the other installed copies. The finder is
 * mocked; the text-building functions are the real ones.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledCopy } from "../shared/installed-copies.js";

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

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  checkLatestNow: (...a: unknown[]) => mockCheckLatestNow(...a),
  getPendingUpdate: (...a: unknown[]) => mockGetPendingUpdate(...a),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: (...a: unknown[]) => mockPerformUpgrade(...a),
}));

const mockFind = vi.fn();
vi.mock("../shared/installed-copies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/installed-copies.js")>();
  return { ...actual, findInstalledCopies: (...a: unknown[]) => mockFind(...a) };
});

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
      profile: "copies-test",
      readOnly: false,
      effectivePosture: "read-write",
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
      sealedCloudId: "cloud-copies-test",
    })),
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = () => Promise<ToolResult>;
let getVersion: Tool;
let upgrade: Tool;
let forget: () => void;
let startupErrors: string[] = [];

const BREW: InstalledCopy = {
  prefix: "/opt/homebrew",
  packageDir: "/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp",
  version: "7.4.0",
  running: true,
  pathRank: null,
};
const NVM: InstalledCopy = {
  prefix: "/Users/u/.nvm/versions/node/v22.1.0",
  packageDir: "/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@de-otio/epimethian-mcp",
  version: "7.2.0",
  running: false,
  pathRank: 0,
};

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

beforeAll(async () => {
  mockFind.mockResolvedValue([BREW, NVM]);
  mockGetPendingUpdate.mockResolvedValue(null);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("./index.js");
  await mod.main();
  startupErrors = spy.mock.calls.map((c) => String(c[0]));
  spy.mockRestore();
  forget = mod.forgetInstalledCopies;
  const tool = (name: string): Tool => {
    const call = mockRegisterTool.mock.calls.find((c) => c[0] === name);
    if (!call) throw new Error(`${name} was not registered`);
    return () => (call[2] as (a: Record<string, unknown>) => Promise<ToolResult>)({});
  };
  getVersion = tool("get_version");
  upgrade = tool("upgrade");
});

beforeEach(() => {
  forget();
  mockFind.mockReset();
  mockGetPendingUpdate.mockReset().mockResolvedValue(null);
  mockCheckLatestNow.mockReset();
  mockPerformUpgrade.mockReset().mockResolvedValue("Installed into /opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp.");
});

describe("server startup", () => {
  it("prints the copies block to stderr once", () => {
    const blocks = startupErrors.filter((l) => l.includes("2 copies of epimethian-mcp are installed"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(NVM.packageDir);
  });
});

describe("get_version", () => {
  it("one copy: no block", async () => {
    mockFind.mockResolvedValue([BREW]);
    const out = text(await getVersion());
    expect(out).toMatch(/^epimethian-mcp v\S+$/);
  });

  it("two copies: the block, with the other copy's uninstall line", async () => {
    mockFind.mockResolvedValue([BREW, NVM]);
    const out = text(await getVersion());
    expect(out).toContain("2 copies of epimethian-mcp are installed:");
    expect(out).toContain(`${BREW.packageDir}   ← this server`);
    expect(out).toContain(`npm uninstall -g --prefix ${NVM.prefix} @de-otio/epimethian-mcp`);
  });

  it("the finder rejecting leaves the output unchanged", async () => {
    mockFind.mockResolvedValue([BREW]);
    const plain = text(await getVersion());
    forget();
    mockFind.mockRejectedValue(new Error("EIO"));
    const r = await getVersion();
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(plain);
  });

  it("finds the copies once and reuses the result", async () => {
    mockFind.mockResolvedValue([BREW]);
    await getVersion();
    await getVersion();
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it("the update notice names the running copy's bin by absolute path only with two or more copies", async () => {
    const pending = { current: "7.4.0", latest: "7.4.1", type: "patch" };
    mockGetPendingUpdate.mockResolvedValue(pending);

    mockFind.mockResolvedValue([BREW]);
    const one = text(await getVersion());
    expect(one).toContain("Run `epimethian-mcp upgrade` in your terminal");
    expect(one).not.toContain("/opt/homebrew/bin/epimethian-mcp");

    forget();
    mockFind.mockResolvedValue([BREW, NVM]);
    const two = text(await getVersion());
    expect(two).toContain('run `"/opt/homebrew/bin/epimethian-mcp" upgrade` in your terminal');
    expect(two).toContain("A bare `epimethian-mcp upgrade` may upgrade a different copy (see above).");
    expect(two).not.toContain("Run `epimethian-mcp upgrade` in your terminal");
    // The block comes before the notice that refers to it.
    expect(two.indexOf("2 copies")).toBeLessThan(two.indexOf("see above"));
  });
});

describe("upgrade tool", () => {
  beforeEach(() => {
    mockCheckLatestNow.mockResolvedValue({ status: "available", info: { current: "7.4.0", latest: "7.4.1", type: "patch" } });
  });

  it("after a successful install, lists the copy it did not upgrade", async () => {
    mockFind.mockResolvedValue([BREW, NVM]);
    const out = text(await upgrade());
    expect(out).toContain(`Not upgraded: v7.2.0 at ${NVM.packageDir}`);
    expect(out).toContain(`npm uninstall -g --prefix ${NVM.prefix} @de-otio/epimethian-mcp`);
  });

  it("finds the copies again after the install rather than reusing the cached list", async () => {
    mockFind.mockResolvedValue([BREW]);
    await getVersion();
    mockFind.mockResolvedValue([BREW, NVM]);
    const out = text(await upgrade());
    expect(out).toContain("Not upgraded:");
  });

  it("with one copy, says nothing about other copies", async () => {
    mockFind.mockResolvedValue([BREW]);
    const out = text(await upgrade());
    expect(out).not.toContain("Not upgraded");
  });

  it("a finder failure after the install does not turn the upgrade into an error", async () => {
    mockFind.mockRejectedValue(new Error("EIO"));
    const r = await upgrade();
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("to v7.4.1");
  });
});
