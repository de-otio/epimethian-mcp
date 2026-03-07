import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set env vars BEFORE module evaluation via vi.hoisted (runs before imports)
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

// Mock keychain to prevent actual OS keychain access
vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
}));

import {
  PageSchema,
  toStorageFormat,
  formatPage,
  resolveSpaceId,
  getPage,
  createPage,
  updatePage,
  deletePage,
  searchPages,
  listPages,
  getPageChildren,
  getSpaces,
  getPageByTitle,
  getAttachments,
  uploadAttachment,
} from "./confluence-client.js";

// --- Helpers ---

const BASE_URL = "https://test.atlassian.net";
const API_V2 = `${BASE_URL}/wiki/api/v2`;
const API_V1 = `${BASE_URL}/wiki/rest/api`;

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  const fn = vi.fn();
  for (const [i, r] of responses.entries()) {
    const status = r.status ?? 200;
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(JSON.stringify(r.body)),
    });
  }
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// D3 — Zod schemas
// =============================================================================

describe("Zod schemas", () => {
  describe("PageSchema", () => {
    it("parses a valid page with all fields", () => {
      const data = {
        id: "123",
        title: "My Page",
        spaceId: "SPACE1",
        space: { key: "DEV" },
        version: { number: 3 },
        body: { storage: { value: "<p>hi</p>" }, value: "hi" },
        _links: { base: "https://x.atlassian.net/wiki", webui: "/spaces/DEV/pages/123" },
      };
      const result = PageSchema.parse(data);
      expect(result.id).toBe("123");
      expect(result.title).toBe("My Page");
      expect(result.version?.number).toBe(3);
    });

    it("parses a page with missing optional fields", () => {
      const result = PageSchema.parse({ id: "1", title: "T" });
      expect(result.id).toBe("1");
      expect(result.spaceId).toBeUndefined();
      expect(result.version).toBeUndefined();
      expect(result.body).toBeUndefined();
      expect(result._links).toBeUndefined();
    });

    it("rejects data missing required id", () => {
      expect(() => PageSchema.parse({ title: "T" })).toThrow();
    });

    it("rejects data missing required title", () => {
      expect(() => PageSchema.parse({ id: "1" })).toThrow();
    });
  });
});

// =============================================================================
// D5 — Formatting helpers
// =============================================================================

describe("toStorageFormat", () => {
  it("wraps plain text in <p> tags", () => {
    expect(toStorageFormat("hello world")).toBe("<p>hello world</p>");
  });

  it("wraps HTML that does not match the tag regex (e.g. <div>)", () => {
    // The regex /<[a-z][\s>\/]/i requires a single letter then whitespace/>/slash
    // <div> has <d then i, which doesn't match — so it gets wrapped
    expect(toStorageFormat("<div>content</div>")).toBe("<p><div>content</div></p>");
  });

  it("passes through tags matching the regex like <p>", () => {
    const html = "<p>content</p>";
    expect(toStorageFormat(html)).toBe(html);
  });

  it("passes through self-closing single-letter tags like <i/>", () => {
    const html = "<i/> some text";
    expect(toStorageFormat(html)).toBe(html);
  });

  it("passes tags with attributes through", () => {
    const html = '<p class="x">text</p>';
    expect(toStorageFormat(html)).toBe(html);
  });
});

describe("formatPage", () => {
  it("formats a page without body", async () => {
    const page = {
      id: "42",
      title: "Test",
      spaceId: "SP1",
      version: { number: 5 },
      _links: { base: "https://x.atlassian.net/wiki", webui: "/spaces/SP1/pages/42" },
    };
    const result = await formatPage(page, false);
    expect(result).toContain("Title: Test");
    expect(result).toContain("ID: 42");
    expect(result).toContain("Space: SP1");
    expect(result).toContain("Version: 5");
    expect(result).toContain("URL: https://x.atlassian.net/wiki/spaces/SP1/pages/42");
    expect(result).not.toContain("Content:");
  });

  it("formats a page with body (storage format)", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: { storage: { value: "<p>Hello</p>" } },
    };
    const result = await formatPage(page, true);
    expect(result).toContain("Content:");
    expect(result).toContain("<p>Hello</p>");
  });

  it("uses body.value when storage is missing", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: { value: "fallback content" },
    };
    const result = await formatPage(page, true);
    expect(result).toContain("fallback content");
  });

  it("handles missing _links gracefully", async () => {
    const page = { id: "42", title: "Test" };
    const result = await formatPage(page, false);
    // Falls back to constructed URL
    expect(result).toContain("URL: https://test.atlassian.net/wiki/pages/42");
  });

  it("handles missing version gracefully", async () => {
    const page = { id: "42", title: "Test" };
    const result = await formatPage(page, false);
    expect(result).toContain("Version: 0");
  });

  it("uses space.key when spaceId is missing", async () => {
    const page = { id: "42", title: "Test", space: { key: "FOO" } };
    const result = await formatPage(page, false);
    expect(result).toContain("Space: FOO");
  });

  it("shows N/A when no space info available", async () => {
    const page = { id: "42", title: "Test" };
    const result = await formatPage(page, false);
    expect(result).toContain("Space: N/A");
  });
});

// =============================================================================
// D4 — Public API functions (fetch mocked)
// =============================================================================

describe("resolveSpaceId", () => {
  it("returns the space id on success", async () => {
    global.fetch = mockFetchResponse({
      results: [{ id: "space-1", key: "DEV", name: "Dev Space", type: "global" }],
    });
    const id = await resolveSpaceId("DEV");
    expect(id).toBe("space-1");
    expect(global.fetch).toHaveBeenCalledOnce();
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V2}/spaces`);
    expect(url).toContain("keys=DEV");
  });

  it("throws when space is not found", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    await expect(resolveSpaceId("NOPE")).rejects.toThrow("Space 'NOPE' not found");
  });
});

describe("getPage", () => {
  const samplePage = { id: "10", title: "P", spaceId: "s1" };

  it("includes body-format param when includeBody is true", async () => {
    global.fetch = mockFetchResponse(samplePage);
    await getPage("10", true);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("body-format=storage");
  });

  it("does not include body-format when includeBody is false", async () => {
    global.fetch = mockFetchResponse(samplePage);
    await getPage("10", false);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain("body-format");
  });

  it("returns parsed PageData", async () => {
    global.fetch = mockFetchResponse(samplePage);
    const page = await getPage("10", false);
    expect(page.id).toBe("10");
    expect(page.title).toBe("P");
  });
});

describe("createPage", () => {
  const createdPage = { id: "20", title: "New Page" };

  it("sends correct payload without parentId", async () => {
    global.fetch = mockFetchResponse(createdPage);
    const page = await createPage("spaceA", "New Page", "body text");
    expect(page.id).toBe("20");
    const call = (global.fetch as any).mock.calls[0];
    const url = call[0] as string;
    const opts = call[1] as RequestInit;
    expect(url).toBe(`${API_V2}/pages`);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.title).toBe("New Page");
    expect(body.spaceId).toBe("spaceA");
    expect(body.body.value).toBe("<p>body text</p>");
    expect(body.parentId).toBeUndefined();
  });

  it("includes parentId when provided", async () => {
    global.fetch = mockFetchResponse(createdPage);
    await createPage("spaceA", "New Page", "body", "parent-1");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.parentId).toBe("parent-1");
  });
});

describe("updatePage", () => {
  it("auto-increments version number", async () => {
    // First call: getPage (current page), second call: v2Put (update)
    global.fetch = mockFetchSequence([
      { body: { id: "30", title: "Old Title", version: { number: 5 }, body: { storage: { value: "<p>old</p>" } } } },
      { body: { id: "30", title: "New Title" } },
    ]);
    const { page, newVersion } = await updatePage("30", { title: "New Title" });
    expect(newVersion).toBe(6);
    expect(page.title).toBe("New Title");
  });

  it("sends body when provided", async () => {
    global.fetch = mockFetchSequence([
      { body: { id: "30", title: "T", version: { number: 1 } } },
      { body: { id: "30", title: "T" } },
    ]);
    await updatePage("30", { body: "new body" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[1][1].body as string);
    expect(putBody.body.value).toBe("<p>new body</p>");
  });

  it("omits body from payload when not provided", async () => {
    global.fetch = mockFetchSequence([
      { body: { id: "30", title: "T", version: { number: 1 } } },
      { body: { id: "30", title: "Updated" } },
    ]);
    await updatePage("30", { title: "Updated" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[1][1].body as string);
    expect(putBody.body).toBeUndefined();
  });
});

describe("deletePage", () => {
  it("sends DELETE request", async () => {
    global.fetch = mockFetchResponse(undefined, 204);
    await deletePage("99");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toContain(`${API_V2}/pages/99`);
    expect(call[1].method).toBe("DELETE");
  });
});

describe("searchPages", () => {
  it("returns results from CQL search", async () => {
    global.fetch = mockFetchResponse({
      results: [{ id: "1", title: "Found" }],
    });
    const pages = await searchPages('title ~ "Found"', 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Found");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V1}/content/search`);
  });

  it("returns empty array when no results", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const pages = await searchPages("nothing", 10);
    expect(pages).toHaveLength(0);
  });
});

describe("listPages", () => {
  it("passes params correctly", async () => {
    global.fetch = mockFetchResponse({ results: [{ id: "1", title: "P" }] });
    const pages = await listPages("spaceX", 50, "current");
    expect(pages).toHaveLength(1);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("space-id=spaceX");
    expect(url).toContain("limit=50");
    expect(url).toContain("status=current");
  });
});

describe("getPageChildren", () => {
  it("returns child pages", async () => {
    global.fetch = mockFetchResponse({
      results: [{ id: "c1", title: "Child" }],
    });
    const children = await getPageChildren("parent-1", 10);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("c1");
  });

  it("returns empty array when no children", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const children = await getPageChildren("parent-1", 10);
    expect(children).toHaveLength(0);
  });
});

describe("getSpaces", () => {
  it("returns spaces without type filter", async () => {
    global.fetch = mockFetchResponse({
      results: [{ id: "s1", key: "DEV", name: "Dev", type: "global" }],
    });
    const spaces = await getSpaces(25);
    expect(spaces).toHaveLength(1);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain("type=");
  });

  it("includes type filter when provided", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    await getSpaces(25, "personal");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("type=personal");
  });
});

describe("getPageByTitle", () => {
  it("returns the page when found", async () => {
    global.fetch = mockFetchResponse({
      results: [{ id: "50", title: "Target" }],
    });
    const page = await getPageByTitle("spaceX", "Target", false);
    expect(page).toBeDefined();
    expect(page!.id).toBe("50");
  });

  it("returns undefined when not found", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const page = await getPageByTitle("spaceX", "Missing", false);
    expect(page).toBeUndefined();
  });

  it("passes body-format when includeBody is true", async () => {
    global.fetch = mockFetchResponse({ results: [{ id: "50", title: "T" }] });
    await getPageByTitle("spaceX", "T", true);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("body-format=storage");
  });
});

describe("getAttachments", () => {
  it("returns attachments with extensions", async () => {
    global.fetch = mockFetchResponse({
      results: [
        {
          id: "att-1",
          title: "file.png",
          extensions: { fileSize: 1024, mediaType: "image/png" },
          _links: { download: "/download/file.png" },
        },
      ],
    });
    const atts = await getAttachments("page-1", 10);
    expect(atts).toHaveLength(1);
    expect(atts[0].extensions?.mediaType).toBe("image/png");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V1}/content/page-1/child/attachment`);
  });

  it("returns empty array when no attachments", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const atts = await getAttachments("page-1", 10);
    expect(atts).toHaveLength(0);
  });
});

describe("uploadAttachment", () => {
  it("sends FormData with file and returns attachment info", async () => {
    global.fetch = mockFetchResponse({
      results: [{ title: "file.txt", id: "att-1", extensions: { fileSize: 42 } }],
    });
    const fileData = Buffer.from("hello");
    const result = await uploadAttachment("page-1", fileData, "file.txt", "a comment");
    expect(result.title).toBe("file.txt");
    expect(result.id).toBe("att-1");
    expect(result.fileSize).toBe(42);

    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toContain(`${API_V1}/content/page-1/child/attachment`);
    expect(call[1].method).toBe("POST");
    // Check that body is FormData
    expect(call[1].body).toBeInstanceOf(FormData);
    // Check headers include X-Atlassian-Token
    expect(call[1].headers["X-Atlassian-Token"]).toBe("nocheck");
  });

  it("works without comment", async () => {
    global.fetch = mockFetchResponse({
      results: [{ title: "file.txt", id: "att-2" }],
    });
    const result = await uploadAttachment("page-1", Buffer.from("data"), "file.txt");
    expect(result.title).toBe("file.txt");
    expect(result.fileSize).toBeUndefined();
  });

  it("throws when results are empty", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    await expect(
      uploadAttachment("page-1", Buffer.from("data"), "file.txt")
    ).rejects.toThrow("Attachment uploaded but no details returned.");
  });
});

// =============================================================================
// D2 — HTTP error handling (tested indirectly through public API)
// =============================================================================

describe("HTTP error handling", () => {
  it("throws on 400 response", async () => {
    global.fetch = mockFetchResponse("Bad Request", 400);
    await expect(getPage("1", false)).rejects.toThrow("Confluence API error (400)");
  });

  it("throws on 401 response", async () => {
    global.fetch = mockFetchResponse("Unauthorized", 401);
    await expect(resolveSpaceId("X")).rejects.toThrow("Confluence API error (401)");
  });

  it("throws on 404 response", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    await expect(deletePage("999")).rejects.toThrow("Confluence API error (404)");
  });

  it("throws on 500 response", async () => {
    global.fetch = mockFetchResponse("Internal Server Error", 500);
    await expect(searchPages("cql", 10)).rejects.toThrow("Confluence API error (500)");
  });

  it("throws on uploadAttachment with non-ok response", async () => {
    global.fetch = mockFetchResponse("Server Error", 500);
    await expect(
      uploadAttachment("page-1", Buffer.from("data"), "f.txt")
    ).rejects.toThrow("Confluence API error (500)");
  });
});
