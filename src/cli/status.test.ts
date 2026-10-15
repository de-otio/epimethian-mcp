import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTestConnection = vi.fn();
const mockReadFromKeychain = vi.fn();

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockFind = vi.fn();
vi.mock("../shared/installed-copies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/installed-copies.js")>();
  return { ...actual, findInstalledCopies: (...args: unknown[]) => mockFind(...args) };
});

import { runStatus } from "./status.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockReset().mockResolvedValue([]);
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

describe("runStatus", () => {
  it("shows profile info and connection status", async () => {
    process.env.CONFLUENCE_PROFILE = "globex";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://globex.atlassian.net",
      email: "user@globex.com",
      apiToken: "tok",
    });
    mockTestConnection.mockResolvedValue({
      ok: true,
      message: "Connected successfully.",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatus();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("globex");
    expect(output).toContain("globex.atlassian.net");
    expect(output).toContain("user@globex.com");
    expect(output).toContain("Connected");
    spy.mockRestore();
  });

  it("shows env-var mode when all three env vars set", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-tok";
    mockTestConnection.mockResolvedValue({
      ok: true,
      message: "Connected.",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatus();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("env-var mode");
    spy.mockRestore();
  });
});

describe("runStatus: installed copies", () => {
  const BREW = {
    prefix: "/opt/homebrew",
    packageDir: "/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp",
    version: "7.4.0",
    running: true,
    pathRank: 0,
  };
  const NVM = {
    prefix: "/Users/u/.nvm/versions/node/v22.1.0",
    packageDir: "/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@de-otio/epimethian-mcp",
    version: "7.2.0",
    running: false,
    pathRank: null,
  };

  beforeEach(() => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-tok";
    mockTestConnection.mockResolvedValue({ ok: true, message: "Connected." });
  });

  async function output(): Promise<string> {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    const out = spy.mock.calls.map((c) => c[0]).join("\n");
    spy.mockRestore();
    return out;
  }

  it("one copy: an Installed line", async () => {
    mockFind.mockResolvedValue([BREW]);
    const out = await output();
    expect(out).toContain(`Installed: v7.4.0 at ${BREW.packageDir}`);
    expect(out).not.toContain("copies of epimethian-mcp");
  });

  it("two copies: the copies block, marking the copy this command runs from", async () => {
    mockFind.mockResolvedValue([BREW, NVM]);
    const out = await output();
    expect(out).toContain("2 copies of epimethian-mcp are installed:");
    expect(out).toContain(`${BREW.packageDir}   ← this command`);
    expect(out).toContain(`npm uninstall -g --prefix ${NVM.prefix} @de-otio/epimethian-mcp`);
  });

  it("no global copy: says so", async () => {
    const out = await output();
    expect(out).toContain("Installed: no npm global install found");
  });

  it("lists the copies even when no credentials are configured", async () => {
    delete process.env.CONFLUENCE_URL;
    mockReadFromKeychain.mockResolvedValue(null);
    mockFind.mockResolvedValue([BREW, NVM]);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runStatus()).rejects.toThrow("exit");
    expect(spy.mock.calls.map((c) => c[0]).join("\n")).toContain("2 copies of epimethian-mcp");
    exit.mockRestore();
    spy.mockRestore();
  });
});
