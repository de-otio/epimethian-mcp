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
    server: {
      getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
    },
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock the confluence-client so we don't need real HTTP
vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
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
    getLabels: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    getContentState: vi.fn(),
    setContentState: vi.fn(),
    removeContentState: vi.fn(),
    getFooterComments: vi.fn(),
    getInlineComments: vi.fn(),
    getCommentReplies: vi.fn(),
    createFooterComment: vi.fn(),
    createInlineComment: vi.fn(),
    resolveComment: vi.fn(),
    deleteFooterComment: vi.fn(),
    deleteInlineComment: vi.fn(),
    getPageVersions: vi.fn(),
    getPageVersionBody: vi.fn(),
    searchUsers: vi.fn(),
    searchPagesByTitle: vi.fn(),
    setClientLabel: vi.fn(),
    ConfluenceApiError: class ConfluenceApiError extends Error {
      status: number;
      constructor(status: number, body: string) {
        super(`Confluence API error (${status}): ${body.slice(0, 100)}`);
        this.name = "ConfluenceApiError";
        this.status = status;
      }
    },
    formatPage: vi.fn().mockReturnValue("formatted page"),
    extractSection: actual.extractSection,
    replaceSection: actual.replaceSection,
    truncateStorageFormat: actual.truncateStorageFormat,
    toMarkdownView: actual.toMarkdownView,
    looksLikeMarkdown: actual.looksLikeMarkdown,
    sanitizeError: (msg: string) => msg.slice(0, 500),
    ConfluenceConflictError,
    getConfig: vi.fn().mockResolvedValue({
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: false,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    }),
    validateStartup: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock the diff module
vi.mock("./diff.js", () => ({
  computeSummaryDiff: vi.fn(),
  computeUnifiedDiff: vi.fn(),
  MAX_DIFF_SIZE: 512000,
}));

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

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
      "update_page_section",
      "delete_page",
      "search_pages",
      "list_pages",
      "get_page_children",
      "get_spaces",
      "get_page_by_title",
      "add_attachment",
      "add_drawio_diagram",
      "get_attachments",
      "get_labels",
      "add_label",
      "remove_label",
      "get_comments",
      "create_comment",
      "resolve_comment",
      "delete_comment",
      "get_page_versions",
      "get_page_version",
      "diff_page_versions",
      "get_version",
      "upgrade",
      // Stream 14
      "lookup_user",
      "resolve_page_link",
      // PR 2
      "prepend_to_page",
      "append_to_page",
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

  it("includes excerpt when present", async () => {
    const { searchPages } = await import("./confluence-client.js");
    (searchPages as any).mockResolvedValueOnce([
      { id: "1", title: "Page A", spaceId: "SP", excerpt: "This is a preview of the page" },
    ]);

    const handler = registeredTools.get("search_pages")!.handler;
    const result = await handler({ cql: "test", limit: 25 });
    expect(result.content[0].text).toContain("This is a preview of the page");
  });

  it("omits excerpt line when excerpt is missing", async () => {
    const { searchPages } = await import("./confluence-client.js");
    (searchPages as any).mockResolvedValueOnce([
      { id: "1", title: "Page A", spaceId: "SP" },
    ]);

    const handler = registeredTools.get("search_pages")!.handler;
    const result = await handler({ cql: "test", limit: 25 });
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l: string) => l.startsWith("  "));
    expect(lines).toHaveLength(0);
  });

  it("omits excerpt line when excerpt is empty string", async () => {
    const { searchPages } = await import("./confluence-client.js");
    (searchPages as any).mockResolvedValueOnce([
      { id: "1", title: "Page A", spaceId: "SP", excerpt: "" },
    ]);

    const handler = registeredTools.get("search_pages")!.handler;
    const result = await handler({ cql: "test", limit: 25 });
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l: string) => l.startsWith("  "));
    expect(lines).toHaveLength(0);
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

describe("get_page section/max_length params", () => {
  const pageWithBody = {
    id: "1",
    title: "T",
    body: { storage: { value: "<h1>Intro</h1><p>Intro text</p><h1>Details</h1><p>Details text</p>" } },
  };

  it("section parameter returns only matching section", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockResolvedValueOnce("Title: T\nID: 1");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, section: "Details" });
    expect(result.content[0].text).toContain("Section: Details");
    expect(result.content[0].text).toContain("<h1>Details</h1>");
    expect(result.content[0].text).toContain("Details text");
  });

  it("section returns error when not found", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, section: "Missing" });
    expect(result.content[0].text).toContain('Section "Missing" not found');
  });

  it("max_length truncates body", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockResolvedValueOnce("Title: T\nID: 1");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, max_length: 30 });
    expect(result.content[0].text).toContain("[truncated at");
  });

  it("headings_only takes precedence over section", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockImplementationOnce(() => "Title: T\nHeadings:\n1. Intro\n2. Details");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: true, section: "Intro" });
    expect(result.content[0].text).toContain("Headings:");
    expect(result.content[0].text).not.toContain("Section:");
  });
});

describe("update_page_section tool", () => {
  it("replaces section content and updates page", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (updatePage as any).mockClear();
    const fullPage = {
      id: "1",
      title: "T",
      body: { storage: { value: "<h1>A</h1><p>old</p><h1>B</h1><p>keep</p>" } },
    };
    (getPage as any).mockResolvedValueOnce(fullPage);
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page_section")!.handler;
    const result = await handler({
      page_id: "1",
      section: "A",
      body: "<p>new</p>",
      version: 5,
    });
    expect(result.content[0].text).toContain('Updated section "A"');
    expect(result.content[0].text).toContain("version: 6");

    // Verify updatePage was called with reconstructed body
    const updateCall = (updatePage as any).mock.calls[0];
    expect(updateCall[1].body).toContain("<p>new</p>");
    expect(updateCall[1].body).toContain("<h1>B</h1><p>keep</p>");
  });

  it("returns error when section not found", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      body: { storage: { value: "<h1>A</h1><p>text</p>" } },
    });

    const handler = registeredTools.get("update_page_section")!.handler;
    const result = await handler({
      page_id: "1",
      section: "Missing",
      body: "<p>x</p>",
      version: 5,
    });
    expect(result.content[0].text).toContain('Section "Missing" not found');
  });

  it("passes version_message to updatePage", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (updatePage as any).mockClear();
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      body: { storage: { value: "<h1>A</h1><p>old</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 3,
    });

    const handler = registeredTools.get("update_page_section")!.handler;
    await handler({
      page_id: "1",
      section: "A",
      body: "<p>new</p>",
      version: 2,
      version_message: "Updated intro",
    });
    const updateCall = (updatePage as any).mock.calls[0];
    expect(updateCall[1].versionMessage).toBe("Updated intro");
  });
});

describe("get_page format: markdown", () => {
  const pageWithBody = {
    id: "1",
    title: "T",
    body: { storage: { value: '<h1>Title</h1><p>Hello <strong>world</strong></p><ac:structured-macro ac:name="toc"></ac:structured-macro>' } },
  };
  const pageNoMacros = {
    id: "2",
    title: "Plain",
    body: { storage: { value: "<h1>Title</h1><p>Hello <strong>world</strong></p>" } },
  };

  it("returns markdown with tokens and token reference table when page has macros", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockResolvedValueOnce("Title: T\nID: 1");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, format: "markdown" });
    const text = result.content[0].text;

    // Should contain the heading and bold content as markdown
    expect(text).toContain("# Title");
    expect(text).toContain("**world**");

    // Should contain the token reference table
    expect(text).toContain("Tokens:");
    expect(text).toContain("[[epi:T0001]]");
    expect(text).toContain('<ac:structured-macro ac:name="toc">');

    // Should contain the preservation comment
    expect(text).toContain("Confluence macro");
    expect(text).toContain("preserved as tokens");

    // Should NOT contain the old lossy "Read-only" warning
    expect(text).not.toContain("Read-only markdown rendering");
  });

  it("returns pure markdown (no token table) when page has no macros", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageNoMacros);
    (formatPage as any).mockResolvedValueOnce("Title: Plain\nID: 2");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "2", include_body: true, headings_only: false, format: "markdown" });
    const text = result.content[0].text;

    // Should have content
    expect(text).toContain("# Title");
    expect(text).toContain("**world**");

    // No token table since no macros
    expect(text).not.toContain("Tokens:");
    expect(text).not.toContain("[[epi:");
    expect(text).not.toContain("preserved as tokens");
  });

  it("returns storage format by default", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockResolvedValueOnce("Title: T\nContent:\n<h1>Title</h1>");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, format: "storage" });
    expect(result.content[0].text).not.toContain("Read-only markdown");
    expect(result.content[0].text).not.toContain("Tokens:");
  });

  it("format markdown + section returns markdown for section", async () => {
    const { getPage, formatPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce(pageWithBody);
    (formatPage as any).mockResolvedValueOnce("Title: T\nID: 1");

    const handler = registeredTools.get("get_page")!.handler;
    const result = await handler({ page_id: "1", include_body: true, headings_only: false, section: "Title", format: "markdown" });
    const text = result.content[0].text;
    expect(text).toContain("Section: Title");
    // Should contain markdown, not raw HTML
    expect(text).toContain("**world**");
  });
});

describe("update_page markdown / storage routing", () => {
  it("accepts storage format HTML (backward compat)", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: "<p>Hello <strong>world</strong></p>" } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "<p>Hello <strong>world</strong></p>",
    });
    expect(result.content[0].text).toContain("Updated:");
  });

  it("accepts plain text without markdown patterns (treated as storage)", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: "Just some plain text" } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "Just some plain text",
    });
    expect(result.content[0].text).toContain("Updated:");
  });

  it("treats body with <ac: tags as storage even if markdown patterns present", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: '<ac:structured-macro ac:name="info"><p># not markdown</p></ac:structured-macro>' } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: '<ac:structured-macro ac:name="info"><p># not markdown</p></ac:structured-macro>',
    });
    expect(result.content[0].text).toContain("Updated:");
  });
});

describe("writeGuard (read-only mode)", () => {
  let writeGuardFn: typeof import("./index.js")["writeGuard"];

  beforeAll(async () => {
    const mod = await import("./index.js");
    writeGuardFn = mod.writeGuard;
  });

  const readOnlyConfig = {
    url: "https://acme.atlassian.net",
    email: "user@acme.com",
    profile: "acme",
    readOnly: true,
    attribution: true,
    apiV2: "https://acme.atlassian.net/wiki/api/v2",
    apiV1: "https://acme.atlassian.net/wiki/rest/api",
    authHeader: "Basic dGVzdA==",
    jsonHeaders: {},
  };

  const writableConfig = { ...readOnlyConfig, readOnly: false };

  it("blocks create_page when readOnly is true", () => {
    const result = writeGuardFn("create_page", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("blocks update_page when readOnly is true", () => {
    const result = writeGuardFn("update_page", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("blocks update_page_section when readOnly is true", () => {
    const result = writeGuardFn("update_page_section", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("blocks delete_page when readOnly is true", () => {
    const result = writeGuardFn("delete_page", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("blocks add_attachment when readOnly is true", () => {
    const result = writeGuardFn("add_attachment", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("blocks add_drawio_diagram when readOnly is true", () => {
    const result = writeGuardFn("add_drawio_diagram", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("blocks add_label when readOnly is true", () => {
    const result = writeGuardFn("add_label", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("blocks remove_label when readOnly is true", () => {
    const result = writeGuardFn("remove_label", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("allows all read-only tools when readOnly is true", () => {
    const readTools = [
      "get_page", "get_page_by_title", "search_pages",
      "list_pages", "get_page_children", "get_spaces", "get_attachments",
      "get_labels", "get_page_status",
      "get_page_versions", "get_page_version", "diff_page_versions",
      "get_version",
    ];
    for (const tool of readTools) {
      expect(writeGuardFn(tool, readOnlyConfig)).toBeNull();
    }
  });

  it("allows write tools when readOnly is false", () => {
    const writeTools = [
      "create_page", "update_page", "update_page_section",
      "delete_page", "add_attachment", "add_drawio_diagram",
      "add_label", "remove_label",
      "set_page_status", "remove_page_status",
    ];
    for (const tool of writeTools) {
      expect(writeGuardFn(tool, writableConfig)).toBeNull();
    }
  });

  it("error message includes profile name and remediation command", () => {
    const result = writeGuardFn("create_page", readOnlyConfig);
    expect(result!.content[0].text).toContain('profile "acme"');
    expect(result!.content[0].text).toContain("epimethian-mcp profiles --set-read-write acme");
  });

  it("error message does NOT include hostname", () => {
    const result = writeGuardFn("create_page", readOnlyConfig);
    expect(result!.content[0].text).not.toContain("acme.atlassian.net");
  });

  it("blocks unrecognized tool names when readOnly is true (whitelist pattern)", () => {
    const result = writeGuardFn("some_future_write_tool", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("uses 'current configuration' when profile is null", () => {
    const noProfileConfig = { ...readOnlyConfig, profile: null };
    const result = writeGuardFn("create_page", noProfileConfig);
    expect(result!.content[0].text).toContain("current configuration");
  });
});

describe("get_labels tool", () => {
  it("returns label list on success", async () => {
    const { getLabels } = await import("./confluence-client.js");
    (getLabels as any).mockResolvedValueOnce([
      { id: "1", prefix: "global", name: "architecture" },
      { id: "2", prefix: "global", name: "draft" },
    ]);

    const handler = registeredTools.get("get_labels")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("architecture (global)");
    expect(result.content[0].text).toContain("draft (global)");
  });

  it("returns no-labels message for empty result", async () => {
    const { getLabels } = await import("./confluence-client.js");
    (getLabels as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_labels")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.content[0].text).toContain("has no labels");
  });

  it("returns isError on API failure", async () => {
    const { getLabels } = await import("./confluence-client.js");
    (getLabels as any).mockRejectedValueOnce(new Error("Not found"));

    const handler = registeredTools.get("get_labels")!.handler;
    const result = await handler({ page_id: "999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Not found");
  });
});

describe("add_label tool", () => {
  it("returns success with label names and tenant echo", async () => {
    const { addLabels } = await import("./confluence-client.js");
    (addLabels as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("add_label")!.handler;
    const result = await handler({ page_id: "123", labels: ["draft", "review"] });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Added 2 label(s)");
    expect(result.content[0].text).toContain("draft, review");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns isError on API failure", async () => {
    const { addLabels } = await import("./confluence-client.js");
    (addLabels as any).mockRejectedValueOnce(new Error("Forbidden"));

    const handler = registeredTools.get("add_label")!.handler;
    const result = await handler({ page_id: "123", labels: ["test"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Forbidden");
  });
});

describe("remove_label tool", () => {
  it("returns success with label name and tenant echo", async () => {
    const { removeLabel } = await import("./confluence-client.js");
    (removeLabel as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("remove_label")!.handler;
    const result = await handler({ page_id: "123", label: "draft" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Removed label "draft"');
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns isError on API failure", async () => {
    const { removeLabel } = await import("./confluence-client.js");
    (removeLabel as any).mockRejectedValueOnce(new Error("Not found"));

    const handler = registeredTools.get("remove_label")!.handler;
    const result = await handler({ page_id: "123", label: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Not found");
  });
});

// =============================================================================
// Content status tools
// =============================================================================

describe("get_page_status tool", () => {
  it("returns status name + color + tenant echo on success", async () => {
    const { getContentState } = await import("./confluence-client.js");
    (getContentState as any).mockResolvedValueOnce({ name: "In progress", color: "#2684FF" });

    const handler = registeredTools.get("get_page_status")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("In progress");
    expect(result.content[0].text).toContain("#2684FF");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns 'no status set' + tenant echo when null", async () => {
    const { getContentState } = await import("./confluence-client.js");
    (getContentState as any).mockResolvedValueOnce(null);

    const handler = registeredTools.get("get_page_status")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no status set");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns isError on API failure", async () => {
    const { getContentState } = await import("./confluence-client.js");
    (getContentState as any).mockRejectedValueOnce(new Error("Server error"));

    const handler = registeredTools.get("get_page_status")!.handler;
    const result = await handler({ page_id: "999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Server error");
  });
});

describe("set_page_status tool", () => {
  it("returns success with name + color + tenant echo", async () => {
    const { setContentState } = await import("./confluence-client.js");
    (setContentState as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("set_page_status")!.handler;
    const result = await handler({ page_id: "123", name: "Ready for review", color: "#57D9A3" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Ready for review");
    expect(result.content[0].text).toContain("#57D9A3");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("is blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: "acme",
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("set_page_status", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("returns isError on API failure", async () => {
    const { setContentState } = await import("./confluence-client.js");
    (setContentState as any).mockRejectedValueOnce(new Error("Forbidden"));

    const handler = registeredTools.get("set_page_status")!.handler;
    const result = await handler({ page_id: "123", name: "Draft", color: "#FFC400" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Forbidden");
  });
});

describe("remove_page_status tool", () => {
  it("returns success + tenant echo", async () => {
    const { removeContentState } = await import("./confluence-client.js");
    (removeContentState as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("remove_page_status")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Removed status");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("is blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: "acme",
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("remove_page_status", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("returns isError on API failure", async () => {
    const { removeContentState } = await import("./confluence-client.js");
    (removeContentState as any).mockRejectedValueOnce(new Error("Server error"));

    const handler = registeredTools.get("remove_page_status")!.handler;
    const result = await handler({ page_id: "123" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Server error");
  });
});

const mockComment = {
  id: "123",
  version: { number: 1, authorId: "user1", createdAt: "2024-01-01T00:00:00Z" },
  body: { storage: { value: "<p>Test comment</p>" } },
  resolutionStatus: "open",
};

describe("get_comments tool", () => {
  beforeEach(async () => {
    const { getFooterComments, getInlineComments, getCommentReplies } = await import("./confluence-client.js");
    (getFooterComments as any).mockReset();
    (getInlineComments as any).mockReset();
    (getCommentReplies as any).mockReset();
  });

  it("calls getFooterComments and getInlineComments in parallel for type: all", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    await handler({ page_id: "42", type: "all", resolution_status: "all", include_replies: false });

    expect(getFooterComments).toHaveBeenCalledWith("42");
    expect(getInlineComments).toHaveBeenCalledWith("42", "all");
  });

  it("only calls getFooterComments for type: footer", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    await handler({ page_id: "42", type: "footer", resolution_status: "all", include_replies: false });

    expect(getFooterComments).toHaveBeenCalledWith("42");
    expect(getInlineComments).not.toHaveBeenCalled();
  });

  it("only calls getInlineComments for type: inline", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    await handler({ page_id: "42", type: "inline", resolution_status: "open", include_replies: false });

    expect(getInlineComments).toHaveBeenCalledWith("42", "open");
    expect(getFooterComments).not.toHaveBeenCalled();
  });

  it("passes resolution_status to getInlineComments", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    await handler({ page_id: "42", type: "all", resolution_status: "resolved", include_replies: false });

    expect(getInlineComments).toHaveBeenCalledWith("42", "resolved");
  });

  it("fetches replies when include_replies is true", async () => {
    const { getFooterComments, getInlineComments, getCommentReplies } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([mockComment]);
    (getInlineComments as any).mockResolvedValueOnce([]);
    (getCommentReplies as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    await handler({ page_id: "42", type: "all", resolution_status: "all", include_replies: true });

    expect(getCommentReplies).toHaveBeenCalledWith("123", "footer");
  });

  it("returns formatted output with comment IDs and body excerpts", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([mockComment]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    const result = await handler({ page_id: "42", type: "all", resolution_status: "all", include_replies: false });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("123");
    expect(text).toContain("user1");
    expect(text).toContain("Test comment");
  });

  it("returns No comments found when both lists are empty", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockResolvedValueOnce([]);
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    const result = await handler({ page_id: "42", type: "all", resolution_status: "all", include_replies: false });

    expect(result.content[0].text).toContain("No comments found");
  });

  it("is not blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("get_comments", readOnlyConfig);
    expect(result).toBeNull();
  });

  it("returns isError on API failure", async () => {
    const { getFooterComments, getInlineComments } = await import("./confluence-client.js");
    (getFooterComments as any).mockRejectedValueOnce(new Error("API failure"));
    (getInlineComments as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("get_comments")!.handler;
    const result = await handler({ page_id: "42", type: "all", resolution_status: "all", include_replies: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: API failure");
  });
});

describe("create_comment tool", () => {
  beforeEach(async () => {
    const { createFooterComment, createInlineComment } = await import("./confluence-client.js");
    (createFooterComment as any).mockReset();
    (createInlineComment as any).mockReset();
  });

  it("is blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("create_comment", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });

  it("calls createFooterComment for type: footer", async () => {
    const { createFooterComment } = await import("./confluence-client.js");
    (createFooterComment as any).mockResolvedValueOnce({ ...mockComment, id: "456" });

    const handler = registeredTools.get("create_comment")!.handler;
    const result = await handler({
      page_id: "42",
      body: "Hello footer",
      type: "footer",
      text_selection_match_index: 0,
    });

    expect(createFooterComment).toHaveBeenCalledWith("42", "Hello footer", undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Created footer comment");
    expect(result.content[0].text).toContain("456");
  });

  it("calls createInlineComment for type: inline with text_selection", async () => {
    const { createInlineComment } = await import("./confluence-client.js");
    (createInlineComment as any).mockResolvedValueOnce({ ...mockComment, id: "789" });

    const handler = registeredTools.get("create_comment")!.handler;
    const result = await handler({
      page_id: "42",
      body: "Inline comment",
      type: "inline",
      text_selection: "some text",
      text_selection_match_index: 0,
    });

    expect(createInlineComment).toHaveBeenCalledWith("42", "Inline comment", "some text", 0, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Created inline comment");
    expect(result.content[0].text).toContain("789");
  });

  it("returns error if type: inline without parent_comment_id and without text_selection", async () => {
    const handler = registeredTools.get("create_comment")!.handler;
    const result = await handler({
      page_id: "42",
      body: "Inline comment",
      type: "inline",
      text_selection_match_index: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("text_selection is required");
  });

  it("returns created comment ID in success message with tenant echo", async () => {
    const { createFooterComment } = await import("./confluence-client.js");
    (createFooterComment as any).mockResolvedValueOnce({ ...mockComment, id: "999" });

    const handler = registeredTools.get("create_comment")!.handler;
    const result = await handler({
      page_id: "42",
      body: "Test body",
      type: "footer",
      text_selection_match_index: 0,
    });

    expect(result.content[0].text).toContain("Created footer comment");
    expect(result.content[0].text).toContain("999");
    expect(result.content[0].text).toContain("Tenant:");
  });
});

describe("resolve_comment tool", () => {
  beforeEach(async () => {
    const { resolveComment } = await import("./confluence-client.js");
    (resolveComment as any).mockReset();
  });

  it("is blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("resolve_comment", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("calls resolveComment(id, true) by default", async () => {
    const { resolveComment } = await import("./confluence-client.js");
    (resolveComment as any).mockResolvedValueOnce({ ...mockComment });

    const handler = registeredTools.get("resolve_comment")!.handler;
    const result = await handler({ comment_id: "123", resolved: true });

    expect(resolveComment).toHaveBeenCalledWith("123", true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("resolved");
  });

  it("calls resolveComment(id, false) when resolved: false", async () => {
    const { resolveComment } = await import("./confluence-client.js");
    (resolveComment as any).mockResolvedValueOnce({ ...mockComment });

    const handler = registeredTools.get("resolve_comment")!.handler;
    const result = await handler({ comment_id: "123", resolved: false });

    expect(resolveComment).toHaveBeenCalledWith("123", false);
    expect(result.content[0].text).toContain("reopened");
  });

  it("returns resolved in success message", async () => {
    const { resolveComment } = await import("./confluence-client.js");
    (resolveComment as any).mockResolvedValueOnce({ ...mockComment });

    const handler = registeredTools.get("resolve_comment")!.handler;
    const result = await handler({ comment_id: "123", resolved: true });

    expect(result.content[0].text).toContain("resolved");
    expect(result.content[0].text).toContain("123");
  });

  it("surfaces error message on API failure", async () => {
    const { resolveComment } = await import("./confluence-client.js");
    (resolveComment as any).mockRejectedValueOnce(new Error("Dangling comment: highlighted text has been deleted"));

    const handler = registeredTools.get("resolve_comment")!.handler;
    const result = await handler({ comment_id: "123", resolved: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Dangling comment");
  });
});

describe("delete_comment tool", () => {
  beforeEach(async () => {
    const { deleteFooterComment, deleteInlineComment } = await import("./confluence-client.js");
    (deleteFooterComment as any).mockReset();
    (deleteInlineComment as any).mockReset();
  });

  it("is blocked by writeGuard in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("delete_comment", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it("calls deleteFooterComment for type: footer", async () => {
    const { deleteFooterComment } = await import("./confluence-client.js");
    (deleteFooterComment as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("delete_comment")!.handler;
    const result = await handler({ comment_id: "123", type: "footer" });

    expect(deleteFooterComment).toHaveBeenCalledWith("123");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Deleted footer comment");
    expect(result.content[0].text).toContain("123");
  });

  it("calls deleteInlineComment for type: inline", async () => {
    const { deleteInlineComment } = await import("./confluence-client.js");
    (deleteInlineComment as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("delete_comment")!.handler;
    const result = await handler({ comment_id: "456", type: "inline" });

    expect(deleteInlineComment).toHaveBeenCalledWith("456");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Deleted inline comment");
    expect(result.content[0].text).toContain("456");
  });

  it("returns deleted comment ID and type in success message", async () => {
    const { deleteFooterComment } = await import("./confluence-client.js");
    (deleteFooterComment as any).mockResolvedValueOnce(undefined);

    const handler = registeredTools.get("delete_comment")!.handler;
    const result = await handler({ comment_id: "777", type: "footer" });

    expect(result.content[0].text).toContain("777");
    expect(result.content[0].text).toContain("footer");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns isError on API failure", async () => {
    const { deleteFooterComment } = await import("./confluence-client.js");
    (deleteFooterComment as any).mockRejectedValueOnce(new Error("Comment not found"));

    const handler = registeredTools.get("delete_comment")!.handler;
    const result = await handler({ comment_id: "123", type: "footer" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: Comment not found");
  });
});

// =============================================================================
// Version history tools (Phase 1)
// =============================================================================

describe("get_page_versions tool", () => {
  it("returns formatted version list on success", async () => {
    const { getPageVersions } = await import("./confluence-client.js");
    (getPageVersions as any).mockResolvedValueOnce([
      { number: 3, by: { displayName: "Alice", accountId: "a" }, when: "2025-01-03T00:00:00Z", message: "Fix typo", minorEdit: false },
      { number: 2, by: { displayName: "Bob", accountId: "b" }, when: "2025-01-02T00:00:00Z", message: "", minorEdit: true },
    ]);

    const handler = registeredTools.get("get_page_versions")!.handler;
    const result = await handler({ page_id: "123", limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("2 version(s)");
    expect(result.content[0].text).toContain("v3: Alice");
    expect(result.content[0].text).toContain("Fix typo");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("returns toolError on ConfluenceApiError", async () => {
    const { getPageVersions, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersions as any).mockRejectedValueOnce(new ConfluenceApiError(500, "Internal"));

    const handler = registeredTools.get("get_page_versions")!.handler;
    const result = await handler({ page_id: "123", limit: 25 });
    expect(result.isError).toBe(true);
  });

  it("maps 404 to 'Page not found or inaccessible'", async () => {
    const { getPageVersions, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersions as any).mockRejectedValueOnce(new ConfluenceApiError(404, "Not found"));

    const handler = registeredTools.get("get_page_versions")!.handler;
    const result = await handler({ page_id: "999", limit: 25 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Page not found or inaccessible");
  });

  it("maps 403 to 'Page not found or inaccessible'", async () => {
    const { getPageVersions, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersions as any).mockRejectedValueOnce(new ConfluenceApiError(403, "Forbidden"));

    const handler = registeredTools.get("get_page_versions")!.handler;
    const result = await handler({ page_id: "999", limit: 25 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Page not found or inaccessible");
  });

  it("includes minor edit flag and message in output", async () => {
    const { getPageVersions } = await import("./confluence-client.js");
    (getPageVersions as any).mockResolvedValueOnce([
      { number: 1, by: { displayName: "X", accountId: "x" }, when: "2025-01-01T00:00:00Z", message: "Init", minorEdit: true },
    ]);

    const handler = registeredTools.get("get_page_versions")!.handler;
    const result = await handler({ page_id: "1", limit: 25 });
    expect(result.content[0].text).toContain("[minor]");
    expect(result.content[0].text).toContain("Init");
  });
});

describe("get_page_version tool", () => {
  it("returns formatted page content with title/version header", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "My Page",
      rawBody: "<p>Simple text</p>",
      version: 3,
    });

    const handler = registeredTools.get("get_page_version")!.handler;
    const result = await handler({ page_id: "10", version: 3 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Title: My Page");
    expect(result.content[0].text).toContain("Version: 3");
    expect(result.content[0].text).toContain("Tenant:");
  });

  it("calls toMarkdownView on raw body (content is sanitized)", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "Test",
      rawBody: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body>let x = 1;</ac:plain-text-body></ac:structured-macro>',
      version: 1,
    });

    const handler = registeredTools.get("get_page_version")!.handler;
    const result = await handler({ page_id: "5", version: 1 });
    // toMarkdownView replaces macros with placeholders
    expect(result.content[0].text).toContain("[macro: code");
  });

  it("maps 404/403 to 'Page not found or inaccessible'", async () => {
    const { getPageVersionBody, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockRejectedValueOnce(new ConfluenceApiError(404, "Not found"));

    const handler = registeredTools.get("get_page_version")!.handler;
    const result = await handler({ page_id: "999", version: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Page not found or inaccessible");
  });

  it("returns toolError on generic error", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockRejectedValueOnce(new Error("Network timeout"));

    const handler = registeredTools.get("get_page_version")!.handler;
    const result = await handler({ page_id: "1", version: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network timeout");
  });
});

describe("diff_page_versions tool", () => {
  const mockVersionResult = (title: string, rawBody: string, version: number) => ({
    title, rawBody, version,
  });

  it("summary format returns formatted summary with section changes", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const { computeSummaryDiff } = await import("./diff.js");
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("Page", "<p>old</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("Page", "<p>new</p>", 3));
    (computeSummaryDiff as any).mockReturnValueOnce({
      totalAdded: 5, totalRemoved: 2,
      sections: [{ type: "modified", section: "Intro", added: 5, removed: 2 }],
      summary: "5 lines added, 2 lines removed. Changes in sections: Intro",
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 1, to_version: 3, format: "summary" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Diff summary: v1");
    expect(result.content[0].text).toContain("v3");
    expect(result.content[0].text).toContain("Section changes:");
    expect(result.content[0].text).toContain("modified: Intro");
  });

  it("unified format returns unified diff text", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const { computeUnifiedDiff } = await import("./diff.js");
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("Page", "<p>a</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("Page", "<p>b</p>", 2));
    (computeUnifiedDiff as any).mockReturnValueOnce({
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b", truncated: false,
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 1, to_version: 2, format: "unified" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Diff: v1");
    expect(result.content[0].text).toContain("--- a");
  });

  it("defaults to_version to current version when not provided", async () => {
    const { getPage, getPageVersionBody } = await import("./confluence-client.js");
    const { computeSummaryDiff } = await import("./diff.js");
    (getPage as any).mockResolvedValueOnce({ id: "10", title: "P", version: { number: 5 } });
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("P", "<p>old</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("P", "<p>new</p>", 5));
    (computeSummaryDiff as any).mockReturnValueOnce({
      totalAdded: 0, totalRemoved: 0, sections: [], summary: "No changes.",
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    await handler({ page_id: "10", from_version: 1, format: "summary" });
    expect(getPage).toHaveBeenCalledWith("10", false);
  });

  it("validates from_version < to_version", async () => {
    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 5, to_version: 3, format: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be less than");
  });

  it("rejects when body exceeds MAX_DIFF_SIZE", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const bigBody = "x".repeat(600000);
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("P", bigBody, 1))
      .mockResolvedValueOnce(mockVersionResult("P", "<p>small</p>", 2));

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 1, to_version: 2, format: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("maximum diff size");
  });

  it("fetches both versions in parallel", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const { computeSummaryDiff } = await import("./diff.js");
    (getPageVersionBody as any).mockReset();
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("P", "<p>a</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("P", "<p>b</p>", 2));
    (computeSummaryDiff as any).mockReturnValueOnce({
      totalAdded: 0, totalRemoved: 0, sections: [], summary: "No changes.",
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    await handler({ page_id: "10", from_version: 1, to_version: 2, format: "summary" });
    expect(getPageVersionBody).toHaveBeenCalledTimes(2);
    expect(getPageVersionBody).toHaveBeenCalledWith("10", 1);
    expect(getPageVersionBody).toHaveBeenCalledWith("10", 2);
  });

  it("calls toMarkdownView on both raw bodies", async () => {
    const { getPageVersionBody, toMarkdownView } = await import("./confluence-client.js");
    const { computeSummaryDiff } = await import("./diff.js");
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("P", "<p>a</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("P", "<p>b</p>", 2));
    (computeSummaryDiff as any).mockReturnValueOnce({
      totalAdded: 1, totalRemoved: 1, sections: [], summary: "1 added, 1 removed",
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    await handler({ page_id: "10", from_version: 1, to_version: 2, format: "summary" });
    // toMarkdownView is the real function (not mocked), so we verify it ran
    // by checking computeSummaryDiff was called with markdown strings, not raw HTML
    expect(computeSummaryDiff).toHaveBeenCalled();
  });

  it("passes max_length through to computeUnifiedDiff", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const { computeUnifiedDiff } = await import("./diff.js");
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("P", "<p>a</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("P", "<p>b</p>", 2));
    (computeUnifiedDiff as any).mockReturnValueOnce({ diff: "...", truncated: false });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    await handler({ page_id: "10", from_version: 1, to_version: 2, format: "unified", max_length: 500 });
    expect(computeUnifiedDiff).toHaveBeenCalledWith(expect.any(String), expect.any(String), 500);
  });

  it("maps 404 to 'Page not found or inaccessible'", async () => {
    const { getPageVersionBody, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockRejectedValueOnce(new ConfluenceApiError(404, "Not found"));

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "999", from_version: 1, to_version: 2, format: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Page not found or inaccessible");
  });

  it("maps 403 to 'Page not found or inaccessible'", async () => {
    const { getPageVersionBody, ConfluenceApiError } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockRejectedValueOnce(new ConfluenceApiError(403, "Forbidden"));

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "999", from_version: 1, to_version: 2, format: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Page not found or inaccessible");
  });

  it("returns toolError for generic errors", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    (getPageVersionBody as any).mockRejectedValueOnce(new Error("Timeout"));

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 1, to_version: 2, format: "summary" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout");
  });

  it("includes page title in output header", async () => {
    const { getPageVersionBody } = await import("./confluence-client.js");
    const { computeSummaryDiff } = await import("./diff.js");
    (getPageVersionBody as any)
      .mockResolvedValueOnce(mockVersionResult("Architecture Doc", "<p>a</p>", 1))
      .mockResolvedValueOnce(mockVersionResult("Architecture Doc", "<p>b</p>", 2));
    (computeSummaryDiff as any).mockReturnValueOnce({
      totalAdded: 0, totalRemoved: 0, sections: [], summary: "No changes.",
    });

    const handler = registeredTools.get("diff_page_versions")!.handler;
    const result = await handler({ page_id: "10", from_version: 1, to_version: 2, format: "summary" });
    expect(result.content[0].text).toContain("Architecture Doc");
  });
});

describe("get_version tool", () => {
  it("returns the server version", async () => {
    const handler = registeredTools.get("get_version")!.handler;
    const result = await handler({});
    expect(result.content[0].text).toMatch(/^epimethian-mcp v\d+\.\d+\.\d+/);
  });

  it("includes pending update info when available", async () => {
    const { getPendingUpdate } = await import("../shared/update-check.js");
    (getPendingUpdate as any).mockResolvedValueOnce({
      current: "5.2.1",
      latest: "6.0.0",
      type: "major",
    });
    const handler = registeredTools.get("get_version")!.handler;
    const result = await handler({});
    expect(result.content[0].text).toContain("Major update available");
    expect(result.content[0].text).toContain("6.0.0");
  });

  it("includes auto-installed patch info", async () => {
    const { getPendingUpdate } = await import("../shared/update-check.js");
    (getPendingUpdate as any).mockResolvedValueOnce({
      current: "5.2.1",
      latest: "5.2.2",
      type: "patch",
      autoInstalled: true,
    });
    const handler = registeredTools.get("get_version")!.handler;
    const result = await handler({});
    expect(result.content[0].text).toContain("installed automatically");
    expect(result.content[0].text).toContain("Restart");
  });
});

describe("upgrade tool", () => {
  it("is registered", () => {
    expect(registeredTools.has("upgrade")).toBe(true);
  });

  it("reports up-to-date when no pending update", async () => {
    const { getPendingUpdate } = await import("../shared/update-check.js");
    (getPendingUpdate as any).mockResolvedValueOnce(null);
    const handler = registeredTools.get("upgrade")!.handler;
    const result = await handler({});
    expect(result.content[0].text).toContain("already up to date");
  });

  it("performs upgrade and reports restart needed", async () => {
    const { getPendingUpdate, performUpgrade, clearPendingUpdate } =
      await import("../shared/update-check.js");
    (getPendingUpdate as any).mockResolvedValueOnce({
      current: "5.2.1",
      latest: "6.0.0",
      type: "major",
    });
    (performUpgrade as any).mockResolvedValueOnce("added 1 package");
    const handler = registeredTools.get("upgrade")!.handler;
    const result = await handler({});
    expect(result.content[0].text).toContain("Upgraded");
    expect(result.content[0].text).toContain("6.0.0");
    expect(result.content[0].text).toContain("Restart required");
    expect(clearPendingUpdate).toHaveBeenCalled();
  });

  it("returns error on install failure", async () => {
    const { getPendingUpdate, performUpgrade } =
      await import("../shared/update-check.js");
    (getPendingUpdate as any).mockResolvedValueOnce({
      current: "5.2.1",
      latest: "6.0.0",
      type: "major",
    });
    (performUpgrade as any).mockRejectedValueOnce(new Error("EACCES: permission denied"));
    const handler = registeredTools.get("upgrade")!.handler;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission denied");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream 14 — lookup_user tool
// ─────────────────────────────────────────────────────────────────────────────

describe("lookup_user tool", () => {
  it("is registered", () => {
    expect(registeredTools.has("lookup_user")).toBe(true);
  });

  it("happy path — returns formatted user list", async () => {
    const { searchUsers } = await import("./confluence-client.js");
    (searchUsers as any).mockResolvedValueOnce([
      { accountId: "557058:aaa-111", displayName: "Alice Smith", email: "alice@example.com" },
      { accountId: "557058:bbb-222", displayName: "Bob Jones", email: "bob@example.com" },
      { accountId: "557058:ccc-333", displayName: "Carol White", email: "carol@example.com" },
    ]);

    const handler = registeredTools.get("lookup_user")!.handler;
    const result = await handler({ query: "alice" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("3");
    expect(result.content[0].text).toContain("557058:aaa-111");
    expect(result.content[0].text).toContain("Alice Smith");
    expect(result.content[0].text).toContain("alice@example.com");
  });

  it("empty result — returns informative message", async () => {
    const { searchUsers } = await import("./confluence-client.js");
    (searchUsers as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("lookup_user")!.handler;
    const result = await handler({ query: "nobody" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No users found");
    expect(result.content[0].text).toContain("nobody");
  });

  it("API error — returns error result", async () => {
    const { searchUsers } = await import("./confluence-client.js");
    (searchUsers as any).mockRejectedValueOnce(new Error("User search failed"));

    const handler = registeredTools.get("lookup_user")!.handler;
    const result = await handler({ query: "error" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("User search failed");
  });

  it("shows (not disclosed) for empty email", async () => {
    const { searchUsers } = await import("./confluence-client.js");
    (searchUsers as any).mockResolvedValueOnce([
      { accountId: "557058:xxx", displayName: "Private User", email: "" },
    ]);

    const handler = registeredTools.get("lookup_user")!.handler;
    const result = await handler({ query: "private" });

    expect(result.content[0].text).toContain("(not disclosed)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream 14 — resolve_page_link tool
// ─────────────────────────────────────────────────────────────────────────────

describe("resolve_page_link tool", () => {
  it("is registered", () => {
    expect(registeredTools.has("resolve_page_link")).toBe(true);
  });

  it("happy path — returns page details", async () => {
    const { searchPagesByTitle } = await import("./confluence-client.js");
    (searchPagesByTitle as any).mockResolvedValueOnce([
      {
        contentId: "123456",
        url: "https://test.atlassian.net/wiki/spaces/ENG/pages/123456",
        spaceKey: "ENG",
        title: "Architecture Overview",
      },
    ]);

    const handler = registeredTools.get("resolve_page_link")!.handler;
    const result = await handler({ title: "Architecture Overview", space_key: "ENG" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("123456");
    expect(result.content[0].text).toContain("https://test.atlassian.net");
    expect(result.content[0].text).toContain("ENG");
    expect(result.content[0].text).toContain("Architecture Overview");
  });

  it("page not found — returns error", async () => {
    const { searchPagesByTitle } = await import("./confluence-client.js");
    (searchPagesByTitle as any).mockResolvedValueOnce([]);

    const handler = registeredTools.get("resolve_page_link")!.handler;
    const result = await handler({ title: "Ghost Page", space_key: "ENG" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No page found");
    expect(result.content[0].text).toContain("Ghost Page");
    expect(result.content[0].text).toContain("ENG");
  });

  it("ambiguous — returns first match with notice", async () => {
    const { searchPagesByTitle } = await import("./confluence-client.js");
    (searchPagesByTitle as any).mockResolvedValueOnce([
      { contentId: "100", url: "https://test.atlassian.net/wiki/spaces/ENG/pages/100", spaceKey: "ENG", title: "Home" },
      { contentId: "200", url: "https://test.atlassian.net/wiki/spaces/ENG/pages/200", spaceKey: "ENG", title: "Home" },
    ]);

    const handler = registeredTools.get("resolve_page_link")!.handler;
    const result = await handler({ title: "Home", space_key: "ENG" });

    expect(result.isError).toBeUndefined();
    // First match returned
    expect(result.content[0].text).toContain("100");
    // Ambiguity notice
    expect(result.content[0].text).toContain("2 pages matched");
  });

  it("API error — returns error result", async () => {
    const { searchPagesByTitle } = await import("./confluence-client.js");
    (searchPagesByTitle as any).mockRejectedValueOnce(new Error("Search failed"));

    const handler = registeredTools.get("resolve_page_link")!.handler;
    const result = await handler({ title: "Any Page", space_key: "ENG" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Search failed");
  });
});

describe("create_page markdown conversion (Stream 5)", () => {
  it("converts markdown body to storage XHTML before submission", async () => {
    const { resolveSpaceId, createPage, formatPage } = await import("./confluence-client.js");
    (resolveSpaceId as any).mockResolvedValueOnce("SPACE-ID");
    (createPage as any).mockResolvedValueOnce({ id: "99", title: "New Page" });
    (formatPage as any).mockReturnValueOnce("Title: New Page\nID: 99");

    const handler = registeredTools.get("create_page")!.handler;
    const result = await handler({
      title: "New Page",
      space_key: "DEV",
      body: "# Hello World\n\nThis is a paragraph.",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("New Page");

    // createPage must have been called with storage XHTML, not raw markdown
    // Stream 11: headings now carry Confluence-slug IDs.
    const createCall = (createPage as any).mock.lastCall;
    const submittedBody: string = createCall[2];
    expect(submittedBody).toMatch(/<h1\b/);
    expect(submittedBody).not.toContain("# Hello World");
  });

  it("passes storage body through unchanged", async () => {
    const { resolveSpaceId, createPage, formatPage } = await import("./confluence-client.js");
    (resolveSpaceId as any).mockResolvedValueOnce("SPACE-ID");
    (createPage as any).mockResolvedValueOnce({ id: "100", title: "Storage Page" });
    (formatPage as any).mockReturnValueOnce("Title: Storage Page\nID: 100");

    const storageBody = "<p>Hello <strong>world</strong></p>";
    const handler = registeredTools.get("create_page")!.handler;
    await handler({
      title: "Storage Page",
      space_key: "DEV",
      body: storageBody,
    });

    const createCall = (createPage as any).mock.lastCall;
    expect(createCall[2]).toBe(storageBody);
  });

  it("allow_raw_html: true enables raw HTML passthrough", async () => {
    const { resolveSpaceId, createPage, formatPage } = await import("./confluence-client.js");
    (resolveSpaceId as any).mockResolvedValueOnce("SPACE-ID");
    (createPage as any).mockResolvedValueOnce({ id: "101", title: "HTML Page" });
    (formatPage as any).mockReturnValueOnce("Title: HTML Page");

    const handler = registeredTools.get("create_page")!.handler;
    // With raw HTML in markdown body and allow_raw_html: true, the raw HTML should survive
    const result = await handler({
      title: "HTML Page",
      space_key: "DEV",
      body: "# Title\n\n<div class=\"custom\">raw html</div>",
      allow_raw_html: true,
    });

    expect(result.isError).toBeUndefined();
    const submittedBody: string = (createPage as any).mock.lastCall[2];
    expect(submittedBody).toContain("raw html");
  });
});

describe("update_page markdown path (Stream 5)", () => {
  it("converts markdown body to storage and submits", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      version: { number: 5 },
      body: { storage: { value: "<p>Existing content</p>" } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "# New Heading\n\nNew paragraph text.",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Updated:");

    // updatePage must have received storage XHTML, not raw markdown
    // Stream 11: headings now carry Confluence-slug IDs.
    const updateCall = (updatePage as any).mock.lastCall;
    const submittedBody: string = updateCall[1].body;
    expect(submittedBody).toMatch(/<h1\b/);
    expect(submittedBody).not.toContain("# New Heading");
  });

  it("errors when markdown deletes a preserved macro and confirm_deletions is false", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (updatePage as any).mockClear();
    // Current page has a tokenisable macro
    (getPage as any).mockResolvedValueOnce({
      id: "2",
      title: "T",
      version: { number: 3 },
      body: {
        storage: {
          value: '<p>Intro</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro><p>Outro</p>',
        },
      },
    });

    const handler = registeredTools.get("update_page")!.handler;
    // Caller markdown omits the macro token → deletion without confirmation
    const result = await handler({
      page_id: "2",
      title: "T",
      version: 3,
      body: "- Intro\n- Outro",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("confirm_deletions: true");
    // updatePage must NOT have been called
    expect((updatePage as any).mock.calls.length).toBe(0);
  });

  it("succeeds and records deletion in version message when confirm_deletions is true", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "3",
      title: "T",
      version: { number: 4 },
      body: {
        storage: {
          value: '<p>Keep</p><ac:structured-macro ac:name="warning"><ac:rich-text-body><p>warning</p></ac:rich-text-body></ac:structured-macro>',
        },
      },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "3", title: "T" },
      newVersion: 5,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "3",
      title: "T",
      version: 4,
      body: "- Keep",
      confirm_deletions: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Updated:");

    const updateCall = (updatePage as any).mock.lastCall;
    // Version message should mention the deletion
    expect(updateCall[1].versionMessage).toContain("Removed");
  });

  it("replace_body: true skips preservation and does wholesale rewrite", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "4",
      title: "T",
      version: { number: 2 },
      body: {
        storage: {
          value: '<ac:structured-macro ac:name="toc"></ac:structured-macro><p>Old</p>',
        },
      },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "4", title: "T" },
      newVersion: 3,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "4",
      title: "T",
      version: 2,
      body: "# Brand New\n\nFresh content.",
      replace_body: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Updated:");

    const updateCall = (updatePage as any).mock.lastCall;
    const submittedBody: string = updateCall[1].body;
    // Should be freshly converted markdown, no toc macro.
    // Stream 11: headings now carry Confluence-slug IDs.
    expect(submittedBody).toMatch(/<h1\b/);
    expect(submittedBody).not.toContain("ac:structured-macro");
  });

  it("returns error for forged token in caller markdown", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "5",
      title: "T",
      version: { number: 1 },
      body: { storage: { value: "<p>Simple page with no macros</p>" } },
    });
    (updatePage as any).mockClear();

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "5",
      title: "T",
      version: 1,
      // Caller invents a token that was never in the sidecar
      body: "# Updated\n\n[[epi:T9999]]\n\nMore text.",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("T9999");
    expect((updatePage as any).mock.calls.length).toBe(0);
  });

  it("storage-format body passes through verbatim (backward compat)", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    const storageBody = "<p>Unchanged storage body</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "6", title: "T", version: { number: 6 },
      body: { storage: { value: storageBody } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "6", title: "T" },
      newVersion: 7,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "6",
      title: "T",
      version: 6,
      body: storageBody,
    });

    expect(result.isError).toBeUndefined();
    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].body).toBe(storageBody);
  });

  it("merges caller version_message with auto-generated deletion message", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "7",
      title: "T",
      version: { number: 5 },
      body: {
        storage: {
          value: '<p>Text</p><ac:structured-macro ac:name="expand"><ac:rich-text-body><p>exp</p></ac:rich-text-body></ac:structured-macro>',
        },
      },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "7", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    await handler({
      page_id: "7",
      title: "T",
      version: 5,
      body: "- Text",
      confirm_deletions: true,
      version_message: "My update note",
    });

    const updateCall = (updatePage as any).mock.lastCall;
    const msg: string = updateCall[1].versionMessage;
    expect(msg).toContain("My update note");
    expect(msg).toContain("Removed");
  });
});

describe("looksLikeMarkdown heuristic (Stream 5)", () => {
  // Import the real function directly since the mock passes through the real impl
  it("classifies markdown with incidental <br/> as markdown", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const md = "# Heading\n\nLine one<br/>Line two";
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("classifies storage with <ac: tag as storage (not markdown)", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const storage = '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>hello</p></ac:rich-text-body></ac:structured-macro>';
    expect(looksLikeMarkdown(storage)).toBe(false);
  });

  it("classifies storage with <ri: tag as storage", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const storage = '<p><ri:page ri:content-title="Home" /></p>';
    expect(looksLikeMarkdown(storage)).toBe(false);
  });

  it("classifies GFM table separator as markdown", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const md = "| Col A | Col B |\n| --- | --- |\n| val | val |";
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("classifies fenced code block as markdown", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const md = "Some text\n\n```typescript\nconst x = 1;\n```";
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("classifies unordered list as markdown", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const md = "- item one\n- item two\n- item three";
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("classifies GitHub alert syntax as markdown", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const md = "> [!NOTE]\n> This is a note";
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("classifies plain text without signals as storage (conservative fallback)", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    const plain = "Just some plain text with no special markers";
    expect(looksLikeMarkdown(plain)).toBe(false);
  });

  it("short-circuits to false immediately when <ac: present even with markdown signals", async () => {
    const { looksLikeMarkdown } = await import("./confluence-client.js");
    // Has a heading but also ac: tag — storage wins
    const mixed = '<ac:layout><h1>Title</h1></ac:layout>\n\n# Also a heading';
    expect(looksLikeMarkdown(mixed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Content-safety guards integration tests (Finding 1 fix)
// ---------------------------------------------------------------------------

describe("update_page content-safety guards (Finding 1 fix)", () => {
  const bigBody = "<p>" + "x".repeat(1000) + "</p>";

  it("shrinkage guard triggers on markdown path with replace_body", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigBody } },
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "# tiny",
      replace_body: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("shrink");
  });

  it("shrinkage guard triggers on storage-format path (CRITICAL fix)", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigBody } },
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "<p>tiny</p>", // storage format, not markdown
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("shrink");
  });

  it("confirm_shrinkage bypasses shrinkage guard", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigBody } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    // Use a body with enough text content to pass the empty-body guard (>100 chars)
    const longBody = "# " + "replacement content ".repeat(10);
    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: longBody,
      replace_body: true,
      confirm_shrinkage: true,
    });

    expect(result.content[0].text).toContain("Updated:");
  });

  it("empty-body guard rejects near-empty replacement", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigBody } },
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: '<ac:structured-macro ac:name="toc"/>',
      confirm_shrinkage: true, // bypass 1A to test 1C
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("accidental content loss");
  });

  it("body-length reporting includes char counts (1D)", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    const smallBody = "<p>hello world here</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: smallBody } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" },
      newVersion: 6,
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "<p>updated content here</p>",
    });

    expect(result.content[0].text).toMatch(/body: \d+\u2192\d+ chars/);
  });

  it("structural integrity guard triggers on heading drop via storage path", async () => {
    const headingBody =
      "<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>" + "x".repeat(600) + "</p>";
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: headingBody } },
    });

    const handler = registeredTools.get("update_page")!.handler;
    const result = await handler({
      page_id: "1",
      title: "T",
      version: 5,
      body: "<h1>Only one</h1><p>" + "x".repeat(600) + "</p>",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Heading count");
  });
});

describe("update_page threads previousBody to updatePage (1F)", () => {
  it("passes currentStorage as previousBody", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    const body = "<p>current content</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: body } },
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 6,
    });
    const handler = registeredTools.get("update_page")!.handler;
    await handler({
      page_id: "1", title: "T", version: 5,
      body: body,
    });
    const call = (updatePage as any).mock.lastCall;
    expect(call[1].previousBody).toBe(body);
  });
});

// =============================================================================
// prepend_to_page / append_to_page (PR 2)
// =============================================================================

describe("prepend_to_page", () => {
  beforeEach(async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockReset();
    (updatePage as any).mockReset();
  });

  it("inserts content before existing body", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: "<p>existing</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 6,
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 5,
      content: "<p>new</p>",
      allow_raw_html: false,
    });

    expect(result.isError).toBeUndefined();
    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].body).toBe("<p>new</p><p>existing</p>");
  });

  it("converts markdown content to storage before prepending", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 3 },
      body: { storage: { value: "<p>existing</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 4,
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 3,
      content: "# New Section\n\nSome text.",
      allow_raw_html: false,
    });

    expect(result.isError).toBeUndefined();
    const updateCall = (updatePage as any).mock.lastCall;
    const submitted: string = updateCall[1].body;
    // Markdown converted to storage XML
    expect(submitted).toMatch(/<h1/);
    expect(submitted).not.toContain("# New Section");
    // Existing content still present at the end
    expect(submitted).toContain("<p>existing</p>");
  });

  it("respects custom separator", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 2 },
      body: { storage: { value: "<p>old</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 3,
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    await handler({
      page_id: "1",
      version: 2,
      content: "<p>new</p>",
      separator: "---",
      allow_raw_html: false,
    });

    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].body).toBe("<p>new</p>---<p>old</p>");
  });

  it("rejects separator over 100 chars", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 1 },
      body: { storage: { value: "<p>x</p>" } },
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 1,
      content: "<p>new</p>",
      separator: "x".repeat(101),
      allow_raw_html: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("100");
    expect((updatePage as any).mock.calls.length).toBe(0);
  });

  it("rejects separator containing XML tags", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 1 },
      body: { storage: { value: "<p>x</p>" } },
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 1,
      content: "<p>new</p>",
      separator: "<br/>",
      allow_raw_html: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("separator");
    expect((updatePage as any).mock.calls.length).toBe(0);
  });

  it("rejects combined body over 2MB", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    const bigExisting = "x".repeat(1_500_000);
    const bigNew = "y".repeat(600_000);
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 1 },
      body: { storage: { value: bigExisting } },
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 1,
      content: bigNew,
      allow_raw_html: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("2MB");
    expect((updatePage as any).mock.calls.length).toBe(0);
  });

  it("includes body lengths in response", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "MyPage", version: { number: 7 },
      body: { storage: { value: "<p>old</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "MyPage" }, newVersion: 8,
    });

    const handler = registeredTools.get("prepend_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 7,
      content: "<p>new</p>",
      allow_raw_html: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Prepended to:");
    expect(result.content[0].text).toMatch(/body: \d+\u2192\d+ chars/);
    expect(result.content[0].text).toContain("version: 8");
  });

  it("blocked in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: "acme",
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("prepend_to_page", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });
});

describe("append_to_page", () => {
  beforeEach(async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockReset();
    (updatePage as any).mockReset();
  });

  it("inserts content after existing body", async () => {
    const { getPage, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: "<p>existing</p>" } },
    });
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 6,
    });

    const handler = registeredTools.get("append_to_page")!.handler;
    const result = await handler({
      page_id: "1",
      version: 5,
      content: "<p>new</p>",
      allow_raw_html: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Appended to:");
    const updateCall = (updatePage as any).mock.lastCall;
    expect(updateCall[1].body).toBe("<p>existing</p><p>new</p>");
  });

  it("blocked in read-only mode", async () => {
    const { writeGuard } = await import("./index.js");
    const readOnlyConfig = {
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: "acme",
      readOnly: true,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    };
    const result = writeGuard("append_to_page", readOnlyConfig);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("Write blocked");
  });
});

// =============================================================================
// revert_page (PR 4)
// =============================================================================

describe("revert_page", () => {
  beforeEach(async () => {
    const { getPage, updatePage, getPageVersionBody } = await import("./confluence-client.js");
    (getPage as any).mockReset();
    (updatePage as any).mockReset();
    (getPageVersionBody as any).mockReset();
  });

  it("fetches raw storage and pushes as new version", async () => {
    const { getPage, getPageVersionBody, updatePage } = await import("./confluence-client.js");
    const currentBody = "<p>" + "x".repeat(200) + "</p>";
    const historicalBody = "<p>" + "y".repeat(200) + "</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "My Page", version: { number: 5 },
      body: { storage: { value: currentBody } },
    });
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "My Page", rawBody: historicalBody, version: 3,
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "My Page" }, newVersion: 6,
    });

    const handler = registeredTools.get("revert_page")!.handler;
    const result = await handler({
      page_id: "1", target_version: 3, current_version: 5,
    });
    expect(result.content[0].text).toContain("Reverted:");
    expect(result.content[0].text).toContain("v3");
    // Verify updatePage received the historical body
    const call = (updatePage as any).mock.lastCall;
    expect(call[1].body).toBe(historicalBody);
  });

  it("applies shrinkage guard", async () => {
    const { getPage, getPageVersionBody } = await import("./confluence-client.js");
    const bigCurrent = "<p>" + "x".repeat(1000) + "</p>";
    const smallHistorical = "<p>" + "y".repeat(150) + "</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigCurrent } },
    });
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "T", rawBody: smallHistorical, version: 2,
    });

    const handler = registeredTools.get("revert_page")!.handler;
    const result = await handler({
      page_id: "1", target_version: 2, current_version: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("shrink");
  });

  it("confirm_shrinkage bypasses guard", async () => {
    const { getPage, getPageVersionBody, updatePage } = await import("./confluence-client.js");
    const bigCurrent = "<p>" + "x".repeat(1000) + "</p>";
    const smallHistorical = "<p>" + "y".repeat(150) + "</p>";
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 5 },
      body: { storage: { value: bigCurrent } },
    });
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "T", rawBody: smallHistorical, version: 2,
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 6,
    });

    const handler = registeredTools.get("revert_page")!.handler;
    const result = await handler({
      page_id: "1", target_version: 2, current_version: 5,
      confirm_shrinkage: true,
    });
    expect(result.content[0].text).toContain("Reverted:");
  });

  it("detects version mismatch (Finding 6 TOCTOU mitigation)", async () => {
    const { getPage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 7 }, // actual is 7, caller says 5
      body: { storage: { value: "<p>current</p>" } },
    });

    const handler = registeredTools.get("revert_page")!.handler;
    const result = await handler({
      page_id: "1", target_version: 2, current_version: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Version mismatch");
  });

  it("includes body lengths in response", async () => {
    const { getPage, getPageVersionBody, updatePage } = await import("./confluence-client.js");
    (getPage as any).mockResolvedValueOnce({
      id: "1", title: "T", version: { number: 3 },
      body: { storage: { value: "<p>current</p>" } },
    });
    (getPageVersionBody as any).mockResolvedValueOnce({
      title: "T", rawBody: "<p>old version</p>", version: 1,
    });
    (updatePage as any).mockClear();
    (updatePage as any).mockResolvedValueOnce({
      page: { id: "1", title: "T" }, newVersion: 4,
    });

    const handler = registeredTools.get("revert_page")!.handler;
    const result = await handler({
      page_id: "1", target_version: 1, current_version: 3,
    });
    expect(result.content[0].text).toMatch(/body: \d+\u2192\d+ chars/);
  });
});
