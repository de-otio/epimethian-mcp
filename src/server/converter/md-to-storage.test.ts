import { describe, expect, it } from "vitest";
import { markdownToStorage } from "./md-to-storage.js";
import { ConverterError } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://entrixenergy.atlassian.net";

function convert(md: string, opts?: Parameters<typeof markdownToStorage>[1]): string {
  return markdownToStorage(md, opts);
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe("headings", () => {
  it("renders h1", () => {
    expect(convert("# Heading 1")).toContain("<h1>Heading 1</h1>");
  });

  it("renders h2", () => {
    expect(convert("## Heading 2")).toContain("<h2>Heading 2</h2>");
  });

  it("renders h3", () => {
    expect(convert("### Heading 3")).toContain("<h3>Heading 3</h3>");
  });

  it("renders h4", () => {
    expect(convert("#### Heading 4")).toContain("<h4>Heading 4</h4>");
  });

  it("renders h5", () => {
    expect(convert("##### Heading 5")).toContain("<h5>Heading 5</h5>");
  });

  it("renders h6", () => {
    expect(convert("###### Heading 6")).toContain("<h6>Heading 6</h6>");
  });
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

describe("paragraph", () => {
  it("renders a simple paragraph", () => {
    const out = convert("Hello, world.");
    expect(out).toContain("<p>Hello, world.</p>");
  });

  it("renders multiple paragraphs", () => {
    const out = convert("First.\n\nSecond.");
    expect(out).toContain("<p>First.</p>");
    expect(out).toContain("<p>Second.</p>");
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe("lists", () => {
  it("renders an unordered list", () => {
    const out = convert("- alpha\n- beta\n- gamma");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>alpha</li>");
    expect(out).toContain("<li>beta</li>");
    expect(out).toContain("<li>gamma</li>");
  });

  it("renders an ordered list", () => {
    const out = convert("1. one\n2. two\n3. three");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).toContain("<li>three</li>");
  });

  it("renders a nested list", () => {
    const out = convert("- parent\n  - child\n  - child2");
    expect(out).toContain("<ul>");
    expect(out).toContain("parent");
    expect(out).toContain("child");
    expect(out.match(/<ul>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders a tight list (no <p> tags inside li)", () => {
    const out = convert("- a\n- b");
    // Tight list items should not have <p> wrapping
    expect(out).not.toMatch(/<li>\s*<p>/);
  });

  it("renders a loose list (with <p> tags inside li)", () => {
    const out = convert("- a\n\n- b");
    expect(out).toMatch(/<li>\s*<p>/);
  });
});

// ---------------------------------------------------------------------------
// Blockquote
// ---------------------------------------------------------------------------

describe("blockquote", () => {
  it("renders a blockquote", () => {
    const out = convert("> This is quoted text.");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("This is quoted text.");
  });
});

// ---------------------------------------------------------------------------
// GFM tables
// ---------------------------------------------------------------------------

describe("GFM tables", () => {
  it("renders a table", () => {
    const md = [
      "| Name | Age |",
      "|------|-----|",
      "| Alice | 30 |",
      "| Bob | 25 |",
    ].join("\n");
    const out = convert(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain("<tbody>");
    expect(out).toContain("Alice");
    expect(out).toContain("Bob");
  });
});

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

describe("horizontal rule", () => {
  it("renders hr as self-closing", () => {
    const out = convert("---");
    expect(out).toContain("<hr/>");
    // Must not contain unclosed <hr>
    expect(out).not.toMatch(/<hr(?!\/)>/);
  });
});

// ---------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------

describe("inline code", () => {
  it("renders inline code", () => {
    const out = convert("Use `console.log()` here.");
    expect(out).toContain("<code>console.log()</code>");
  });
});

// ---------------------------------------------------------------------------
// Code fences
// ---------------------------------------------------------------------------

describe("fenced code blocks", () => {
  it("renders code fence with language as ac:structured-macro", () => {
    const md = "```javascript\nconsole.log('hello');\n```";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="code" ac:schema-version="1"');
    expect(out).toContain('<ac:parameter ac:name="language">javascript</ac:parameter>');
    expect(out).toContain("<ac:plain-text-body><![CDATA[");
    expect(out).toContain("console.log('hello');");
    expect(out).toContain("]]></ac:plain-text-body>");
  });

  it("renders code fence without language (no language parameter)", () => {
    const md = "```\nsome plain text\n```";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="code" ac:schema-version="1"');
    expect(out).not.toContain('<ac:parameter ac:name="language">');
    expect(out).toContain("some plain text");
  });

  it("renders code fence with title parameter", () => {
    const md = '```python title="My Script"\nprint("hi")\n```';
    const out = convert(md);
    expect(out).toContain('<ac:parameter ac:name="language">python</ac:parameter>');
    expect(out).toContain('<ac:parameter ac:name="title">My Script</ac:parameter>');
  });

  it("generates a fresh ac:macro-id UUID for each code block", () => {
    const md = "```js\nfoo\n```\n\n```js\nbar\n```";
    const out = convert(md);
    const ids = [...out.matchAll(/ac:macro-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // CDATA injection regression
  it("escapes ]]> in code block body (CDATA injection)", () => {
    const md = "```\nAttack: ]]> <ac:macro/>\n```";
    const out = convert(md);
    // The ]]> must be split so it cannot close the CDATA section early.
    expect(out).toContain("]]]]><![CDATA[>");
    // Must not contain the raw unescaped sequence in a context that would break CDATA.
    // The CDATA section must be properly closed at the end.
    expect(out).toContain("]]></ac:plain-text-body>");
  });

  it("handles multiple ]]> sequences in code block body", () => {
    const body = "a]]>b]]>c";
    const md = `\`\`\`\n${body}\n\`\`\``;
    const out = convert(md);
    // Each ]]> should be escaped
    expect(out).toContain("a]]]]><![CDATA[>b]]]]><![CDATA[>c");
  });

  // Attribute injection regression — language parameter
  it("escapes dangerous chars in language attribute", () => {
    const md = '```<script>"\'&\nnewline\n```';
    const out = convert(md);
    // The language string should be XML-escaped in the attribute
    expect(out).not.toContain('<script>');
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes dangerous chars in title parameter", () => {
    const md = '```python title="<evil>&\'"\npass\n```';
    const out = convert(md);
    expect(out).not.toContain("<evil>");
    expect(out).toContain("&lt;evil&gt;");
  });
});

// ---------------------------------------------------------------------------
// Inline emphasis / strong / strikethrough
// ---------------------------------------------------------------------------

describe("inline formatting", () => {
  it("renders emphasis (em)", () => {
    const out = convert("This is *emphasised* text.");
    expect(out).toContain("<em>emphasised</em>");
  });

  it("renders strong", () => {
    const out = convert("This is **bold** text.");
    expect(out).toContain("<strong>bold</strong>");
  });

  it("renders strikethrough (GFM)", () => {
    const out = convert("This is ~~deleted~~ text.");
    expect(out).toContain("<s>deleted</s>");
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe("links", () => {
  it("renders external link unchanged", () => {
    const out = convert("[Google](https://www.google.com)");
    expect(out).toContain('<a href="https://www.google.com">Google</a>');
  });

  it("rewrites Confluence URL to ac:link with ri:content-id", () => {
    const url = `${BASE_URL}/wiki/spaces/ETD/pages/875954196/EX-3946+Overview`;
    const out = convert(`[Overview](${url})`, { confluenceBaseUrl: BASE_URL });
    expect(out).toContain("<ac:link>");
    expect(out).toContain('<ri:page ri:content-id="875954196"');
    expect(out).toContain("<ac:plain-text-link-body><![CDATA[Overview]]></ac:plain-text-link-body>");
    expect(out).toContain("</ac:link>");
  });

  it("rewrites confluence:// scheme to ac:link with space-key and content-title", () => {
    const out = convert("[Overview](confluence://ETD/EX-3946 Overview)", {
      confluenceBaseUrl: BASE_URL,
    });
    expect(out).toContain("<ac:link>");
    expect(out).toContain('<ri:page ri:space-key="ETD" ri:content-title="EX-3946 Overview"');
    expect(out).toContain("<ac:plain-text-link-body><![CDATA[Overview]]></ac:plain-text-link-body>");
    expect(out).toContain("</ac:link>");
  });

  it("does NOT rewrite external link that looks like confluence URL from different host", () => {
    const spoofUrl = "https://entrixenergy.atlassian.net.attacker.com/wiki/spaces/ETD/pages/12345/foo";
    const out = convert(`[Spoof](${spoofUrl})`, { confluenceBaseUrl: BASE_URL });
    // Should remain as <a>, not <ac:link>
    expect(out).not.toContain("<ac:link>");
    expect(out).toContain('<a href="');
  });

  it("does NOT rewrite links when no confluenceBaseUrl is configured", () => {
    const url = `${BASE_URL}/wiki/spaces/ETD/pages/12345/Foo`;
    const out = convert(`[Foo](${url})`);
    expect(out).not.toContain("<ac:link>");
    expect(out).toContain('<a href="');
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe("images", () => {
  it("renders external image with self-closing img tag", () => {
    const out = convert("![Alt text](https://example.com/image.png)");
    // The img tag should be self-closed.
    expect(out).toMatch(/<img\b[^>]*\/>/);
    expect(out).toContain("https://example.com/image.png");
  });
});

// ---------------------------------------------------------------------------
// Autolinks
// ---------------------------------------------------------------------------

describe("autolinks", () => {
  it("linkifies bare URLs", () => {
    const out = convert("Visit https://www.example.com for details.");
    expect(out).toContain('<a href="https://www.example.com"');
  });
});

// ---------------------------------------------------------------------------
// Task lists (GFM)
// ---------------------------------------------------------------------------

describe("task lists", () => {
  it("renders checked and unchecked task list items", () => {
    const md = "- [x] Done\n- [ ] Pending";
    const out = convert(md);
    expect(out).toContain("Done");
    expect(out).toContain("Pending");
    // The task list plugin adds checkboxes.
    expect(out).toContain('type="checkbox"');
  });
});

// ---------------------------------------------------------------------------
// Raw HTML
// ---------------------------------------------------------------------------

describe("raw HTML", () => {
  it("suppresses raw HTML by default (html: false)", () => {
    const out = convert("<script>alert('xss')</script>");
    expect(out).not.toContain("<script>");
  });

  it("allows raw HTML when allowRawHtml: true", () => {
    const out = convert("<em>custom html</em>", { allowRawHtml: true });
    expect(out).toContain("<em>custom html</em>");
  });
});

// ---------------------------------------------------------------------------
// Allowlisted raw <ac:...> passthrough (Channel 4)
// ---------------------------------------------------------------------------

describe("raw ac: passthrough", () => {
  it("passes through an allowlisted macro unchanged", () => {
    const raw = [
      '<ac:structured-macro ac:name="info">',
      "<ac:rich-text-body>",
      "<p>Info message.</p>",
      "</ac:rich-text-body>",
      "</ac:structured-macro>",
    ].join("\n");

    // We use allowRawHtml to ensure the <ac: tags are not stripped.
    const out = convert(raw, { allowRawHtml: true });
    // The allowlisted macro should be passed through.
    expect(out).toContain('<ac:structured-macro ac:name="info">');
    expect(out).toContain("Info message.");
  });

  it("throws ConverterError for a non-allowlisted macro", () => {
    const raw = [
      '<ac:structured-macro ac:name="html">',
      "<ac:rich-text-body><p>xss</p></ac:rich-text-body>",
      "</ac:structured-macro>",
    ].join("\n");

    expect(() => convert(raw, { allowRawHtml: true })).toThrow(ConverterError);
    expect(() => convert(raw, { allowRawHtml: true })).toThrow(
      "Macro 'html' is not in the allowlist"
    );
  });

  it("includes the rejected macro name and points to documentation in error message", () => {
    const raw =
      '<ac:structured-macro ac:name="iframe"><ac:parameter ac:name="url">https://evil.com</ac:parameter></ac:structured-macro>';
    let thrown: Error | null = null;
    try {
      convert(raw, { allowRawHtml: true });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(ConverterError);
    expect((thrown as ConverterError).code).toBe("MACRO_NOT_ALLOWED");
    expect(thrown!.message).toContain("iframe");
    expect(thrown!.message).toContain("allowlist");
  });
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe("size cap", () => {
  it("throws ConverterError for input > 1 MB", () => {
    // 1 MB + 1 byte
    const oversized = "a".repeat(1_048_577);
    expect(() => convert(oversized)).toThrow(ConverterError);
    expect(() => convert(oversized)).toThrow("1 MB cap");
  });

  it("throws with INPUT_TOO_LARGE code", () => {
    const oversized = "a".repeat(1_048_577);
    let thrown: ConverterError | null = null;
    try {
      convert(oversized);
    } catch (e) {
      thrown = e as ConverterError;
    }
    expect(thrown).toBeInstanceOf(ConverterError);
    expect(thrown!.code).toBe("INPUT_TOO_LARGE");
  });

  it("accepts input exactly at 1 MB", () => {
    // Exactly 1 MB of ASCII (1 byte each) should succeed.
    const exactly = "a".repeat(1_048_576);
    expect(() => convert(exactly)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("failure modes", () => {
  it("throws ConverterError for null input", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => convert(null)).toThrow(ConverterError);
  });

  it("throws ConverterError for undefined input", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => convert(undefined)).toThrow(ConverterError);
  });

  it("throws ConverterError for non-string input", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => convert(42)).toThrow(ConverterError);
  });
});

// ---------------------------------------------------------------------------
// URL-spoofing regression (from Stream 1 url-parser fixtures)
// ---------------------------------------------------------------------------

describe("URL-spoofing regression", () => {
  it("does not rewrite subdomain-extended URL as internal", () => {
    const spoof = "https://entrixenergy.atlassian.net.attacker.com/wiki/spaces/X/pages/99/Foo";
    const out = convert(`[Foo](${spoof})`, { confluenceBaseUrl: BASE_URL });
    expect(out).not.toContain("<ac:link>");
  });

  it("does not rewrite URL with different port as internal", () => {
    const diffPort = "https://entrixenergy.atlassian.net:8080/wiki/spaces/X/pages/99/Foo";
    const out = convert(`[Foo](${diffPort})`, { confluenceBaseUrl: BASE_URL });
    // Port 8080 vs default 443 — should not match.
    expect(out).not.toContain("<ac:link>");
  });

  it("rewrites URL with explicit port 443 same as default", () => {
    const explicit443 = "https://entrixenergy.atlassian.net:443/wiki/spaces/X/pages/12345/Foo";
    const out = convert(`[Foo](${explicit443})`, { confluenceBaseUrl: BASE_URL });
    // Should rewrite since :443 == default https port
    expect(out).toContain("<ac:link>");
    expect(out).toContain('ri:content-id="12345"');
  });
});

// ---------------------------------------------------------------------------
// Self-closing void elements
// ---------------------------------------------------------------------------

describe("void element self-closing", () => {
  it("self-closes <hr> in rendered output", () => {
    const out = convert("---");
    expect(out).toContain("<hr/>");
    expect(out).not.toMatch(/<hr(?!\/)>/);
  });

  it("self-closes <br> tags (when breaks: true would produce them)", () => {
    // With breaks: false (default), line breaks don't produce <br>.
    // We can still check the self-close transformer works by using allowRawHtml.
    const out = convert("<br>", { allowRawHtml: true });
    // Should be self-closed.
    expect(out).toContain("<br/>");
    expect(out).not.toMatch(/<br(?!\/)>/);
  });
});

// ---------------------------------------------------------------------------
// Linkify
// ---------------------------------------------------------------------------

describe("linkify", () => {
  it("turns bare https:// URLs into links", () => {
    const out = convert("See https://example.com today.");
    expect(out).toContain('<a href="https://example.com"');
  });
});

// ---------------------------------------------------------------------------
// Typography off
// ---------------------------------------------------------------------------

describe("typographer off", () => {
  it("does NOT convert straight quotes to curly quotes", () => {
    const out = convert("He said 'hello'.");
    // With typographer: false, single quotes should remain as-is (not become curly quotes).
    expect(out).toContain("'hello'");
    expect(out).not.toContain("\u2018"); // left single quotation mark
    expect(out).not.toContain("\u2019"); // right single quotation mark
  });

  it("does NOT convert -- to em-dash", () => {
    const out = convert("one -- two");
    expect(out).toContain("--");
    expect(out).not.toContain("\u2013"); // en-dash
    expect(out).not.toContain("\u2014"); // em-dash
  });
});
