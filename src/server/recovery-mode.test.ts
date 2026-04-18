import { describe, it, expect, vi, beforeEach } from "vitest";

// Intentionally do NOT set credential env vars so we can control them per-test.
vi.hoisted(() => {
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

const mockReadFromKeychain = vi.fn();

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/profiles.js", () => ({
  getProfileSettings: vi.fn().mockResolvedValue(undefined),
}));

// Capture McpServer construction + tool registrations.
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();
const mockMcpServer = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  registerTool: mockRegisterTool,
  server: {
    getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: mockMcpServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

async function importIndex() {
  vi.resetModules();
  return import("./index.js");
}

describe("recovery-mode server (missing profile)", () => {
  it("main() enters recovery mode when CONFLUENCE_PROFILE names a missing profile", async () => {
    process.env.CONFLUENCE_PROFILE = "jambit";
    mockReadFromKeychain.mockResolvedValue(null);

    const { main } = await importIndex();
    await main();

    expect(mockMcpServer).toHaveBeenCalledOnce();
    const [serverInfo, options] = mockMcpServer.mock.calls[0];
    expect(serverInfo.name).toBe("confluence-jambit-setup-needed");
    expect(options.instructions).toContain("jambit");
    expect(options.instructions).toContain("setup_profile");

    // Only the setup_profile tool is registered.
    expect(mockRegisterTool).toHaveBeenCalledOnce();
    expect(mockRegisterTool.mock.calls[0][0]).toBe("setup_profile");

    // Transport is connected.
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("setup_profile tool returns the CLI command with the profile name", async () => {
    process.env.CONFLUENCE_PROFILE = "globex";
    mockReadFromKeychain.mockResolvedValue(null);

    const { main } = await importIndex();
    await main();

    const [, , handler] = mockRegisterTool.mock.calls[0];
    const result = await handler();

    const text = result.content[0].text;
    expect(text).toContain("epimethian-mcp setup --profile globex");
    expect(text).toContain("globex");
    // Must instruct the agent to ask before running anything and to not
    // pass the API token through the conversation.
    expect(text.toLowerCase()).toContain("ask the user");
    expect(text.toLowerCase()).toContain("terminal");
    expect(text.toLowerCase()).toContain("reload");
  });

  it("startRecoveryServer() can be called directly with any profile name", async () => {
    const { startRecoveryServer } = await importIndex();
    await startRecoveryServer("acme-corp");

    const [serverInfo] = mockMcpServer.mock.calls[0];
    expect(serverInfo.name).toBe("confluence-acme-corp-setup-needed");
    expect(mockConnect).toHaveBeenCalledOnce();
  });
});
