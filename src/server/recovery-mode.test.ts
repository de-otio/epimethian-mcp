/**
 * Recovery-mode server: profile-missing (7.x) and registry-unreadable
 * (0-T4, policy gate step 0). The McpServer is mocked so the registered
 * texts can be read directly; the registry is real, in a temp HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The real registry code, against a temp HOME per test (see beforeEach).

// Capture McpServer construction + tool registrations.
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();
const mockMcpServer = vi.fn().mockImplementation(function () {
  return {
    connect: mockConnect,
    registerTool: mockRegisterTool,
    server: {
      getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
    },
  };
});

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

let home: string;
let configDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recovery-mode-"));
  await chmod(home, 0o700);
  configDir = join(home, ".config", "epimethian-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  vi.stubEnv("HOME", home);
  vi.clearAllMocks();
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function importIndex() {
  vi.resetModules();
  return import("./index.js");
}

describe("recovery-mode server (missing profile)", () => {
  it("main() enters recovery mode when CONFLUENCE_PROFILE names a missing profile", async () => {
    process.env.CONFLUENCE_PROFILE = "example";
    mockReadFromKeychain.mockResolvedValue(null);

    const { main } = await importIndex();
    await main();

    expect(mockMcpServer).toHaveBeenCalledOnce();
    const [serverInfo, options] = mockMcpServer.mock.calls[0];
    expect(serverInfo.name).toBe("confluence-example-setup-needed");
    expect(options.instructions).toContain("example");
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
    await startRecoveryServer("acme-corp", { kind: "profile-missing" });

    const [serverInfo] = mockMcpServer.mock.calls[0];
    expect(serverInfo.name).toBe("confluence-acme-corp-setup-needed");
    expect(mockConnect).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 0-T4: registry-unreadable recovery text.
// ---------------------------------------------------------------------------

const CANARY = "CANARY-r3c0v3ry-51de";
const PREFIXES = ["Withheld [REGISTRY_UNREADABLE]: ", "Rule: ", "For the person: ", "Instead: ", "Restart: "];

describe("recoveryText (0-T4)", () => {
  it("profile-missing keeps the 7.x texts and server name", async () => {
    const { recoveryText } = await importIndex();
    const t = recoveryText("work", { kind: "profile-missing" });
    expect(t.serverName).toBe("confluence-work-setup-needed");
    expect(t.instructions).toContain("setup_profile");
    expect(t.text).toContain("epimethian-mcp setup --profile work");
  });

  it("registry-unreadable: five lines with the pinned prefixes, the fix line and Restart: needed", async () => {
    const { recoveryText } = await importIndex();
    const t = recoveryText("work", {
      kind: "registry-unreadable",
      what: "the profile registry ~/.config/epimethian-mcp/profiles.json is not valid JSON",
      fix: "Fix the JSON in ~/.config/epimethian-mcp/profiles.json, then run: epimethian-mcp profiles",
    });
    expect(t.serverName).toBe("confluence-work-config-error");
    const lines = t.text.split("\n");
    expect(lines).toHaveLength(5);
    lines.forEach((line, i) => expect(line.startsWith(PREFIXES[i]!)).toBe(true));
    expect(lines[0]).toContain("do not edit the file yourself");
    expect(lines[1]).toBe(
      "Rule: the profile registry ~/.config/epimethian-mcp/profiles.json is not valid JSON; an unreadable registry is refused, never ignored.",
    );
    expect(lines[2]).toBe(
      "For the person: Fix the JSON in ~/.config/epimethian-mcp/profiles.json, then run: epimethian-mcp profiles",
    );
    expect(lines[4]).toMatch(/^Restart: needed/);
    expect(t.instructions).toContain("Fix the JSON in ~/.config/epimethian-mcp/profiles.json");
    expect(t.instructions).toContain("setup_profile");
  });
});

describe("main() with an unreadable registry (0-T4)", () => {
  async function bootWith(arrange: () => Promise<void>) {
    process.env.CONFLUENCE_PROFILE = "work";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "token-not-a-secret",
    });
    await arrange();
    const { main } = await importIndex();
    await main();
    expect(mockMcpServer).toHaveBeenCalledOnce();
    const [serverInfo, options] = mockMcpServer.mock.calls[0];
    expect(mockRegisterTool).toHaveBeenCalledOnce();
    const [name, meta, handler] = mockRegisterTool.mock.calls[0];
    const result = await handler();
    return {
      serverName: serverInfo.name as string,
      instructions: options.instructions as string,
      toolName: name as string,
      description: meta.description as string,
      text: result.content[0].text as string,
    };
  }

  const registry = () => join(configDir, "profiles.json");

  it("a syntax error: recovery server, fix line with the position, no .bak clause without a backup, no canary", async () => {
    const r = await bootWith(() =>
      writeFile(registry(), `{\n  "profiles": ["work"],\n  "settings": {"work": {"spaces": ["${CANARY}"]}},\n}\n`, { mode: 0o600 }),
    );
    expect(r.serverName).toBe("confluence-work-config-error");
    expect(r.toolName).toBe("setup_profile");
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(5);
    lines.forEach((line, i) => expect(line.startsWith(PREFIXES[i]!)).toBe(true));
    expect(lines[2]).toBe(
      "For the person: Fix the JSON near line 4, column 1 of ~/.config/epimethian-mcp/profiles.json, then run: epimethian-mcp profiles",
    );
    expect(r.text).not.toContain(".bak");
    expect(r.text).toContain("Restart: needed");
    for (const v of Object.values(r)) expect(v).not.toContain(CANARY);
    // No Confluence request was attempted, and no user directory is named.
    expect(r.text).not.toContain(home);
  });

  it("with a .bak present: the .bak clause is appended to the fix line", async () => {
    const r = await bootWith(async () => {
      await writeFile(registry(), `{"profiles": "${CANARY}"}`, { mode: 0o600 });
      await writeFile(`${registry()}.bak`, `{"profiles": ["work"]}`, { mode: 0o600 });
    });
    const forPerson = r.text.split("\n")[2]!;
    expect(forPerson).toContain("Fix the top level of ~/.config/epimethian-mcp/profiles.json");
    expect(forPerson).toContain(
      "The version before the last CLI change is ~/.config/epimethian-mcp/profiles.json.bak",
    );
    expect(r.text).not.toContain(CANARY);
  });

  it("mode 0666: the fix is chmod 600", async () => {
    const r = await bootWith(async () => {
      await writeFile(registry(), `{"profiles": ["work"]}`, { mode: 0o600 });
      await chmod(registry(), 0o666);
    });
    expect(r.text.split("\n")[2]).toBe("For the person: chmod 600 ~/.config/epimethian-mcp/profiles.json");
  });

  it("an absent registry is not a recovery case (starts normally past getConfig)", async () => {
    process.env.CONFLUENCE_PROFILE = "work";
    mockReadFromKeychain.mockResolvedValue(null);
    const { main } = await importIndex();
    await main();
    // Missing keychain entry -> profile-missing, not registry-unreadable.
    expect(mockMcpServer.mock.calls[0][0].name).toBe("confluence-work-setup-needed");
  });
});
