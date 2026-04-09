import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Set env vars before module evaluation
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

// Mock keychain to prevent actual OS keychain access
vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// Mock the MCP SDK so the module doesn't try to connect to stdio
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

// Mock the confluence-client so we don't need real HTTP
vi.mock("./confluence-client.js", () => {
  class ConfluenceConflictError extends Error {
    constructor(pageId: string) {
      super(`Version conflict: page ${pageId} has been modified since you last read it. Call get_page to fetch the latest version, then retry your update with the new version number.`);
      this.name = "ConfluenceConflictError";
    }
  }
  return {
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
    formatPage: vi.fn().mockReturnValue("formatted page"),
    sanitizeError: (msg: string) => msg.slice(0, 500),
    ConfluenceConflictError,
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
  };
});

// Mock node:fs/promises for add_attachment and add_drawio_diagram tests
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdtemp = vi.fn();
const mockRm = vi.fn();
const mockRealpath = vi.fn((p: string) => Promise.resolve(p));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdtemp: (...args: unknown[]) => mockMkdtemp(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  realpath: (...args: unknown[]) => mockRealpath(...(args as [string])),
}));

// We need to dynamically import AFTER mocks are set up
let registeredTools: Map<string, { handler: Function; schema: any }>;

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  // Collect registered tools from mockRegisterTool calls
  registeredTools = new Map();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, config, handler] = call;
    registeredTools.set(name, { handler, schema: config });
  }
});

describe("MCP server index", () => {
  it("connects to the transport", () => {
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("registers all expected tools", () => {
    const expectedTools = [
      "create_page",
      "get_page",
      "update_page",
      "delete_page",
      "search_pages",
      "list_pages",
      "get_page_children",
      "get_spaces",
      "get_page_by_title",
      "add_attachment",
      "add_drawio_diagram",
      "get_attachments",
    ];
    for (const tool of expectedTools) {
      expect(registeredTools.has(tool), `tool "${tool}" should be registered`).toBe(true);
    }
  });
});

describe("toolResult / toolError behavior", () => {
  it("get_page returns success result", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({ id: "1", title: "T" });
    (formatPage as any).mockReturnValueOnce("Title: T\nID: 1");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Title: T");
    expect(result.isError).toBeUndefined();
  });

  it("get_page returns error result on failure", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockRejectedValueOnce(new Error("Not found"));

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "bad", include_body: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Not found");
  });

  it("toolError handles non-Error thrown values", async () => {
    const { deletePage } = await import("./confluence-client.js");
    (deletePage as any).mockRejectedValueOnce("string error");

    const handler = registeredTools.get("delete_page")!.handler;
    const result = await handler({ page_id: "1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: string error");
  });
});

describe("add_attachment path security", () => {
  it("rejects file paths outside cwd", async () => {
    const handler = registeredTools.get("add_attachment")!.handler;
    const result = await handler({
      page_id: "1",
      file_path: "/etc/passwd",
      filename: "passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be under the working directory");
  });

  it("accepts file paths inside cwd", async () => {
    const { uploadAttachment } = await import("./confluence-client.js");
    (uploadAttachment as any).mockResolvedValueOnce({
      title: "test.txt",
      id: "att-1",
      fileSize: 100,
    });

    mockReadFile.mockResolvedValueOnce(Buffer.from("data"));

    const handler = registeredTools.get("add_attachment")!.handler;
    const cwd = process.cwd();
    const result = await handler({
      page_id: "1",
      file_path: `${cwd}/test.txt`,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Attached: test.txt");
  });
});

describe("add_drawio_diagram filename normalization", () => {
  it("appends .drawio if not present", async () => {
    const { uploadAttachment, getPage, updatePage } = await import(
      "./confluence-client.js"
    );
    (uploadAttachment as any).mockResolvedValueOnce({
      title: "arch.drawio",
      id: "att-1",
    });
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      version: { number: 3 },
      body: { storage: { value: "<p>existing</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 4,
    });

    mockMkdtemp.mockResolvedValueOnce("/tmp/drawio-xyz");
    mockWriteFile.mockResolvedValueOnce(undefined);
    mockReadFile.mockResolvedValueOnce(Buffer.from("<mxfile/>"));
    mockRm.mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("add_drawio_diagram")!.handler;
    const result = await handler({
      page_id: "1",
      diagram_xml: "<mxfile/>",
      diagram_name: "arch",
      append: true,
    });

    // Check that uploadAttachment was called with .drawio extension
    expect((uploadAttachment as any).mock.lastCall[2]).toBe("arch.drawio");
    expect(result.content[0].text).toContain("arch.drawio");

    // Verify updatePage received version and title from getPage
    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].version).toBe(3);
    expect(updateCall[1].title).toBe("T");
  });

  it("does not double-append .drawio", async () => {
    const { uploadAttachment, getPage, updatePage } = await import(
      "./confluence-client.js"
    );
    (uploadAttachment as any).mockResolvedValueOnce({
      title: "arch.drawio",
      id: "att-1",
    });
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      version: { number: 1 },
      body: { storage: { value: "" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 2,
    });

    mockMkdtemp.mockResolvedValueOnce("/tmp/drawio-abc");
    mockWriteFile.mockResolvedValueOnce(undefined);
    mockReadFile.mockResolvedValueOnce(Buffer.from("<mxfile/>"));
    mockRm.mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("add_drawio_diagram")!.handler;
    await handler({
      page_id: "1",
      diagram_xml: "<mxfile/>",
      diagram_name: "arch.drawio",
      append: false,
    });

    expect((uploadAttachment as any).mock.lastCall[2]).toBe("arch.drawio");

    // Verify updatePage received version and title from getPage
    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].version).toBe(1);
    expect(updateCall[1].title).toBe("T");
  });
});

describe("search_pages tool", () => {
  it("formats results correctly", async () => {
    const { searchPages } = await import("./confluence-client.js");
    (searchPages as any).mockResolvedValueOnce([
      { id: "1", title: "Page A", spaceId: "SP" },
      { id: "2", title: "Page B", space: { key: "SP2" } },
    ]);

    const handler = registeredTools.get("search_pages")!.handler;
    const result = await handler({ cql: 'title ~ "test"', limit: 25 });
    expect(result.content[0].text).toContain("Found 2 page(s):");
    expect(result.content[0].text).toContain("Page A");
    expect(result.content[0].text).toContain("Page B");
  });

  it("returns message when no results found", async () => {
    const { searchPages } = await import("./confluence-client.js");
    (searchPages as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("search_pages")!.handler;
    const result = await handler({ cql: "nothing", limit: 25 });
    expect(result.content[0].text).toContain("No pages found");
  });
});

describe("get_spaces tool", () => {
  it("formats spaces list", async () => {
    const { getSpaces } = await import("./confluence-client.js");
    (getSpaces as any).mockResolvedValueOnce([
      { id: "s1", key: "DEV", name: "Development", type: "global" },
    ]);

    const handler = registeredTools.get("get_spaces")!.handler;
    const result = await handler({ limit: 25 });
    expect(result.content[0].text).toContain("Development");
    expect(result.content[0].text).toContain("key: DEV");
  });

  it("returns message when no spaces found", async () => {
    const { getSpaces } = await import("./confluence-client.js");
    (getSpaces as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_spaces")!.handler;
    const result = await handler({ limit: 25 });
    expect(result.content[0].text).toContain("No spaces found");
  });
});

describe("get_attachments tool", () => {
  it("formats attachments list with size", async () => {
    const { getAttachments } = await import("./confluence-client.js");
    (getAttachments as any).mockResolvedValueOnce([
      {
        id: "att-1",
        title: "image.png",
        extensions: { fileSize: 2048, mediaType: "image/png" },
      },
    ]);

    const handler = registeredTools.get("get_attachments")!.handler;
    const result = await handler({ page_id: "1", limit: 25 });
    expect(result.content[0].text).toContain("image.png");
    expect(result.content[0].text).toContain("2KB");
    expect(result.content[0].text).toContain("image/png");
  });

  it("handles attachments with missing extensions", async () => {
    const { getAttachments } = await import("./confluence-client.js");
    (getAttachments as any).mockResolvedValueOnce([
      {
        id: "att-2",
        title: "doc.pdf",
        extensions: {},
      },
    ]);

    const handler = registeredTools.get("get_attachments")!.handler;
    const result = await handler({ page_id: "1", limit: 25 });
    expect(result.content[0].text).toContain("doc.pdf");
    expect(result.content[0].text).toContain("unknown size");
  });

  it("returns error on failure", async () => {
    const { getAttachments } = await import("./confluence-client.js");
    (getAttachments as any).mockRejectedValueOnce(new Error("API error"));

    const handler = registeredTools.get("get_attachments")!.handler;
    const result = await handler({ page_id: "1", limit: 25 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: API error");
  });

  it("returns message when no attachments", async () => {
    const { getAttachments } = await import("./confluence-client.js");
    (getAttachments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_attachments")!.handler;
    const result = await handler({ page_id: "1", limit: 25 });
    expect(result.content[0].text).toContain("No attachments found");
  });
});
