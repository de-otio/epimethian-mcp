/**
 * 0-T5: boot the real `main()` with a syntax-error registry, over an
 * in-memory transport to a real MCP client. The server must come up in
 * recovery mode: `tools/list` is exactly `["setup_profile"]`, and the
 * instructions name the fix. Only the keychain, the update check and the
 * stdio transport are replaced; the registry is real, in a temp HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const boot = vi.hoisted(() => {
  process.env.EPIMETHIAN_MUTATION_LOG = "false";
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
  return { serverTransport: undefined as unknown, fetches: 0 };
});

vi.mock("../shared/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/keychain.js")>();
  return {
    ...actual,
    readFromKeychain: vi.fn(async () => ({
      url: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "token-not-a-secret",
    })),
    saveToKeychain: vi.fn(async () => {
      throw new Error("no keychain writes in this test");
    }),
  };
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return boot.serverTransport;
  }),
}));
vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

const CANARY = "CANARY-b00t-0a1b";
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recovery-boot-"));
  await chmod(home, 0o700);
  const configDir = join(home, ".config", "epimethian-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDir, "profiles.json"),
    `{"profiles": ["work"], "settings": {"work": {"posture": "read-only", "spaces": ["${CANARY}"]}},}`,
    { mode: 0o600 },
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("CONFLUENCE_PROFILE", "work");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      boot.fetches++;
      throw new Error("no network in this test");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("0-T5 main() with a syntax-error registry", () => {
  it("exposes only setup_profile and names the fix in the instructions", async () => {
    vi.resetModules();
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    boot.serverTransport = serverTransport;

    const { main } = await import("./index.js");
    await main();

    const client = new Client({ name: "recovery-boot-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["setup_profile"]);
    expect(client.getServerVersion()?.name).toBe("confluence-work-config-error");

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(
      // Column 103: the closing brace after the trailing comma.
      "The person must fix it: Fix the JSON near line 1, column 103 of ~/.config/epimethian-mcp/profiles.json, then run: epimethian-mcp profiles. Call the setup_profile tool",
    );
    expect(instructions).not.toContain(CANARY);

    const result = (await client.callTool({ name: "setup_profile", arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    const text = result.content[0]!.text;
    expect(text.startsWith("Withheld [REGISTRY_UNREADABLE]: ")).toBe(true);
    expect(text).not.toContain(CANARY);
    expect(boot.fetches).toBe(0);
    await client.close();
  });
});
