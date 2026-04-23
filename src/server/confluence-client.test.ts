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
  _rawCreatePage,
  _rawUpdatePage,
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
  ConfluenceAuthError,
  ConfluencePermissionError,
  ConfluenceNotFoundError,
  ConfluenceConflictError,
  getLabels,
  addLabels,
  removeLabel,
  getContentState,
  setContentState,
  removeContentState,
  sanitizeCommentBody,
  getFooterComments,
  getInlineComments,
  getCommentReplies,
  createFooterComment,
  createInlineComment,
  resolveComment,
  deleteFooterComment,
  deleteInlineComment,
  type CommentData,
  getPageVersions,
  getPageVersionBody,
  setClientLabel,
  probeWriteCapability,
  validateStartup,
  ensureAttributionLabel,
  type Config,
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

  it("passes through Confluence ac: namespace tags", () => {
    const toc = '<ac:structured-macro ac:name="toc" ac:schema-version="1"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>';
    expect(toStorageFormat(toc)).toBe(toc);
  });

  it("passes through Confluence ri: namespace tags", () => {
    const ri = '<ri:page ri:content-title="Test" />';
    expect(toStorageFormat(ri)).toBe(ri);
  });

  it("passes through mixed ac: macros and HTML", () => {
    const mixed = '<ac:structured-macro ac:name="toc" /><p>text</p>';
    expect(toStorageFormat(mixed)).toBe(mixed);
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
    // Titles are wrapped in an untrusted-content fence (Track B2).
    expect(result).toContain("Title:\n<<<CONFLUENCE_UNTRUSTED");
    expect(result).toContain("field=title");
    expect(result).toContain("Test");
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

  it("extracts section that contains a macro spanning its full body", () => {
    // Production: sections often consist entirely of a macro (e.g. a code
    // block or expand macro). The heading regex-based extraction must not
    // split the macro.
    const macroSection =
      '<h1>Overview</h1><p>text</p>' +
      '<h1>Code</h1>' +
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[function foo() { return 1; }]]></ac:plain-text-body>' +
      '</ac:structured-macro>' +
      '<h1>End</h1><p>footer</p>';
    const result = extractSection(macroSection, "Code");
    expect(result).toContain("<h1>Code</h1>");
    expect(result).toContain("ac:structured-macro");
    expect(result).toContain("CDATA");
    expect(result).toContain("function foo");
    // Must not leak into the next section
    expect(result).not.toContain("footer");
    expect(result).not.toContain("<h1>End</h1>");
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

  it("replacement content containing macros survives toString() serialisation", () => {
    // Production: callers pass storage format with macros as replacement content.
    // node-html-parser's toString() could mangle ac: namespace attributes.
    const doc = "<h1>Setup</h1><p>old setup</p><h1>Notes</h1><p>keep</p>";
    const macroReplacement =
      '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="abc-123">' +
      '<ac:parameter ac:name="title">Warning</ac:parameter>' +
      '<ac:rich-text-body><p>Do not delete</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    const result = replaceSection(doc, "Setup", macroReplacement);
    expect(result).not.toBeNull();
    // Macro must survive intact — attributes, namespace prefixes, nesting
    expect(result).toContain('ac:name="info"');
    expect(result).toContain('ac:schema-version="1"');
    expect(result).toContain('ac:macro-id="abc-123"');
    expect(result).toContain('<ac:parameter ac:name="title">Warning</ac:parameter>');
    expect(result).toContain("<p>Do not delete</p>");
    // Other section preserved
    expect(result).toContain("<h1>Notes</h1><p>keep</p>");
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

  it("truncation inside a macro produces output that does not split the macro tag", () => {
    // Production data: pages are full of macros. If the cut lands inside
    // <ac:structured-macro>, the output must not contain a half-open tag.
    const html =
      "<p>intro</p>" +
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>important data</p></ac:rich-text-body></ac:structured-macro>' +
      "<p>outro</p>";
    // Cut at 20 chars — well inside the macro opening tag
    const result = truncateStorageFormat(html, 20);
    // Should cut at the last complete element boundary BEFORE the macro,
    // i.e. at </p> after "intro" (12 chars).
    expect(result).toContain("<p>intro</p>");
    expect(result).toContain("[truncated at");
    // Must NOT contain a partial macro tag
    expect(result).not.toContain("ac:structured-macro");
  });

  it("truncation preserves complete macros that fit before the cut point", () => {
    const shortMacro = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
    const html = shortMacro + "<p>" + "x".repeat(500) + "</p>";
    const result = truncateStorageFormat(html, shortMacro.length + 10);
    // The macro's closing tag is at position 57. If maxLength > 57,
    // the macro should survive intact.
    expect(result).toContain("ac:structured-macro");
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

  it("A5: plain-text body with inline link but no line-anchored signals falls through to 'no tag start → markdown' branch", () => {
    // After A5 the inline `[text](url)` regex is no longer a strong-signal,
    // so this body produces no strong match. The fallback branch checks
    // whether the body starts with `<`; "See..." does not, so it is still
    // treated as markdown. Same *result* as pre-A5 for plain-text bodies —
    // the behaviour change targets bodies that start with `<` (i.e. storage
    // HTML); see the "plain XHTML" tests below.
    expect(looksLikeMarkdown("See [this page](https://example.com)")).toBe(true);
  });

  it("A5: plain-text body with inline bold but no line-anchored signals falls through to markdown", () => {
    expect(looksLikeMarkdown("This is **important**")).toBe(true);
  });

  it("A5: inline patterns PLUS structural signal still detect as markdown", () => {
    // Callers who want inline markdown just need to include any structural
    // signal — a heading, list marker, fenced code block, etc.
    expect(
      looksLikeMarkdown("# Title\n\nThis is **important** — see [here](https://example.com)"),
    ).toBe(true);
  });

  it("A5: plain XHTML with inline-link substring passes through as storage", () => {
    // Regression: before A5, this body was misclassified as markdown because
    // the `[text](url)` regex matched inside the `<a>` tag's rendered content.
    expect(
      looksLikeMarkdown(
        "<p>See the <a href=\"https://example.com/foo\">example</a> for details.</p>",
      ),
    ).toBe(false);
  });

  it("A5: plain XHTML with <strong> tag passes through as storage", () => {
    expect(
      looksLikeMarkdown(
        "<p>This section is <strong>critical</strong>.</p>",
      ),
    ).toBe(false);
  });

  it("returns false for storage format HTML", () => {
    expect(looksLikeMarkdown("<p>Hello <strong>world</strong></p>")).toBe(false);
  });

  it("returns true for plain text with no markdown patterns (safe: both paths produce same output)", () => {
    // Plain text without tags is treated as markdown — this is safe because
    // both the markdown and storage paths produce <p>text</p> for plain text.
    expect(looksLikeMarkdown("Just plain text")).toBe(true);
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
  it("_rawCreatePage caches the body", async () => {
    const createdPage = { id: "99", title: "New", version: { number: 1 } };
    // _rawCreatePage makes a POST then tries to add a label (2 fetches)
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(createdPage) });
    }) as any;
    await _rawCreatePage("space1", "New", "hello");
    expect(pageCache.has("99")).toEqual({ version: 1 });
  });

  it("_rawUpdatePage caches the body", async () => {
    const updatedPage = { id: "10", title: "T", version: { number: 6 } };
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(updatedPage) });
    }) as any;
    await _rawUpdatePage("10", { title: "T", body: "<p>updated</p>", version: 5 });
    expect(pageCache.has("10")).toEqual({ version: 6 });
  });

  it("deletePage evicts from cache", async () => {
    pageCache.set("10", 5, "<p>body</p>");
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
    await deletePage("10");
    expect(pageCache.has("10")).toBeUndefined();
  });

  it("getPage after _rawUpdatePage serves from cache", async () => {
    // Simulate update
    const updatedPage = { id: "10", title: "T", version: { number: 6 } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(updatedPage) }) as any;
    await _rawUpdatePage("10", { title: "T", body: "<p>new content</p>", version: 5 });

    // Now getPage — should use cache
    const metadataPage = { id: "10", title: "T", spaceId: "s1", version: { number: 6 } };
    global.fetch = mockFetchResponse(metadataPage);
    const page = await getPage("10", true);
    // Body from cache, only 1 API call (metadata-only)
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(page.body?.storage?.value).toContain("new content");
  });
});

describe("_rawCreatePage", () => {
  const createdPage = { id: "20", title: "New Page" };

  it("sends correct payload without parentId", async () => {
    global.fetch = mockFetchResponse(createdPage);
    const page = await _rawCreatePage("spaceA", "New Page", "body text");
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
    expect(body.body.value).not.toContain("epimethian-attribution");
    expect(body.parentId).toBeUndefined();
  });

  it("includes parentId when provided", async () => {
    global.fetch = mockFetchResponse(createdPage);
    await _rawCreatePage("spaceA", "New Page", "body", "parent-1");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.parentId).toBe("parent-1");
  });
});

describe("_rawUpdatePage", () => {
  it("sends version + 1 to Confluence", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "New Title" });
    const { page, newVersion } = await _rawUpdatePage("30", {
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
    await _rawUpdatePage("30", { title: "T", version: 1, body: "new body" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).toContain("<p>new body</p>");
    expect(putBody.body.value).not.toContain("epimethian-attribution");
  });

  it("includes custom versionMessage when provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await _rawUpdatePage("30", { title: "T", version: 1, body: "text", versionMessage: "Fixed typo" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toContain("Fixed typo");
    expect(putBody.version.message).toContain("via Epimethian");
  });

  it("omits body from payload when not provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "Updated" });
    await _rawUpdatePage("30", { title: "Updated", version: 1 });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body).toBeUndefined();
  });

  it("throws ConfluenceConflictError on 409 response", async () => {
    global.fetch = mockFetchResponse({ message: "Version conflict" }, 409);
    await expect(
      _rawUpdatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(ConfluenceConflictError);
    await expect(
      _rawUpdatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(/get_page/);
  });

  it("rethrows non-409 errors unchanged", async () => {
    global.fetch = mockFetchResponse("Server Error", 500);
    await expect(
      _rawUpdatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow(ConfluenceApiError);
    await expect(
      _rawUpdatePage("30", { title: "T", version: 5 })
    ).rejects.toThrow("Confluence API error (500)");
  });

  it("C3: appends [destructive: ...] suffix when destructiveFlags is non-empty", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await _rawUpdatePage("30", {
      title: "T",
      version: 5,
      body: "new body",
      versionMessage: "Refactored",
      destructiveFlags: ["replace_body", "confirm_shrinkage"],
    });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toContain("Refactored");
    expect(putBody.version.message).toContain("[destructive: replace_body, confirm_shrinkage]");
  });

  it("C3: omits the suffix entirely when no destructive flags are passed", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await _rawUpdatePage("30", {
      title: "T",
      version: 5,
      body: "new body",
      versionMessage: "Ordinary edit",
    });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).not.toContain("[destructive:");
  });

  it("C3: caps the final version message at 500 chars even when the suffix would push it over", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    // Craft a long caller-provided message so total exceeds 500 chars.
    const longMessage = "x".repeat(600);
    await _rawUpdatePage("30", {
      title: "T",
      version: 5,
      body: "new body",
      versionMessage: longMessage,
      destructiveFlags: ["replace_body"],
    });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message.length).toBeLessThanOrEqual(500);
  });
});

describe("_rawUpdatePage — pre-write snapshot (1F)", () => {
  beforeEach(() => {
    pageCache.clear();
  });

  it("stores snapshot when previousBody is provided", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const previousBody = "<p>current content</p>";
    await _rawUpdatePage("30", { title: "T", version: 5, previousBody });
    expect(pageCache.getSnapshot("30", 5)).toBe(previousBody);
  });

  it("does not store snapshot when previousBody is omitted", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    await _rawUpdatePage("30", { title: "T", version: 5 });
    expect(pageCache.getSnapshot("30", 5)).toBeUndefined();
  });
});

describe("legacy attribution footer stripping", () => {
  it("strips exact attribution markers from body", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithFooter =
      "<p>content</p>\n" +
      "<!-- epimethian-attribution-start -->" +
      '<p style="font-size:11px;color:#999;margin-top:2em;"><em>This page was created with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>' +
      "<!-- epimethian-attribution-end -->";
    await _rawUpdatePage("30", { title: "T", version: 1, body: bodyWithFooter });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("epimethian-attribution");
    expect(putBody.body.value).toContain("<p>content</p>");
  });

  it("strips attribution markers normalized by Confluence (no spaces)", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithNormalizedFooter =
      "<p>content</p>\n" +
      "<!--epimethian-attribution-start-->" +
      '<p style="font-size:11px;color:#999;margin-top:2em;"><em>This page was updated with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>' +
      "<!--epimethian-attribution-end-->";
    await _rawUpdatePage("30", { title: "T", version: 1, body: bodyWithNormalizedFooter });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("epimethian-attribution");
    expect(putBody.body.value).toContain("<p>content</p>");
  });

  it("strips attribution markers with extra whitespace", async () => {
    global.fetch = mockFetchResponse({ id: "30", title: "T" });
    const bodyWithExtraSpaces =
      "<p>content</p>\n" +
      "<!--  epimethian-attribution-start  -->" +
      "<p>old footer</p>" +
      "<!--  epimethian-attribution-end  -->";
    await _rawUpdatePage("30", { title: "T", version: 1, body: bodyWithExtraSpaces });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("epimethian-attribution");
    expect(putBody.body.value).toContain("<p>content</p>");
  });

  it("strips bare (unmarked) attribution paragraphs", async () => {
    global.fetch = mockFetchResponse({ id: "31", title: "T" });
    // Bare attribution only (no content before it) — verifies the regex strips it
    const bodyWithBareAttribution =
      '<p style="font-size: 11.0px;color: rgb(153,153,153);margin-top: 2.0em;">' +
      '<em>This page was updated with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>';
    await _rawUpdatePage("31", { title: "T", version: 1, body: "<h1>Title</h1>" + bodyWithBareAttribution });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("Epimethian");
    expect(putBody.body.value).toContain("<h1>Title</h1>");
  });

  it("strips bare attribution where Confluence wraps link text in <em>", async () => {
    global.fetch = mockFetchResponse({ id: "32", title: "T" });
    // Bare attribution with Confluence-normalized <em> wrapping
    const bodyWithNormalizedEm =
      '<p local-id="37224ce031dc"><em>This page was updated with </em>' +
      '<a href="https://github.com/de-otio/epimethian-mcp"><em>Epimethian</em></a>' +
      "<em> v5.1.0.</em></p>";
    await _rawUpdatePage("32", { title: "T", version: 1, body: "<h1>Title</h1>" + bodyWithNormalizedEm });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("Epimethian");
    expect(putBody.body.value).toContain("<h1>Title</h1>");
  });

  it("does not wipe body when attribution follows many <p> tags", async () => {
    global.fetch = mockFetchResponse({ id: "33", title: "T" });
    // Regression: [\s\S]*? in the old regex crossed </p> boundaries,
    // matching from the first <p> in the document to the attribution <a>,
    // wiping the entire body.
    const realContent =
      "<p><strong>Audience:</strong> SRE</p>" +
      "<h2>Cost model</h2>" +
      "<p>The system targets $30/month.</p>" +
      "<table><tr><td>Survey</td><td>$5</td></tr></table>" +
      '<p><em>This page was created with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a> v5.1.0.</em></p>';
    await _rawUpdatePage("33", { title: "T", version: 1, body: realContent });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).not.toContain("Epimethian");
    expect(putBody.body.value).toContain("<strong>Audience:</strong> SRE");
    expect(putBody.body.value).toContain("<h2>Cost model</h2>");
    expect(putBody.body.value).toContain("$30/month");
    expect(putBody.body.value).toContain("<table>");
  });
});

// Post-transform body guard removed — handler-level content-safety guards
// (enforceContentSafetyGuards) now cover shrinkage, macro loss, table loss,
// and structure loss comprehensively. The client-level guard was redundant
// and caused false positives on legitimate attribution stripping.

describe("attribution stripping does not lose real content", () => {
  it("allows normal attribution stripping", async () => {
    global.fetch = mockFetchResponse({ id: "35", title: "T" });
    const normal =
      "<h1>Title</h1><p>Real content.</p>" +
      '<p><em>This page was updated with <a href="https://github.com/de-otio/epimethian-mcp">Epimethian</a>.</em></p>';
    await _rawUpdatePage("35", { title: "T", version: 1, body: normal });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.body.value).toContain("<h1>Title</h1>");
  });
});

describe("version messages with client label", () => {
  it("_rawCreatePage includes client label when provided", async () => {
    global.fetch = mockFetchResponse({ id: "40", title: "New" });
    await _rawCreatePage("spaceA", "New", "body", undefined, "Claude Code");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.version.message).toContain("Claude Code");
    expect(body.version.message).toContain("via Epimethian");
    expect(body.version.message).toMatch(/^Created by Claude Code \(via Epimethian v/);
  });

  it("_rawCreatePage omits client label when not provided", async () => {
    global.fetch = mockFetchResponse({ id: "41", title: "New" });
    await _rawCreatePage("spaceA", "New", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.version.message).toMatch(/^Created by Epimethian v/);
    expect(body.version.message).not.toContain("Claude");
  });

  it("_rawUpdatePage includes client label without versionMessage", async () => {
    global.fetch = mockFetchResponse({ id: "42", title: "T" });
    await _rawUpdatePage("42", { title: "T", version: 1, body: "text", clientLabel: "Claude Code" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toMatch(/^Updated by Claude Code \(via Epimethian v/);
  });

  it("_rawUpdatePage includes client label with custom versionMessage", async () => {
    global.fetch = mockFetchResponse({ id: "43", title: "T" });
    await _rawUpdatePage("43", { title: "T", version: 1, body: "text", versionMessage: "Fixed typo", clientLabel: "Claude Code" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toMatch(/^Fixed typo \(Claude Code via Epimethian v/);
  });

  it("_rawUpdatePage omits client label with custom versionMessage", async () => {
    global.fetch = mockFetchResponse({ id: "44", title: "T" });
    await _rawUpdatePage("44", { title: "T", version: 1, body: "text", versionMessage: "Fixed typo" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toMatch(/^Fixed typo \(via Epimethian v/);
  });

  it("_rawUpdatePage omits client label when not provided", async () => {
    global.fetch = mockFetchResponse({ id: "45", title: "T" });
    await _rawUpdatePage("45", { title: "T", version: 1, body: "text" });
    const putBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(putBody.version.message).toMatch(/^Updated by Epimethian v/);
    expect(putBody.version.message).not.toContain("Claude");
  });
});

describe("comment attribution with client label", () => {
  afterEach(() => {
    setClientLabel(undefined);
  });

  it("createFooterComment includes client label when set", async () => {
    global.fetch = mockFetchResponse({ id: "301", status: "current" });
    setClientLabel("Claude Code");
    await createFooterComment("42", "hello");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated by Claude Code via Epimethian]");
  });

  it("createFooterComment omits client label when not set", async () => {
    global.fetch = mockFetchResponse({ id: "302", status: "current" });
    await createFooterComment("42", "hello");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated via Epimethian]");
    expect(body.body.value).not.toContain("by ");
  });

  it("createFooterComment renders a sanitised client label (XML-significant chars stripped by setClientLabel)", async () => {
    global.fetch = mockFetchResponse({ id: "303", status: "current" });
    setClientLabel("bad<name>");
    await createFooterComment("42", "hello");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    // setClientLabel strips '<' and '>' before storage; the escape layer is
    // belt-and-braces but the input can no longer carry XML-significant chars.
    expect(body.body.value).toContain("[AI-generated by badname via Epimethian]");
    expect(body.body.value).not.toContain("&lt;");
  });
});

describe("setClientLabel sanitisation", () => {
  afterEach(() => {
    setClientLabel(undefined);
  });

  it("preserves normal client label strings", async () => {
    global.fetch = mockFetchResponse({ id: "400", status: "current" });
    setClientLabel("Claude Code");
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated by Claude Code via Epimethian]");
  });

  it("preserves parentheses, hyphens, dots, slashes, underscores in labels", async () => {
    global.fetch = mockFetchResponse({ id: "401", status: "current" });
    setClientLabel("Cursor (1.2.3) / agent_v2-beta");
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("Cursor (1.2.3) / agent_v2-beta");
  });

  it("strips ANSI escape sequences from the client label", async () => {
    global.fetch = mockFetchResponse({ id: "402", status: "current" });
    // ESC[31m red + ESC[0m reset — would otherwise colour terminal output
    setClientLabel("\u001b[31mClaude\u001b[0m Code");
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated by 31mClaude0m Code via Epimethian]");
    expect(body.body.value).not.toContain("\u001b");
  });

  it("strips newline characters from the client label (no log-line injection)", async () => {
    global.fetch = mockFetchResponse({ id: "403", status: "current" });
    setClientLabel("Claude\nADMIN");
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated by ClaudeADMIN via Epimethian]");
    expect(body.body.value).not.toContain("\n");
  });

  it("truncates to 80 characters after sanitisation", async () => {
    global.fetch = mockFetchResponse({ id: "404", status: "current" });
    // 100 'a' chars plus some control chars — sanitisation keeps the 100 a's,
    // truncation then caps to 80.
    setClientLabel("\u0000\u0001" + "a".repeat(100));
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.body.value).toContain("[AI-generated by " + "a".repeat(80) + " via Epimethian]");
  });

  it("falls back to no-label form when the entire label is control chars", async () => {
    global.fetch = mockFetchResponse({ id: "405", status: "current" });
    // Every character is in the disallowed class, so sanitisation yields "".
    setClientLabel("\u0000\u0001\u001b[\u0007");
    await createFooterComment("1", "body");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    // Empty sanitised label falls back to the no-label attribution form.
    expect(body.body.value).toContain("[AI-generated via Epimethian]");
    expect(body.body.value).not.toContain("by ");
    expect(body.body.value).not.toContain("\u001b");
    expect(body.body.value).not.toContain("\u0000");
  });
});

describe("getConfig — deep-freeze immutability (F1)", () => {
  it("freezes config.jsonHeaders so Authorization cannot be mutated at runtime", async () => {
    const { getConfig } = await import("./confluence-client.js");
    const cfg = await getConfig();

    // Outer object already frozen — asserted for completeness.
    expect(Object.isFrozen(cfg)).toBe(true);

    // Inner jsonHeaders must also be frozen. Without the explicit
    // Object.freeze on jsonHeaders, Object.freeze(config) is shallow and
    // a caller could still rewrite config.jsonHeaders.Authorization.
    expect(Object.isFrozen(cfg.jsonHeaders)).toBe(true);

    // In strict mode (vitest runs strict-mode TS), assignment to a frozen
    // property throws. In non-strict mode it is silently ignored. Either
    // way, the final value must be unchanged.
    const originalAuth = cfg.jsonHeaders.Authorization;
    try {
      (cfg.jsonHeaders as any).Authorization = "Basic ATTACKER";
    } catch {
      // Strict mode: throw is expected. Fall through to final-value check.
    }
    expect(cfg.jsonHeaders.Authorization).toBe(originalAuth);
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

  it("B1: fetches current version and compares when expectedVersion is provided (match → proceeds)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === "GET") {
        return new Response(
          JSON.stringify({ id: "99", title: "P", version: { number: 5 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    global.fetch = fetchMock as any;

    await deletePage("99", 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call: GET metadata
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toMatch(/^GET$|undefined/);
    // Second call: DELETE
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("B1: throws ConfluenceConflictError when expectedVersion does not match", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === "GET") {
        return new Response(
          JSON.stringify({ id: "99", title: "P", version: { number: 9 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    global.fetch = fetchMock as any;

    await expect(deletePage("99", 5)).rejects.toMatchObject({
      name: "ConfluenceConflictError",
    });
    // DELETE must not have been issued.
    expect(
      fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE"),
    ).toHaveLength(0);
  });
});

describe("searchPages", () => {
  it("returns results from search API with excerpts", async () => {
    global.fetch = mockFetchResponse({
      results: [{ content: { id: "1", title: "Found" }, excerpt: "Preview text" }],
    });
    const pages = await searchPages('title ~ "Found"', 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Found");
    expect(pages[0].excerpt).toBe("Preview text");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/rest/api/search");
  });

  it("returns empty array when no results", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const pages = await searchPages("nothing", 10);
    expect(pages).toHaveLength(0);
  });

  it("handles results without excerpt", async () => {
    global.fetch = mockFetchResponse({
      results: [{ content: { id: "1", title: "NoExcerpt" } }],
    });
    const pages = await searchPages("test", 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].excerpt).toBeUndefined();
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

// =============================================================================
// Error subclass branching (F1)
// =============================================================================

describe("Error subclass branching", () => {
  it("throws ConfluenceAuthError on 401 response", async () => {
    global.fetch = mockFetchResponse("Unauthorized", 401);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceAuthError);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect((err as ConfluenceApiError).status).toBe(401);
  });

  it("throws ConfluencePermissionError on 403 response", async () => {
    global.fetch = mockFetchResponse("Forbidden", 403);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluencePermissionError);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect((err as ConfluenceApiError).status).toBe(403);
  });

  it("throws ConfluenceNotFoundError on 404 response", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceNotFoundError);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect((err as ConfluenceApiError).status).toBe(404);
  });

  it("throws plain ConfluenceApiError on 500 response", async () => {
    global.fetch = mockFetchResponse("Internal Server Error", 500);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect(err).not.toBeInstanceOf(ConfluenceAuthError);
    expect(err).not.toBeInstanceOf(ConfluencePermissionError);
    expect(err).not.toBeInstanceOf(ConfluenceNotFoundError);
    expect((err as ConfluenceApiError).status).toBe(500);
  });

  it("throws ConfluenceApiError (not ConfluenceConflictError) on 409 response", async () => {
    global.fetch = mockFetchResponse("Conflict", 409);
    const err = await getPage("1", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect(err).not.toBeInstanceOf(ConfluenceConflictError);
    expect((err as ConfluenceApiError).status).toBe(409);
  });
});

// =============================================================================
// Labels API
// =============================================================================

describe("getLabels", () => {
  it("returns parsed label array on success", async () => {
    global.fetch = mockFetchResponse({
      results: [
        { prefix: "global", name: "foo", id: "1", label: "foo" },
        { prefix: "global", name: "bar", id: "2", label: "bar" },
      ],
    });
    const labels = await getLabels("page-42");
    expect(labels).toHaveLength(2);
    expect(labels[0].name).toBe("foo");
    expect(labels[1].name).toBe("bar");
  });

  it("returns empty array when page has no labels", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    const labels = await getLabels("page-42");
    expect(labels).toHaveLength(0);
  });

  it("constructs correct URL with pageId", async () => {
    global.fetch = mockFetchResponse({ results: [] });
    await getLabels("page-99");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toBe(`${API_V1}/content/page-99/label`);
  });

  it("throws ConfluenceApiError on non-ok response", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    await expect(getLabels("page-42")).rejects.toThrow(ConfluenceApiError);
    await expect(getLabels("page-42")).rejects.toThrow("Confluence API error (404)");
  });
});

describe("addLabels", () => {
  it("sends correct POST body for a single label", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await addLabels("page-42", ["foo"]);
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe(`${API_V1}/content/page-42/label`);
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual([{ prefix: "global", name: "foo" }]);
  });

  it("sends correct POST body for multiple labels", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await addLabels("page-42", ["alpha", "beta", "gamma"]);
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body).toEqual([
      { prefix: "global", name: "alpha" },
      { prefix: "global", name: "beta" },
      { prefix: "global", name: "gamma" },
    ]);
  });

  it("throws ConfluenceApiError on non-ok response", async () => {
    global.fetch = mockFetchResponse("Forbidden", 403);
    await expect(addLabels("page-42", ["foo"])).rejects.toThrow(ConfluenceApiError);
    await expect(addLabels("page-42", ["foo"])).rejects.toThrow("Confluence API error (403)");
  });
});

describe("removeLabel", () => {
  it("sends DELETE request to correct URL", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await removeLabel("page-42", "foo");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("DELETE");
    const url = call[0] as string;
    expect(url).toContain(`${API_V1}/content/page-42/label`);
    expect(url).toContain("name=foo");
  });

  it("encodes label with special characters safely in URL (& does not inject extra params)", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await removeLabel("page-42", "foo&evil=1");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    // The ampersand must be percent-encoded, not a raw & that would split params
    expect(url).not.toContain("&evil=1");
    expect(url).toContain("foo%26evil%3D1");
  });

  it("throws ConfluenceApiError on non-ok response", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    await expect(removeLabel("page-42", "foo")).rejects.toThrow(ConfluenceApiError);
    await expect(removeLabel("page-42", "foo")).rejects.toThrow("Confluence API error (404)");
  });
});

// =============================================================================
// Content State (page status badge) API
// =============================================================================

describe("getContentState", () => {
  it("constructs correct URL with ?status=current query param", async () => {
    global.fetch = mockFetchResponse({
      contentState: { id: 1, name: "In progress", color: "#2684FF" },
      lastUpdated: "2026-04-23T15:00:00Z",
    });
    await getContentState("page-42");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V1}/content/page-42/state`);
    expect(url).toContain("status=current");
  });

  it("parses the wrapped Confluence Cloud shape { contentState: { name, color, id }, lastUpdated }", async () => {
    // Regression for the bug that made v6.1.0 badges invisible via MCP:
    // the real API wraps the state in `contentState`, not flat at the top.
    global.fetch = mockFetchResponse({
      contentState: { id: 863862877, color: "#57D9A3", name: "Ready for review" },
      lastUpdated: "2026-04-23T15:05:27.669Z",
    });
    const state = await getContentState("page-42");
    expect(state).toEqual({ name: "Ready for review", color: "#57D9A3" });
  });

  it("parses the unwrapped shape { name, color } too (defensive)", async () => {
    global.fetch = mockFetchResponse({ name: "Ready for review", color: "#57D9A3" });
    const state = await getContentState("page-42");
    expect(state).toEqual({ name: "Ready for review", color: "#57D9A3" });
  });

  it("returns null when contentState is explicitly null (no state set)", async () => {
    global.fetch = mockFetchResponse({ contentState: null, lastUpdated: null });
    const state = await getContentState("page-42");
    expect(state).toBeNull();
  });

  it("returns null when the flat shape has null name/color", async () => {
    global.fetch = mockFetchResponse({ name: null, color: null });
    const state = await getContentState("page-42");
    expect(state).toBeNull();
  });

  it("returns null on 404 (page has no state)", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    const state = await getContentState("page-42");
    expect(state).toBeNull();
  });

  it("ignores extra fields from the API (id, lastUpdated, etc.)", async () => {
    global.fetch = mockFetchResponse({
      contentState: {
        name: "Draft",
        color: "#FFC400",
        id: 42,
        spaceIsEnabled: true,
        isSpaceState: false,
      },
      lastUpdated: "2026-04-23T15:00:00Z",
    });
    const state = await getContentState("page-42");
    expect(state).toEqual({ name: "Draft", color: "#FFC400" });
  });
});

describe("setContentState", () => {
  it("constructs correct URL with ?status=current query param", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await setContentState("page-42", "In progress", "#2684FF");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V1}/content/page-42/state`);
    expect(url).toContain("status=current");
  });

  it("sends PUT with correct { name, color } body", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await setContentState("page-42", "Ready for review", "#57D9A3");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual({ name: "Ready for review", color: "#57D9A3" });
  });

  it("throws ConfluenceApiError on non-ok response", async () => {
    global.fetch = mockFetchResponse("Forbidden", 403);
    await expect(setContentState("page-42", "Draft", "#FFC400")).rejects.toThrow(ConfluenceApiError);
  });
});

describe("removeContentState", () => {
  it("constructs correct URL with ?status=current query param", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await removeContentState("page-42");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(`${API_V1}/content/page-42/state`);
    expect(url).toContain("status=current");
  });

  it("sends DELETE method", async () => {
    global.fetch = mockFetchResponse({}, 200);
    await removeContentState("page-42");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("DELETE");
  });

  it("does not throw on 404 (idempotent)", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    await expect(removeContentState("page-42")).resolves.toBeUndefined();
  });

  it("does not throw on 409 (idempotent)", async () => {
    global.fetch = mockFetchResponse("Conflict", 409);
    await expect(removeContentState("page-42")).resolves.toBeUndefined();
  });

  it("throws on other errors", async () => {
    global.fetch = mockFetchResponse("Server Error", 500);
    await expect(removeContentState("page-42")).rejects.toThrow(ConfluenceApiError);
  });
});

// =============================================================================
// Comments API
// =============================================================================

describe("Comments", () => {
  // ---------------------------------------------------------------------------
  // sanitizeCommentBody
  // ---------------------------------------------------------------------------
  describe("sanitizeCommentBody", () => {
    it("returns body unchanged when no dangerous tags", () => {
      const body = "<p>Hello <strong>world</strong></p>";
      expect(sanitizeCommentBody(body)).toBe(body);
    });

    it("strips <ac:structured-macro> tags", () => {
      const body = '<p>Before</p><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro><p>After</p>';
      const result = sanitizeCommentBody(body);
      expect(result).toContain("<p>Before</p>");
      expect(result).toContain("<p>After</p>");
      expect(result).not.toContain("ac:structured-macro");
    });

    it("strips <script> tags", () => {
      const body = "<p>Hello</p><script>alert('xss')</script><p>World</p>";
      const result = sanitizeCommentBody(body);
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("alert");
      expect(result).toContain("<p>Hello</p>");
      expect(result).toContain("<p>World</p>");
    });

    it("strips <iframe> tags", () => {
      const body = "<p>Start</p><iframe src='evil.com'></iframe><p>End</p>";
      const result = sanitizeCommentBody(body);
      expect(result).not.toContain("<iframe");
      expect(result).toContain("<p>Start</p>");
    });

    it("does not strip safe tags like <p>, <strong>, <em>", () => {
      const body = "<p>This is <strong>bold</strong> and <em>italic</em></p>";
      expect(sanitizeCommentBody(body)).toBe(body);
    });

    it("logs warning to stderr when tags are stripped", () => {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const body = '<ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>';
      sanitizeCommentBody(body);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("sanitizeCommentBody stripped dangerous tags")
      );
      stderrSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // getFooterComments
  // ---------------------------------------------------------------------------
  describe("getFooterComments", () => {
    const sampleComment = {
      id: "101",
      status: "current",
      pageId: "42",
      version: { number: 1 },
      body: { storage: { value: "<p>A comment</p>" } },
    };

    it("calls GET /pages/{id}/footer-comments with body-format=storage&limit=250", async () => {
      global.fetch = mockFetchResponse({ results: [sampleComment] });
      await getFooterComments("42");
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V2}/pages/42/footer-comments`);
      expect(url).toContain("body-format=storage");
      expect(url).toContain("limit=250");
    });

    it("returns parsed CommentData[]", async () => {
      global.fetch = mockFetchResponse({ results: [sampleComment] });
      const comments = await getFooterComments("42");
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe("101");
      expect(comments[0].body?.storage?.value).toBe("<p>A comment</p>");
    });

    it("returns [] when results is empty", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      const comments = await getFooterComments("42");
      expect(comments).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getInlineComments
  // ---------------------------------------------------------------------------
  describe("getInlineComments", () => {
    it("passes resolution-status param when not 'all'", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      await getInlineComments("42", "open");
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain("resolution-status=open");
    });

    it("omits resolution-status param when 'all'", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      await getInlineComments("42", "all");
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).not.toContain("resolution-status");
    });
  });

  // ---------------------------------------------------------------------------
  // getCommentReplies
  // ---------------------------------------------------------------------------
  describe("getCommentReplies", () => {
    it("uses /footer-comments/{id}/children for type footer", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      await getCommentReplies("101", "footer");
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V2}/footer-comments/101/children`);
    });

    it("uses /inline-comments/{id}/children for type inline", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      await getCommentReplies("202", "inline");
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V2}/inline-comments/202/children`);
    });
  });

  // ---------------------------------------------------------------------------
  // createFooterComment
  // ---------------------------------------------------------------------------
  describe("createFooterComment", () => {
    const createdComment = {
      id: "300",
      status: "current",
      pageId: "42",
      version: { number: 1 },
    };

    it("top-level: payload includes pageId, no parentCommentId", async () => {
      global.fetch = mockFetchResponse(createdComment);
      await createFooterComment("42", "Hello world");
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe(`${API_V2}/footer-comments`);
      expect(call[1].method).toBe("POST");
      const body = JSON.parse(call[1].body as string);
      expect(body.pageId).toBe("42");
      expect(body.parentCommentId).toBeUndefined();
    });

    it("reply: payload includes parentCommentId only, no pageId", async () => {
      global.fetch = mockFetchResponse(createdComment);
      await createFooterComment("42", "A reply", "parent-99");
      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
      expect(body.parentCommentId).toBe("parent-99");
      expect(body.pageId).toBeUndefined();
    });

    it("body is sanitized and attributed", async () => {
      global.fetch = mockFetchResponse(createdComment);
      await createFooterComment("42", "My comment");
      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
      expect(body.body.value).toContain("[AI-generated via Epimethian]");
      expect(body.body.value).toContain("My comment");
    });
  });

  // ---------------------------------------------------------------------------
  // createInlineComment
  // ---------------------------------------------------------------------------
  describe("createInlineComment", () => {
    const pageWithBody = {
      id: "42",
      title: "Test Page",
      version: { number: 1 },
      body: { storage: { value: "<p>The quick brown fox jumped over the lazy dog</p>" } },
    };
    const createdComment = {
      id: "400",
      status: "current",
      pageId: "42",
      version: { number: 1 },
    };

    it("fetches page body and counts textSelection occurrences", async () => {
      global.fetch = mockFetchSequence([
        { body: pageWithBody },
        { body: createdComment },
      ]);
      const comment = await createInlineComment("42", "My note", "quick brown fox");
      expect(comment.id).toBe("400");
      // First call fetches page with body
      const firstUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(firstUrl).toContain("body-format=storage");
      // Second call posts the inline comment
      const secondCall = (global.fetch as any).mock.calls[1];
      const postBody = JSON.parse(secondCall[1].body as string);
      expect(postBody.inlineCommentProperties.textSelection).toBe("quick brown fox");
      expect(postBody.inlineCommentProperties.textSelectionMatchCount).toBe(1);
      expect(postBody.inlineCommentProperties.textSelectionMatchIndex).toBe(0);
    });

    it("throws if textSelection not found in page body", async () => {
      global.fetch = mockFetchResponse(pageWithBody);
      await expect(
        createInlineComment("42", "My note", "nonexistent text")
      ).rejects.toThrow("not found in page body");
    });

    it("throws if textSelectionMatchIndex out of range", async () => {
      global.fetch = mockFetchResponse(pageWithBody);
      await expect(
        createInlineComment("42", "My note", "quick brown fox", 5)
      ).rejects.toThrow("out of range");
    });

    it("reply: omits inlineCommentProperties, uses parentCommentId", async () => {
      global.fetch = mockFetchResponse(createdComment);
      const comment = await createInlineComment("42", "Reply text", "any text", 0, "parent-100");
      expect(comment.id).toBe("400");
      // Only one fetch (no page body fetch needed)
      expect((global.fetch as any).mock.calls).toHaveLength(1);
      const postBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
      expect(postBody.parentCommentId).toBe("parent-100");
      expect(postBody.inlineCommentProperties).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // resolveComment
  // ---------------------------------------------------------------------------
  describe("resolveComment", () => {
    const commentWithVersion = {
      id: "500",
      status: "current",
      resolutionStatus: "open",
      version: { number: 3 },
    };
    const resolvedComment = {
      id: "500",
      status: "current",
      resolutionStatus: "resolved",
      version: { number: 4 },
    };

    it("GETs comment with body-format=storage to get version", async () => {
      global.fetch = mockFetchSequence([
        { body: commentWithVersion },
        { body: resolvedComment },
      ]);
      await resolveComment("500", true);
      const getUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(getUrl).toContain(`${API_V2}/inline-comments/500`);
      expect(getUrl).toContain("body-format=storage");
    });

    it("throws descriptive error for dangling comments", async () => {
      const danglingComment = { id: "500", status: "current", resolutionStatus: "dangling", version: { number: 1 } };
      global.fetch = mockFetchResponse(danglingComment);
      await expect(resolveComment("500", true)).rejects.toThrow("dangling");
    });

    it("PUTs with resolved: true and version.number + 1", async () => {
      global.fetch = mockFetchSequence([
        { body: commentWithVersion },
        { body: resolvedComment },
      ]);
      const result = await resolveComment("500", true);
      expect(result.resolutionStatus).toBe("resolved");
      const putCall = (global.fetch as any).mock.calls[1];
      expect(putCall[1].method).toBe("PUT");
      const putBody = JSON.parse(putCall[1].body as string);
      expect(putBody.resolved).toBe(true);
      expect(putBody.version.number).toBe(4); // 3 + 1
    });

    it("retries on HTTP 409 up to 2 times", async () => {
      global.fetch = mockFetchSequence([
        // First attempt: GET comment
        { body: commentWithVersion },
        // First attempt: PUT returns 409
        { body: { message: "Conflict" }, status: 409 },
        // Second attempt (retry 1): GET comment again
        { body: commentWithVersion },
        // Second attempt: PUT returns 200
        { body: resolvedComment },
      ]);
      const result = await resolveComment("500", true);
      expect(result.resolutionStatus).toBe("resolved");
      expect((global.fetch as any).mock.calls).toHaveLength(4);
    });

    it("throws on third 409 (exhausted retries)", async () => {
      global.fetch = mockFetchSequence([
        // Attempt 0: GET
        { body: commentWithVersion },
        // Attempt 0: PUT → 409
        { body: { message: "Conflict" }, status: 409 },
        // Attempt 1 (retry): GET
        { body: commentWithVersion },
        // Attempt 1: PUT → 409
        { body: { message: "Conflict" }, status: 409 },
        // Attempt 2 (retry): GET
        { body: commentWithVersion },
        // Attempt 2: PUT → 409 (exhausted)
        { body: { message: "Conflict" }, status: 409 },
      ]);
      await expect(resolveComment("500", true)).rejects.toThrow(ConfluenceApiError);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteFooterComment / deleteInlineComment
  // ---------------------------------------------------------------------------
  describe("deleteFooterComment / deleteInlineComment", () => {
    it("deleteFooterComment calls DELETE /footer-comments/{id}", async () => {
      global.fetch = mockFetchResponse({}, 204);
      await deleteFooterComment("101");
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe(`${API_V2}/footer-comments/101`);
      expect(call[1].method).toBe("DELETE");
    });

    it("deleteInlineComment calls DELETE /inline-comments/{id}", async () => {
      global.fetch = mockFetchResponse({}, 204);
      await deleteInlineComment("202");
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe(`${API_V2}/inline-comments/202`);
      expect(call[1].method).toBe("DELETE");
    });
  });

  // ---------------------------------------------------------------------------
  // getPageVersions
  // ---------------------------------------------------------------------------
  describe("getPageVersions", () => {
    const sampleVersions = {
      results: [
        { number: 3, by: { displayName: "Alice", accountId: "abc" }, when: "2025-01-03T00:00:00Z", message: "Fixed typo", minorEdit: true },
        { number: 2, by: { displayName: "Bob", accountId: "def" }, when: "2025-01-02T00:00:00Z", message: "", minorEdit: false },
      ],
    };

    it("constructs correct v1 URL with limit param", async () => {
      global.fetch = mockFetchResponse(sampleVersions);
      await getPageVersions("123", 50);
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V1}/content/123/version`);
      expect(url).toContain("limit=50");
    });

    it("returns parsed version metadata array", async () => {
      global.fetch = mockFetchResponse(sampleVersions);
      const result = await getPageVersions("123", 25);
      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(3);
      expect(result[0].by.displayName).toBe("Alice");
      expect(result[0].by.accountId).toBe("abc");
      expect(result[0].minorEdit).toBe(true);
    });

    it("truncates messages longer than 500 chars", async () => {
      const longMsg = "x".repeat(600);
      const versions = { results: [{ number: 1, by: { displayName: "A", accountId: "a" }, when: "2025-01-01T00:00:00Z", message: longMsg, minorEdit: false }] };
      global.fetch = mockFetchResponse(versions);
      const result = await getPageVersions("1", 25);
      expect(result[0].message).toHaveLength(500);
    });

    it("returns empty array for empty results", async () => {
      global.fetch = mockFetchResponse({ results: [] });
      const result = await getPageVersions("1", 25);
      expect(result).toEqual([]);
    });

    it("throws ConfluenceApiError on 404", async () => {
      global.fetch = mockFetchResponse({ message: "Not found" }, 404);
      await expect(getPageVersions("999", 25)).rejects.toThrow(ConfluenceApiError);
    });
  });

  // ---------------------------------------------------------------------------
  // getPageVersionBody
  // ---------------------------------------------------------------------------
  describe("getPageVersionBody", () => {
    const v1Response = {
      id: "10",
      title: "My Page",
      version: { number: 3 },
      body: { storage: { value: "<p>hello version 3</p>" } },
    };

    it("constructs correct v1 URL with version and expand params", async () => {
      global.fetch = mockFetchResponse(v1Response);
      await getPageVersionBody("10", 3);
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V1}/content/10`);
      expect(url).toContain("version=3");
      expect(url).toContain("expand=body.storage%2Cversion");
    });

    it("returns parsed title, rawBody, and version number", async () => {
      global.fetch = mockFetchResponse(v1Response);
      const result = await getPageVersionBody("10", 3);
      expect(result.title).toBe("My Page");
      expect(result.rawBody).toBe("<p>hello version 3</p>");
      expect(result.version).toBe(3);
    });

    it("caches raw body via pageCache.setVersioned after fetch", async () => {
      global.fetch = mockFetchResponse(v1Response);
      await getPageVersionBody("10", 3);
      expect(pageCache.getVersioned("10", 3)).toBe("<p>hello version 3</p>");
    });

    it("returns cached body on second call (only metadata fetch)", async () => {
      // Pre-populate cache
      pageCache.setVersioned("10", 3, "<p>cached v3</p>");
      // Mock returns v2 metadata (no body)
      global.fetch = mockFetchResponse({ id: "10", title: "My Page", spaceId: "s1" });
      const result = await getPageVersionBody("10", 3);
      expect(result.rawBody).toBe("<p>cached v3</p>");
      // Should have made exactly one call (metadata only via v2)
      expect(global.fetch).toHaveBeenCalledOnce();
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain(`${API_V2}/pages/10`);
    });

    it("throws ConfluenceApiError on 404", async () => {
      global.fetch = mockFetchResponse({ message: "Not found" }, 404);
      await expect(getPageVersionBody("999", 1)).rejects.toThrow(ConfluenceApiError);
    });

    it("throws ConfluenceApiError on 403", async () => {
      global.fetch = mockFetchResponse({ message: "Forbidden" }, 403);
      await expect(getPageVersionBody("999", 1)).rejects.toThrow(ConfluenceApiError);
    });

    it("handles v1 response shape correctly (body.storage.value path)", async () => {
      const response = {
        id: "5",
        title: "Deep Page",
        version: { number: 7 },
        body: { storage: { value: "<h1>Title</h1><p>Content</p>" } },
      };
      global.fetch = mockFetchResponse(response);
      const result = await getPageVersionBody("5", 7);
      expect(result.rawBody).toBe("<h1>Title</h1><p>Content</p>");
    });
  });
});

// =============================================================================
// probeWriteCapability (Track O1)
// =============================================================================

describe("probeWriteCapability", () => {
  // Test 1: primary permission endpoint returns havePermission: true → "write"
  it("returns 'write' when permission endpoint reports create is allowed", async () => {
    global.fetch = mockFetchSequence([
      // First call: GET /wiki/api/v2/spaces?limit=1 → returns one space
      { body: { results: [{ id: "1", key: "DEV", name: "Development", type: "global" }] } },
      // Second call: GET permission endpoint → havePermission: true
      { body: { operation: { operation: "create", targetType: "page" }, havePermission: true } },
    ]);
    const result = await probeWriteCapability();
    expect(result).toBe("write");
  });

  // Test 2: primary permission endpoint returns havePermission: false → "read-only"
  it("returns 'read-only' when permission endpoint reports create is not allowed", async () => {
    global.fetch = mockFetchSequence([
      { body: { results: [{ id: "1", key: "DEV", name: "Development", type: "global" }] } },
      { body: { operation: { operation: "create", targetType: "page" }, havePermission: false } },
    ]);
    const result = await probeWriteCapability();
    expect(result).toBe("read-only");
  });

  // Test 3: permission endpoint returns 404 → falls back to dry-run; dry-run returns 404 → "write"
  it("falls back to dry-run when permission endpoint returns 404", async () => {
    global.fetch = mockFetchSequence([
      // GET /spaces → returns one space
      { body: { results: [{ id: "1", key: "DEV", name: "Development", type: "global" }] } },
      // GET permission endpoint → 404 (endpoint unavailable)
      { body: { message: "Not found" }, status: 404 },
      // PUT dry-run → 404 (page not found = token can write)
      { body: { message: "Not found" }, status: 404 },
    ]);
    const result = await probeWriteCapability();
    expect(result).toBe("write");
  });

  // Test 4: dry-run fallback → 403 → "read-only"
  it("dry-run fallback → 403 → returns 'read-only'", async () => {
    global.fetch = mockFetchSequence([
      // GET /spaces → returns one space
      { body: { results: [{ id: "1", key: "DEV", name: "Development", type: "global" }] } },
      // GET permission endpoint → 404 (unavailable)
      { body: { message: "Not found" }, status: 404 },
      // PUT dry-run → 403 (no write permission)
      { body: { message: "Forbidden" }, status: 403 },
    ]);
    const result = await probeWriteCapability();
    expect(result).toBe("read-only");
  });

  // Test 5: dry-run fallback → 404 → "write" (reconfirm standalone)
  it("dry-run fallback → 404 → returns 'write' (token can write, page just missing)", async () => {
    global.fetch = mockFetchSequence([
      // GET /spaces → empty list (no spaces to use for primary)
      { body: { results: [] } },
      // PUT dry-run → 404
      { body: { message: "Not found" }, status: 404 },
    ]);
    const result = await probeWriteCapability();
    expect(result).toBe("write");
  });

  // Test 6: all strategies fail with unexpected non-4xx error → "inconclusive"
  it("returns 'inconclusive' when all strategies fail with unexpected errors", async () => {
    // Simulate network error on dry-run PUT (after spaces returns empty)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [] }),
        text: () => Promise.resolve("{}"),
      })
      .mockRejectedValueOnce(new Error("Network error"));
    global.fetch = fetchMock as any;
    const result = await probeWriteCapability();
    expect(result).toBe("inconclusive");
  });

  // Test 7: probe is NOT called when posture !== "detect" (validateStartup skips it)
  it("probe is not called when posture is 'read-only' (validateStartup skips probe)", async () => {
    // We spy on probeWriteCapability by checking that no permission-endpoint
    // or dry-run calls are made. We set up fetch to track all calls.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
    });
    global.fetch = fetchMock as any;

    // Mock the shared test-connection functions for validateStartup
    const { testConnection, verifyTenantIdentity } = await import("../shared/test-connection.js");
    vi.mocked(testConnection).mockResolvedValue({ ok: true, message: "ok" });
    vi.mocked(verifyTenantIdentity).mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com", message: "ok" });

    const config: Config = {
      url: BASE_URL,
      email: "user@test.com",
      profile: null,
      readOnly: true,
      posture: "read-only",
      attribution: true,
      apiV2: `${BASE_URL}/wiki/api/v2`,
      apiV1: `${BASE_URL}/wiki/rest/api`,
      authHeader: "Basic dXNlcjp0b2tlbg==",
      jsonHeaders: Object.freeze({ Authorization: "Basic dXNlcjp0b2tlbg==", "Content-Type": "application/json" }),
    };

    await validateStartup(config);

    // The only fetch call should be none related to the probe — validateStartup
    // calls testConnection/verifyTenantIdentity (mocked), and skips the probe.
    // Verify that no call was made to /user/current/permission or /pages/999999999999
    const calls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    const probeCallMade = calls.some(
      (url) => url.includes("/permission") || url.includes("999999999999")
    );
    expect(probeCallMade).toBe(false);
  });
});

// =============================================================================
// Track G — ensureAttributionLabel structured warnings
// =============================================================================

describe("ensureAttributionLabel (Track G)", () => {
  it("returns {} on success", async () => {
    // addLabels (POST) + getLabels (GET, no legacy label) — both succeed
    global.fetch = mockFetchSequence([
      { body: {}, status: 200 },                        // addLabels
      { body: { results: [{ prefix: "global", name: "epimethian-edited", id: "1", label: "epimethian-edited" }] }, status: 200 }, // getLabels
    ]);
    const result = await ensureAttributionLabel("page-42");
    expect(result).toEqual({});
  });

  it("returns { warning } on ConfluencePermissionError (403) and does not throw", async () => {
    // addLabels returns 403 → ConfluencePermissionError
    global.fetch = mockFetchResponse("Forbidden", 403);
    const result = await ensureAttributionLabel("page-99");
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("page-99");
    expect(result.warning).toContain("permission denied");
    expect(result.warning).toContain("epimethian-edited");
  });

  it("re-throws on 500 (infrastructure failure must not be masked)", async () => {
    global.fetch = mockFetchResponse("Internal Server Error", 500);
    await expect(ensureAttributionLabel("page-1")).rejects.toThrow(ConfluenceApiError);
    await expect(ensureAttributionLabel("page-1")).rejects.not.toThrow(ConfluencePermissionError);
  });

  it("re-throws on ConfluenceNotFoundError (404 — a missing page is a real error)", async () => {
    global.fetch = mockFetchResponse("Not Found", 404);
    await expect(ensureAttributionLabel("page-missing")).rejects.toThrow(ConfluenceNotFoundError);
  });
});
