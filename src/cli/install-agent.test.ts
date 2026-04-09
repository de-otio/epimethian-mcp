import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Set env vars before module evaluation
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    registerTool: mockRegisterTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../server/confluence-client.js", () => ({
  resolveSpaceId: vi.fn(),
  getPage: vi.fn(),
  createPage: vi.fn(),
  updatePage: vi.fn(),
  deletePage: vi.fn(),
  searchPages: vi.fn(),
  listPages: vi.fn(),
  getPageChildren: vi.fn(),
  getSpaces: vi.fn(),
  getPageByTitle: vi.fn(),
  getAttachments: vi.fn(),
  uploadAttachment: vi.fn(),
  getLabels: vi.fn(),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
  getFooterComments: vi.fn(),
  getInlineComments: vi.fn(),
  getCommentReplies: vi.fn(),
  createFooterComment: vi.fn(),
  createInlineComment: vi.fn(),
  resolveComment: vi.fn(),
  deleteFooterComment: vi.fn(),
  deleteInlineComment: vi.fn(),
  formatPage: vi.fn().mockReturnValue("formatted"),
  sanitizeError: (msg: string) => msg,
  getConfig: vi.fn().mockResolvedValue({
    url: "https://test.atlassian.net",
    email: "user@test.com",
    profile: null,
    apiV2: "https://test.atlassian.net/wiki/api/v2",
    apiV1: "https://test.atlassian.net/wiki/rest/api",
    authHeader: "Basic dGVzdA==",
    jsonHeaders: {},
  }),
  validateStartup: vi.fn().mockResolvedValue(undefined),
}));

let guideContent: string;
let registeredToolNames: string[];

beforeAll(async () => {
  // Load the install guide
  const guidePath = resolve(__dirname, "../../install-agent.md");
  guideContent = await readFile(guidePath, "utf-8");

  // Import server to collect registered tools
  const { main } = await import("../server/index.js");
  await main();
  registeredToolNames = mockRegisterTool.mock.calls.map(
    (call: unknown[]) => call[0] as string
  );
});

describe("install-agent.md consistency", () => {
  it("lists exactly the tools the server registers", () => {
    // Extract tool names from the guide's Available Tools table
    const toolTableMatches = guideContent.matchAll(
      /\| `(\w+)` \|/g
    );
    const guideToolNames = [...toolTableMatches].map((m) => m[1]);

    expect(guideToolNames.sort()).toEqual(registeredToolNames.sort());
  });

  it("states the correct tool count", () => {
    expect(guideContent).toContain(
      `Available Tools (${registeredToolNames.length})`
    );
  });

  it("references the correct npm package name", () => {
    expect(guideContent).toContain("@de-otio/epimethian-mcp");
    // Warn against unscoped
    expect(guideContent).toContain("Do NOT install unscoped");
  });

  it("uses absolute paths in the MCP config example, not relative", () => {
    // The config example should use a placeholder for absolute path, not a bare command name
    expect(guideContent).toContain("<absolute path from Step 2>");
    // Should instruct the agent to resolve the path
    expect(guideContent).toContain("which epimethian-mcp");
  });

  it("does not put API token in the MCP config example", () => {
    // Extract the JSON config block from the guide
    const jsonMatch = guideContent.match(
      /```json\s*\n([\s\S]*?)\n```/
    );
    expect(jsonMatch).not.toBeNull();
    const configBlock = jsonMatch![1];
    expect(configBlock).not.toContain("API_TOKEN");
    expect(configBlock).not.toContain("apiToken");
    expect(configBlock).not.toContain("api_token");
  });

  it("instructs the agent NOT to handle the API token", () => {
    expect(guideContent).toContain(
      "Do NOT ask the user for the API token yourself"
    );
  });

  it("tells the user to run the setup command with --profile", () => {
    expect(guideContent).toContain("epimethian-mcp setup --profile");
  });

  it("uses CONFLUENCE_PROFILE in the MCP config", () => {
    expect(guideContent).toContain("CONFLUENCE_PROFILE");
  });

  it("requires the user to restart the MCP client", () => {
    expect(guideContent).toMatch(/restart/i);
  });
});

describe("install-agent.md covers manual steps and error handling", () => {
  it("explains what the user must do manually vs what the agent does", () => {
    // Agent does: install, configure .mcp.json
    expect(guideContent).toContain("npm install -g");
    // User must do: run setup, restart client
    expect(guideContent).toContain("Tell the user to run");
    expect(guideContent).toMatch(/restart/i);
  });

  it("covers what to do if Node.js is not installed", () => {
    expect(guideContent).toContain("Node.js 18");
  });

  it("provides a way to verify the installation succeeded", () => {
    expect(guideContent).toContain("which epimethian-mcp");
  });

  it("explains validation after setup is complete", () => {
    // The guide should tell the agent how to verify everything works
    expect(guideContent).toMatch(/[Vv]alidat/);
  });
});

describe("MCP server config correctness", () => {
  it("server starts via the exported main() function", async () => {
    // main() was already called in beforeAll — verify it connected
    expect(mockConnect).toHaveBeenCalled();
  });

  it("registers tools with unique names", () => {
    const unique = new Set(registeredToolNames);
    expect(unique.size).toBe(registeredToolNames.length);
  });

  it("server name matches the config key in install-agent.md", async () => {
    // The guide uses "confluence" as the mcpServers key
    expect(guideContent).toContain('"confluence"');
    // The server name registered with MCP SDK should be consistent
    const { McpServer } = await import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    );
    const constructorCall = (McpServer as any).mock.calls[0][0];
    expect(constructorCall.name).toBe("confluence");
  });
});
