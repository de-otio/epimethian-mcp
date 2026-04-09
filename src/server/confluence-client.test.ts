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
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// Mock test-connection to prevent real HTTP during tests
vi.mock("../shared/test-connection.js", () => ({
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  verifyTenantIdentity: vi.fn().mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com", message: "Verified" }),
}));

import {
  PageSchema,
  toStorageFormat,
  formatPage,
  extractHeadings,
  sanitizeError,
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
  extractSection,
  replaceSection,
  truncateStorageFormat,
  toMarkdownView,
  looksLikeMarkdown,
  ConfluenceApiError,
  ConfluenceConflictError,
} from "./confluence-client.js";
import { pageCache } from "./page-cache.js";

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
  pageCache.clear();
});

// =============================================================================
// D3 — Error sanitization
// =============================================================================

describe("sanitizeError", () => {
  it("passes through short safe messages unchanged", () => {
    expect(sanitizeError("Not found")).toBe("Not found");
  });

  it("truncates messages longer than 500 characters", () => {
    const long = "x".repeat(600);
    expect(sanitizeError(long)).toBe("x".repeat(500));
  });

  it("strips Basic auth tokens", () => {
    const msg = "Error with Basic dXNlckBleGFtcGxlLmNvbTp0b2tlbjEyMw== in header";
    const result = sanitizeError(msg);
    expect(result).toContain("Basic [REDACTED]");
    expect(result).not.toContain("dXNlckBleGFtcGxlLmNvbTp0b2tlbjEyMw==");
  });

  it("strips Authorization header values", () => {
    const msg = 'Failed: Authorization: Bearer abc123def456ghi789jkl012mno';
    const result = sanitizeError(msg);
    expect(result).toContain("Authorization: [REDACTED]");
  });

  it("strips Bearer tokens", () => {
    const msg = "Token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature was rejected";
    const result = sanitizeError(msg);
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("handles messages with multiple credential patterns", () => {
    const msg = "Basic dXNlcjp0b2tlbjEyMzQ1Njc4OTA= and Authorization: SecretValue";
    const result = sanitizeError(msg);
    expect(result).not.toContain("dXNlcjp0b2tlbjEyMzQ1Njc4OTA=");
    expect(result).not.toContain("SecretValue");
  });

  it("does not strip short non-credential strings", () => {
    const msg = "Basic error occurred";
    expect(sanitizeError(msg)).toBe("Basic error occurred");
  });
});

// D4 — Zod schemas
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
      expect(result.excerpt).toBeUndefined();
    });

    it("parses a page with excerpt field", () => {
      const result = PageSchema.parse({ id: "1", title: "T", excerpt: "Preview text" });
      expect(result.excerpt).toBe("Preview text");
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

  it("passes through multi-letter HTML tags like <div>", () => {
    expect(toStorageFormat("<div>content</div>")).toBe("<div>content</div>");
  });

  it("passes through other multi-letter tags", () => {
    expect(toStorageFormat("<table><tr><td>data</td></tr></table>")).toBe("<table><tr><td>data</td></tr></table>");
    expect(toStorageFormat("<h1>Title</h1>")).toBe("<h1>Title</h1>");
    expect(toStorageFormat("<img src='x' />")).toBe("<img src='x' />");
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

  it("returns heading outline when headingsOnly is true", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: {
        storage: {
          value: "<h1>Introduction</h1><p>text</p><h2>Background</h2><p>more</p><h2>Goals</h2><h1>Architecture</h1>",
        },
      },
    };
    const result = await formatPage(page, { headingsOnly: true });
    expect(result).toContain("Headings:");
    expect(result).toContain("1. Introduction");
    expect(result).toContain("  1.1. Background");
    expect(result).toContain("  1.2. Goals");
    expect(result).toContain("2. Architecture");
    expect(result).not.toContain("Content:");
    expect(result).not.toContain("<p>");
  });

  it("headingsOnly takes precedence over includeBody", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: { storage: { value: "<h1>Title</h1><p>body text</p>" } },
    };
    const result = await formatPage(page, { includeBody: true, headingsOnly: true });
    expect(result).toContain("Headings:");
    expect(result).not.toContain("Content:");
    expect(result).not.toContain("body text");
  });

  it("headingsOnly with no headings shows fallback message", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: { storage: { value: "<p>Just a paragraph</p>" } },
    };
    const result = await formatPage(page, { headingsOnly: true });
    expect(result).toContain("(no headings found)");
  });

  it("options object with includeBody works like boolean overload", async () => {
    const page = {
      id: "42",
      title: "Test",
      body: { storage: { value: "<p>Hello</p>" } },
    };
    const withBool = await formatPage(page, true);
    const withObj = await formatPage(page, { includeBody: true });
    expect(withBool).toBe(withObj);
  });
});

describe("extractHeadings", () => {
  it("extracts nested headings with numbering", () => {
    const html = "<h1>A</h1><h2>B</h2><h2>C</h2><h3>D</h3><h1>E</h1>";
    const result = extractHeadings(html);
    expect(result).toBe(
      "1. A\n  1.1. B\n  1.2. C\n    1.2.1. D\n2. E"
    );
  });

  it("strips inline HTML tags from heading text", () => {
    const html = '<h1><strong>Bold</strong> and <em>italic</em></h1>';
    const result = extractHeadings(html);
    expect(result).toBe("1. Bold and italic");
  });

  it("returns fallback for content with no headings", () => {
    const html = "<p>No headings here</p>";
    expect(extractHeadings(html)).toBe("(no headings found)");
  });

  it("returns fallback for empty string", () => {
    expect(extractHeadings("")).toBe("(no headings found)");
  });
});

describe("extractSection", () => {
  const html = "<h1>Intro</h1><p>Intro text</p><h2>Background</h2><p>Background text</p><h2>Goals</h2><p>Goals text</p><h1>Architecture</h1><p>Arch text</p>";

  it("extracts correct section from multi-section document", () => {
    const result = extractSection(html, "Background");
    expect(result).toBe("<h2>Background</h2><p>Background text</p>");
  });

  it("includes content up to next heading of same level", () => {
    const result = extractSection(html, "Intro");
    // h1 Intro should include h2 subsections until the next h1
    expect(result).toContain("<h1>Intro</h1>");
    expect(result).toContain("<p>Intro text</p>");
    expect(result).toContain("<h2>Background</h2>");
    expect(result).toContain("<h2>Goals</h2>");
    expect(result).not.toContain("Architecture");
  });

  it("includes content through end of document when section is last", () => {
    const result = extractSection(html, "Architecture");
    expect(result).toBe("<h1>Architecture</h1><p>Arch text</p>");
  });

  it("preserves ac:structured-macro blocks within the section", () => {
    const macroHtml = '<h1>Code</h1><ac:structured-macro ac:name="code"><ac:plain-text-body>print("hi")</ac:plain-text-body></ac:structured-macro><h1>End</h1>';
    const result = extractSection(macroHtml, "Code");
    expect(result).toContain("ac:structured-macro");
    expect(result).not.toContain("End");
  });

  it("matches headings case-insensitively", () => {
    const result = extractSection(html, "background");
    expect(result).toContain("<h2>Background</h2>");
  });

  it("returns null for non-existent section", () => {
    expect(extractSection(html, "Nonexistent")).toBeNull();
  });

  it("includes nested headings in extracted section", () => {
    const nested = "<h1>Top</h1><h2>Sub</h2><h3>SubSub</h3><p>text</p><h1>Other</h1>";
    const result = extractSection(nested, "Top");
    expect(result).toContain("<h2>Sub</h2>");
    expect(result).toContain("<h3>SubSub</h3>");
    expect(result).not.toContain("Other");
  });

  it("finds headings inside ac:layout cells", () => {
    const layoutHtml = '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><h1>Intro</h1><p>Intro text</p><h1>Details</h1><p>Details text</p></ac:layout-cell></ac:layout-section></ac:layout>';
    const result = extractSection(layoutHtml, "Intro");
    expect(result).toContain("<h1>Intro</h1>");
    expect(result).toContain("<p>Intro text</p>");
    expect(result).not.toContain("Details");
  });
});

describe("replaceSection", () => {
  const html = "<h1>Intro</h1><p>Old intro</p><h1>Details</h1><p>Old details</p><h1>End</h1><p>Ending</p>";

  it("replaces content under target heading", () => {
    const result = replaceSection(html, "Details", "<p>New details</p>");
    expect(result).toContain("<h1>Details</h1><p>New details</p>");
    expect(result).not.toContain("Old details");
  });

  it("preserves content before and after the section", () => {
    const result = replaceSection(html, "Details", "<p>New</p>");
    expect(result).toContain("<h1>Intro</h1><p>Old intro</p>");
    expect(result).toContain("<h1>End</h1><p>Ending</p>");
  });

  it("handles last section in document", () => {
    const result = replaceSection(html, "End", "<p>New ending</p>");
    expect(result).toContain("<h1>End</h1><p>New ending</p>");
    expect(result).not.toContain("Ending");
  });

  it("preserves macros in other sections", () => {
    const macroHtml = '<h1>A</h1><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro><h1>B</h1><p>old</p>';
    const result = replaceSection(macroHtml, "B", "<p>new</p>");
    expect(result).toContain("ac:structured-macro");
    expect(result).toContain("<h1>B</h1><p>new</p>");
  });

  it("returns null when heading not found", () => {
    expect(replaceSection(html, "Missing", "<p>x</p>")).toBeNull();
  });

  it("handles nested headings correctly", () => {
    const nested = "<h1>A</h1><h2>A1</h2><p>a1 text</p><h2>A2</h2><p>a2 text</p><h1>B</h1><p>b text</p>";
    // Replacing A should replace everything until B
    const result = replaceSection(nested, "A", "<p>whole new A</p>");
    expect(result).toContain("<h1>A</h1><p>whole new A</p>");
    expect(result).toContain("<h1>B</h1><p>b text</p>");
  });

  it("works with headings inside ac:layout cells", () => {
    const layoutHtml = '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><h1>A</h1><p>old A</p><h1>B</h1><p>keep B</p></ac:layout-cell></ac:layout-section></ac:layout>';
    const result = replaceSection(layoutHtml, "A", "<p>new A</p>");
    expect(result).toContain("<h1>A</h1><p>new A</p>");
    expect(result).toContain("<h1>B</h1><p>keep B</p>");
    // Preserves the layout wrapper
    expect(result).toContain("ac:layout");
  });
});

describe("truncateStorageFormat", () => {
  it("returns unchanged when content is shorter than maxLength", () => {
    const html = "<p>short</p>";
    expect(truncateStorageFormat(html, 100)).toBe(html);
  });

  it("truncates at element boundary", () => {
    const html = "<p>first</p><p>second</p><p>third</p>";
    const result = truncateStorageFormat(html, 20);
    expect(result).toContain("<p>first</p>");
    expect(result).toContain("[truncated at");
    expect(result).not.toContain("third");
  });

  it("appends truncation marker with correct lengths", () => {
    const html = "<p>aaa</p><p>bbb</p>";
    const result = truncateStorageFormat(html, 12);
    expect(result).toContain(`[truncated at 10 of ${html.length} characters]`);
  });

  it("does not split mid-tag", () => {
    const html = "<p>hello</p><p>world</p>";
    const result = truncateStorageFormat(html, 13);
    // Should cut at </p> boundary (10), not mid-tag
    expect(result).toContain("<p>hello</p>");
    expect(result).not.toContain("<p>wor");
  });

  it("handles content with no HTML tags", () => {
    const text = "Just plain text without any tags at all";
    const result = truncateStorageFormat(text, 10);
    // No closing tags found, falls back to maxLength
    expect(result).toContain("[truncated at 10 of");
  });

  it("handles single large element gracefully", () => {
    const html = "<p>" + "x".repeat(100) + "</p>";
    const result = truncateStorageFormat(html, 10);
    // No complete closing tag before maxLength, falls back to maxLength
    expect(result).toContain("[truncated at");
  });
});

describe("toMarkdownView", () => {
  it("converts basic HTML to markdown", () => {
    const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
    const result = toMarkdownView(html);
    expect(result).toContain("# Title");
    expect(result).toContain("**world**");
  });

  it("replaces ac:structured-macro with placeholder", () => {
    const html = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body>print("hi")</ac:plain-text-body></ac:structured-macro>';
    const result = toMarkdownView(html);
    expect(result).toContain("[macro: code");
    expect(result).toContain("language=python");
  });

  it("shows whitelisted parameters but redacts sensitive ones", () => {
    const html = '<ac:structured-macro ac:name="widget"><ac:parameter ac:name="title">My Widget</ac:parameter><ac:parameter ac:name="url">https://secret.com/api</ac:parameter></ac:structured-macro>';
    const result = toMarkdownView(html);
    expect(result).toContain("title=My Widget");
    expect(result).not.toContain("secret.com");
  });

  it("shows unknown macros with name only", () => {
    const html = '<ac:structured-macro ac:name="custom-thing"><ac:parameter ac:name="apiKey">secret123</ac:parameter></ac:structured-macro>';
    const result = toMarkdownView(html);
    expect(result).toContain("[macro: custom-thing]");
    expect(result).not.toContain("secret123");
  });

  it("replaces ac:layout with column count", () => {
    const html = "<ac:layout><ac:layout-section><ac:layout-cell><p>A</p></ac:layout-cell><ac:layout-cell><p>B</p></ac:layout-cell></ac:layout-section></ac:layout>";
    const result = toMarkdownView(html);
    expect(result).toContain("[layout: 2-column]");
  });

  it("replaces ac:image with filename", () => {
    const html = '<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>';
    const result = toMarkdownView(html);
    expect(result).toContain("[image: diagram.png]");
  });

  it("appends element count footer", () => {
    const html = '<p>text</p><ac:structured-macro ac:name="toc"></ac:structured-macro><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>';
    const result = toMarkdownView(html);
    expect(result).toContain("[Page contains 2 Confluence elements");
  });

  it("no footer when no Confluence elements", () => {
    const html = "<p>Just a paragraph</p>";
    const result = toMarkdownView(html);
    expect(result).not.toContain("Confluence element");
  });

  it("handles empty string", () => {
    const result = toMarkdownView("");
    expect(result).toBe("");
  });
});

describe("looksLikeMarkdown", () => {
  it("detects markdown headings without HTML", () => {
    expect(looksLikeMarkdown("# Title\n\nSome text")).toBe(true);
  });

  it("detects markdown links without HTML", () => {
    expect(looksLikeMarkdown("See [this page](https://example.com)")).toBe(true);
  });

  it("detects markdown bold without HTML", () => {
    expect(looksLikeMarkdown("This is **important**")).toBe(true);
  });

  it("returns false for storage format HTML", () => {
    expect(looksLikeMarkdown("<p>Hello <strong>world</strong></p>")).toBe(false);
  });

  it("returns false for plain text with no markdown patterns", () => {
    expect(looksLikeMarkdown("Just plain text")).toBe(false);
  });

  it("returns false for content with both markdown and HTML", () => {
    // Storage format might contain # in text content
    expect(looksLikeMarkdown("<p># Not a heading</p>")).toBe(false);
  });

  it("returns false for Confluence macros", () => {
    expect(looksLikeMarkdown('# Title\n<ac:structured-macro ac:name="code"></ac:structured-macro>')).toBe(false);
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

  it("serves body from cache on version match", async () => {
    // Pre-populate cache
    pageCache.set("10", 3, "<p>cached</p>");
    // Mock returns metadata-only (no body) with matching version
    const metadataPage = { id: "10", title: "P", spaceId: "s1", version: { number: 3 } };
    global.fetch = mockFetchResponse(metadataPage);
    const page = await getPage("10", true);
    // Only one API call (metadata-only, no body-format)
    expect(global.fetch).toHaveBeenCalledOnce();
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain("body-format");
    // Body comes from cache
    expect(page.body?.storage?.value).toBe("<p>cached</p>");
  });

  it("fetches full body on cache version mismatch", async () => {
    // Pre-populate cache with old version
    pageCache.set("10", 2, "<p>old</p>");
    // First call: metadata-only (version 3 — mismatch)
    const metadataPage = { id: "10", title: "P", spaceId: "s1", version: { number: 3 } };
    // Second call: full fetch with body
    const fullPage = { id: "10", title: "P", spaceId: "s1", version: { number: 3 }, body: { storage: { value: "<p>new</p>" } } };
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const data = callCount === 1 ? metadataPage : fullPage;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
    }) as any;
    const page = await getPage("10", true);
    expect(callCount).toBe(2);
    expect(page.body?.storage?.value).toBe("<p>new</p>");
  });

  it("fetches full body directly when page is not in cache", async () => {
    const fullPage = { id: "10", title: "P", spaceId: "s1", version: { number: 1 }, body: { storage: { value: "<p>body</p>" } } };
    global.fetch = mockFetchResponse(fullPage);
    const page = await getPage("10", true);
    expect(global.fetch).toHaveBeenCalledOnce();
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("body-format=storage");
    expect(page.body?.storage?.value).toBe("<p>body</p>");
    // Now cached
    expect(pageCache.has("10")).toEqual({ version: 1 });
  });

  it("includeBody false does not interact with cache", async () => {
    pageCache.set("10", 3, "<p>cached</p>");
    global.fetch = mockFetchResponse(samplePage);
    await getPage("10", false);
    // Cache should still be there, untouched
    expect(pageCache.has("10")).toEqual({ version: 3 });
  });
});

describe("page cache integration", () => {
  it("createPage caches the body", async () => {
    const createdPage = { id: "99", title: "New", version: { number: 1 } };
    // createPage makes a POST then tries to add a label (2 fetches)
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(createdPage) });
    }) as any;
    await createPage("space1", "New", "hello");
    expect(pageCache.has("99")).toEqual({ version: 1 });
  });

  it("updatePage caches the body", async () => {
    const updatedPage = { id: "10", title: "T", version: { number: 6 } };
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(updatedPage) });
    }) as any;
    await updatePage("10", { title: "T", body: "<p>updated</p>", version: 5 });
    expect(pageCache.has("10")).toEqual({ version: 6 });
  });

  it("deletePage evicts from cache", async () => {
    pageCache.set("10", 5, "<p>body</p>");
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
    await deletePage("10");
    expect(pageCache.has("10")).toBeUndefined();
  });

  it("getPage after updatePage serves from cache", async () => {
    // Simulate update
    const updatedPage = { id: "10", title: "T", version: { number: 6 } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(updatedPage) }) as any;
    await updatePage("10", { title: "T", body: "<p>new content</p>", version: 5 });

    // Now getPage — should use cache
    const metadataPage = { id: "10", title: "T", spaceId: "s1", version: { number: 6 } };
    global.fetch = mockFetchResponse(metadataPage);
    const page = await getPage("10", true);
    // Body from cache, only 1 API call (metadata-only)
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(page.body?.storage?.value).toContain("new content");
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
    expect(body.body.value).toContain("<p>body text</p>");
    expect(body.body.value).toContain("epimethian-attribution");
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
  it("sends version + 1 to Confluence", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "New Title" });
    const { page, newVersion } = await updatePage("30", {
      title: "New Title",
      version: 5,
    });
    expect(newVersion).toBe(6);
    expect(page.title).toBe("New Title");
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.number).toBe(6);
  });

  it("sends body when provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await updatePage("30", { title: "T", version: 1, body: "new body" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).toContain("<p>new body</p>");
    expect(putBody.body.value).toContain("epimethian-attribution");
  });

  it("includes custom versionMessage when provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await updatePage("30", { title: "T", version: 1, body: "text", versionMessage: "Fixed typo" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toContain("Fixed typo");
    expect(putBody.version.message).toContain("via Epimethian");
  });

  it("omits body from payload when not provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "Updated" });
    await updatePage("30", { title: "Updated", version: 1 });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body).toBeUndefined();
  });

  it("throws ConfluenceConflictError on 409 response", async () => {
    global.fetch = mockFetchResponse({ message: "Version conflict" }, 409);
    await expect(
      updatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(ConfluenceConflictError);
    await expect(
      updatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(/get_page/);
  });

  it("rethrows non-409 errors unchanged", async () => {
    global.fetch = mockFetchResponse("Server Error", 500);
    await expect(
      updatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(ConfluenceApiError);
    await expect(
      updatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow("Confluence API error (500)");
  });
});

describe("attribution footer deduplication", () => {
  it("strips exact attribution markers from body before adding new one", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithFooter =
      "<p>content</p>\n" +
      "<!-- epimethian-attribution-start -->" +
      '<p style="font-size:11px;color:#999;margin-top:2em;"><em>This page was created with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>' +
      "<!-- epimethian-attribution-end -->";
    await updatePage("30", { title: "T", version: 1, body: bodyWithFooter });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    const occurrences = putBody.body.value.match(/epimethian-attribution-start/g);
    expect(occurrences).toHaveLength(1);
  });

  it("strips attribution markers normalized by Confluence (no spaces)", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithNormalizedFooter =
      "<p>content</p>\n" +
      "<!--epimethian-attribution-start-->" +
      '<p style="font-size:11px;color:#999;margin-top:2em;"><em>This page was updated with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>' +
      "<!--epimethian-attribution-end-->";
    await updatePage("30", { title: "T", version: 1, body: bodyWithNormalizedFooter });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    const occurrences = putBody.body.value.match(/epimethian-attribution-start/g);
    expect(occurrences).toHaveLength(1);
  });

  it("strips attribution markers with extra whitespace", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithExtraSpaces =
      "<p>content</p>\n" +
      "<!--  epimethian-attribution-start  -->" +
      "<p>old footer</p>" +
      "<!--  epimethian-attribution-end  -->";
    await updatePage("30", { title: "T", version: 1, body: bodyWithExtraSpaces });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    const occurrences = putBody.body.value.match(/epimethian-attribution-start/g);
    expect(occurrences).toHaveLength(1);
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
  it("throws ConfluenceApiError on 400 response", async () => {
    global.fetch = mockFetchResponse("Bad Request", 400);
    await expect(getPage("1", false)).rejects.toThrow(ConfluenceApiError);
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

  it("throws ConfluenceApiError with status on 409 response", async () => {
    global.fetch = mockFetchResponse("Conflict", 409);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect((err as ConfluenceApiError).status).toBe(409);
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
