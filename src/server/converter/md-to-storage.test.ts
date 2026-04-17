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
    // Stream 11: headings now carry Confluence-slug IDs.
    const out = convert("# Heading 1");
    expect(out).toContain('<h1 id="heading-1">Heading 1</h1>');
  });

  it("renders h2", () => {
    const out = convert("## Heading 2");
    expect(out).toContain('<h2 id="heading-2">Heading 2</h2>');
  });

  it("renders h3", () => {
    const out = convert("### Heading 3");
    expect(out).toContain('<h3 id="heading-3">Heading 3</h3>');
  });

  it("renders h4", () => {
    const out = convert("#### Heading 4");
    expect(out).toContain('<h4 id="heading-4">Heading 4</h4>');
  });

  it("renders h5", () => {
    const out = convert("##### Heading 5");
    expect(out).toContain('<h5 id="heading-5">Heading 5</h5>');
  });

  it("renders h6", () => {
    const out = convert("###### Heading 6");
    expect(out).toContain('<h6 id="heading-6">Heading 6</h6>');
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

  it("emits a plain <a href> anchor for internal Confluence URLs (B2)", () => {
    // Prior to B2, this path emitted <ac:link> with <ri:page ri:content-id="…"/>
    // + <ac:plain-text-link-body> — a legacy storage shape that Confluence Cloud's
    // modern renderer does NOT display anchor text for. B2 collapses internal and
    // external links into the same plain-anchor shape, which always renders.
    const url = `${BASE_URL}/wiki/spaces/ETD/pages/875954196/EX-3946+Overview`;
    const out = convert(`[Overview](${url})`, { confluenceBaseUrl: BASE_URL });
    expect(out).toContain(`<a href="${url}">Overview</a>`);
    expect(out).not.toContain("<ac:link>");
    expect(out).not.toContain("ri:content-id");
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
// B1 tripwire: internal Confluence link anchor-text round-trip
// ---------------------------------------------------------------------------
//
// These tests assert the renderer-visible behaviour of rewriteConfluenceLinks.
//
// B2 has landed: rewriteConfluenceLinks is an identity pass and internal
// URLs reach the output as plain <a href> anchors — the same shape markdown-it
// already produces for external URLs. These tests pin that behaviour against
// regressions that would reintroduce the renderer-invisible legacy shape.
//
// See: plans/centralized-write-safety-implementation.md  §B1, §B2
//      plans/centralized-write-safety.md  §"rewriteConfluenceLinks emits a storage shape that doesn't render"

const B2_BASE = "https://configured.base";

describe("B1 — rewriteConfluenceLinks anchor-text round-trip (B2 tripwire)", () => {
  // B2 has landed: rewriteConfluenceLinks is now an identity pass, so the
  // markdown-it-produced `<a href="…">text</a>` reaches the output unchanged.
  // This assertion pins that behaviour — if a future change reintroduces the
  // legacy `<ac:link>` + `ri:content-id` + `<ac:plain-text-link-body>` shape
  // for internal URLs, this test fails and the renderer-invisible-link class
  // of bug is caught before it ships.
  it(
    "internal link emits a plain <a> anchor whose visible text matches the markdown link label",
    () => {
      const internalUrl = `${B2_BASE}/wiki/spaces/X/pages/123`;
      const out = convert(`[click here](${internalUrl})`, { confluenceBaseUrl: B2_BASE });
      // Plain <a href="...">click here</a> renders correctly on Confluence Cloud
      // and everywhere else, identical to how external links have always worked.
      expect(out).toContain(`<a href="${internalUrl}">click here</a>`);
    }
  );

  // Companion (passing): external links must continue to emit plain <a href> anchors.
  // Pins existing external-link behaviour so B2 cannot accidentally regress it.
  it("external link (non-matching host) still emits a plain <a> anchor with correct visible text", () => {
    const externalUrl = "https://external.example.com/some/path";
    const out = convert(`[read more](${externalUrl})`, { confluenceBaseUrl: B2_BASE });
    expect(out).toContain(`<a href="${externalUrl}">read more</a>`);
    expect(out).not.toContain("<ac:link>");
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

  it("treats URL with explicit port 443 as internal (plain <a> after B2)", () => {
    const explicit443 = "https://entrixenergy.atlassian.net:443/wiki/spaces/X/pages/12345/Foo";
    const out = convert(`[Foo](${explicit443})`, { confluenceBaseUrl: BASE_URL });
    // :443 == default https port, so the URL is recognised as internal. Post-B2
    // that no longer changes the emitted shape — markdown-it's plain <a href>
    // is preserved. The spoofing-regression neighbours (above + below) assert
    // the negative case; this one pins that matching an internal URL doesn't
    // mangle it into the legacy <ac:link> shape.
    expect(out).toContain(`<a href="${explicit443}">Foo</a>`);
    expect(out).not.toContain("<ac:link>");
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

// ---------------------------------------------------------------------------
// Stream 7 — GitHub alert panel syntax
// ---------------------------------------------------------------------------

describe("GitHub alert panels (Stream 7)", () => {
  // All 5 types without title
  it("renders [!INFO] as info macro (no title)", () => {
    const md = "> [!INFO]\n> Body content.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="info" ac:schema-version="1">');
    expect(out).toContain("<ac:rich-text-body>");
    expect(out).toContain("Body content.");
    expect(out).not.toContain('<ac:parameter ac:name="title">');
    // Must NOT produce a plain blockquote.
    expect(out).not.toContain("<blockquote>");
  });

  it("renders [!NOTE] as note macro (no title)", () => {
    const md = "> [!NOTE]\n> Note content.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="note" ac:schema-version="1">');
    expect(out).toContain("Note content.");
  });

  it("renders [!WARNING] as warning macro (no title)", () => {
    const md = "> [!WARNING]\n> Watch out!";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="warning" ac:schema-version="1">');
    expect(out).toContain("Watch out!");
  });

  it("renders [!TIP] as tip macro (no title)", () => {
    const md = "> [!TIP]\n> Helpful tip.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="tip" ac:schema-version="1">');
    expect(out).toContain("Helpful tip.");
  });

  it("renders [!SUCCESS] as success macro (no title)", () => {
    const md = "> [!SUCCESS]\n> It worked!";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="success" ac:schema-version="1">');
    expect(out).toContain("It worked!");
  });

  // Optional title
  it("renders [!WARNING] with optional title", () => {
    const md = "> [!WARNING] Danger Zone\n> Body.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="warning" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="title">Danger Zone</ac:parameter>');
    expect(out).toContain("Body.");
  });

  it("renders [!INFO] with title that contains XML-special chars (escaped)", () => {
    const md = "> [!INFO] Title with <em> & 'quotes'\n> Body.";
    const out = convert(md);
    expect(out).toContain("&lt;em&gt;");
    expect(out).toContain("&amp;");
    // Should not contain unescaped angle brackets in parameter value.
    expect(out).not.toContain('<ac:parameter ac:name="title">Title with <em>');
  });

  it("renders multi-paragraph body in alert", () => {
    const md = "> [!INFO]\n> First paragraph.\n>\n> Second paragraph.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="info"');
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
  });

  it("leaves plain blockquotes unchanged", () => {
    const md = "> This is just a blockquote.";
    const out = convert(md);
    expect(out).toContain("<blockquote>");
    expect(out).not.toContain("<ac:structured-macro");
  });

  it("is case-insensitive for the alert type keyword", () => {
    const md = "> [!info]\n> Lower case type.";
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="info"');
    expect(out).toContain("Lower case type.");
  });
});

// ---------------------------------------------------------------------------
// Stream 8 — Container fenced divs
// ---------------------------------------------------------------------------

describe("container fenced divs (Stream 8)", () => {
  it("renders ::: panel with title", () => {
    const md = '::: panel title="My Panel"\nContent.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="panel" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="title">My Panel</ac:parameter>');
    expect(out).toContain("<ac:rich-text-body>");
    expect(out).toContain("Content.");
    expect(out).toContain("</ac:rich-text-body></ac:structured-macro>");
  });

  it("renders ::: panel with bgColor", () => {
    const md = '::: panel title="Coloured" bgColor=#FFF7E0\nContent.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:parameter ac:name="bgColor">#FFF7E0</ac:parameter>');
  });

  it("renders ::: panel with borderColor", () => {
    const md = '::: panel title="Bordered" bgColor=#FFF7E0 borderColor=#36B37E\nContent.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:parameter ac:name="borderColor">#36B37E</ac:parameter>');
  });

  it("renders ::: panel without optional colour params", () => {
    const md = '::: panel title="Minimal"\nJust text.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="panel"');
    expect(out).not.toContain("bgColor");
    expect(out).not.toContain("borderColor");
  });

  it("escapes XML-special chars in panel title", () => {
    const md = '::: panel title="A & B <x>"\nContent.\n:::';
    const out = convert(md);
    expect(out).toContain("A &amp; B &lt;x&gt;");
  });

  it("renders ::: expand with title and macro-id", () => {
    const md = '::: expand title="Click me"\nHidden content.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="expand" ac:schema-version="1"');
    expect(out).toContain('ac:macro-id="');
    expect(out).toContain('<ac:parameter ac:name="title">Click me</ac:parameter>');
    expect(out).toContain("Hidden content.");
  });

  it("renders ::: expand without title", () => {
    const md = '::: expand\nSome hidden text.\n:::';
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="expand"');
    expect(out).not.toContain('<ac:parameter ac:name="title">');
    expect(out).toContain("Some hidden text.");
  });

  it("renders two-column layout", () => {
    const md = [
      "::: columns",
      "::: column",
      "Left content.",
      ":::",
      "::: column",
      "Right content.",
      ":::",
      ":::",
    ].join("\n");
    const out = convert(md);
    expect(out).toContain("<ac:layout>");
    expect(out).toContain('<ac:layout-section ac:type="two_equal">');
    expect(out).toContain("<ac:layout-cell>");
    expect(out).toContain("Left content.");
    expect(out).toContain("Right content.");
    expect(out).toContain("</ac:layout-cell>");
    expect(out).toContain("</ac:layout-section>");
    expect(out).toContain("</ac:layout>");
    // No sentinel should remain.
    expect(out).not.toContain("@@@");
  });

  it("renders three-column layout", () => {
    const md = [
      "::: columns",
      "::: column",
      "A.",
      ":::",
      "::: column",
      "B.",
      ":::",
      "::: column",
      "C.",
      ":::",
      ":::",
    ].join("\n");
    const out = convert(md);
    expect(out).toContain('<ac:layout-section ac:type="three_equal">');
    expect(out).toContain("A.");
    expect(out).toContain("B.");
    expect(out).toContain("C.");
  });

  it("throws ConverterError for unsupported column count (1 column)", () => {
    const md = ["::: columns", "::: column", "Solo.", ":::", ":::"].join("\n");
    expect(() => convert(md)).toThrow("exactly 2 or 3");
  });

  it("throws ConverterError for unsupported column count (4 columns)", () => {
    const cols = ["::: columns", ...[1, 2, 3, 4].map((n) => `::: column\nCol ${n}.\n:::`), ":::"].join("\n");
    expect(() => convert(cols)).toThrow("exactly 2 or 3");
  });
});

// ---------------------------------------------------------------------------
// Stream 9 — Inline directives
// ---------------------------------------------------------------------------

describe("inline directives (Stream 9)", () => {
  // --- :status ---
  it("renders :status with valid colour", () => {
    const out = convert("Status: :status[In Progress]{colour=Blue}");
    expect(out).toContain('<ac:structured-macro ac:name="status" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="title">In Progress</ac:parameter>');
    expect(out).toContain('<ac:parameter ac:name="colour">Blue</ac:parameter>');
  });

  it.each(["Grey", "Red", "Yellow", "Green", "Blue", "Purple"])(
    "accepts status colour %s",
    (colour) => {
      const out = convert(`:status[Label]{colour=${colour}}`);
      expect(out).toContain(`<ac:parameter ac:name="colour">${colour}</ac:parameter>`);
    }
  );

  it("throws ConverterError for invalid status colour", () => {
    expect(() => convert(":status[Done]{colour=Pink}")).toThrow("Invalid status colour");
    expect(() => convert(":status[Done]{colour=Pink}")).toThrow("Grey, Red, Yellow, Green, Blue, Purple");
  });

  it("escapes XML-special chars in status title", () => {
    const out = convert(":status[A & B]{colour=Green}");
    expect(out).toContain("A &amp; B");
  });

  // --- :mention ---
  it("renders :mention with valid modern accountId", () => {
    const accountId = "557058:abc12345-def0-1234-abcd-0123456789ab";
    const out = convert(`:mention[Richard]{accountId=${accountId}}`);
    expect(out).toContain("<ac:link>");
    expect(out).toContain(`<ri:user ri:account-id="${accountId}"/>`);
    expect(out).toContain("</ac:link>");
  });

  it("throws ConverterError for invalid accountId", () => {
    expect(() => convert(":mention[Bob]{accountId=not-valid}")).toThrow("Invalid Atlassian account ID");
  });

  it("throws ConverterError for accountId with XML injection attempt", () => {
    expect(() => convert(':mention[Bob]{accountId="><script>}')).toThrow("Invalid Atlassian account ID");
  });

  // --- :date ---
  it("renders :date with valid ISO date", () => {
    const out = convert(":date[2026-04-30]");
    expect(out).toContain('<time datetime="2026-04-30"/>');
  });

  it("throws ConverterError for non-ISO date format", () => {
    expect(() => convert(":date[April 30 2026]")).toThrow("Invalid date");
    expect(() => convert(":date[April 30 2026]")).toThrow("YYYY-MM-DD");
  });

  it("throws ConverterError for partial date", () => {
    expect(() => convert(":date[2026-04]")).toThrow("Invalid date");
  });

  // --- :emoji ---
  it("renders :emoji with valid emoticon name", () => {
    const out = convert(":emoji[smile]");
    expect(out).toContain('<ac:emoticon ac:name="smile"/>');
  });

  it.each(["sad", "cheeky", "laugh", "wink", "thumbs-up", "thumbs-down", "tick", "cross"])(
    "accepts emoticon %s",
    (name) => {
      const out = convert(`:emoji[${name}]`);
      expect(out).toContain(`<ac:emoticon ac:name="${name}"/>`);
    }
  );

  it("throws ConverterError for unknown emoticon name", () => {
    expect(() => convert(":emoji[party-popper]")).toThrow("Unknown emoticon name");
    expect(() => convert(":emoji[party-popper]")).toThrow("smile");
  });

  // --- :jira ---
  it("renders :jira with key only", () => {
    const out = convert(":jira[PROJ-123]");
    expect(out).toContain('<ac:structured-macro ac:name="jira" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="key">PROJ-123</ac:parameter>');
    expect(out).not.toContain('<ac:parameter ac:name="server">');
  });

  it("renders :jira with key and server", () => {
    // Server name with spaces must be quoted in the directive.
    const out = convert(':jira[ABC-456]{server="System Jira"}');
    expect(out).toContain('<ac:parameter ac:name="key">ABC-456</ac:parameter>');
    expect(out).toContain('<ac:parameter ac:name="server">System Jira</ac:parameter>');
  });

  it("throws ConverterError for malformed Jira key", () => {
    expect(() => convert(":jira[proj-123]")).toThrow("Invalid Jira issue key");
    expect(() => convert(":jira[NOHYPHEN]")).toThrow("Invalid Jira issue key");
  });

  // --- :anchor ---
  it("renders :anchor with a named anchor", () => {
    const out = convert(":anchor[my-section]");
    expect(out).toContain('<ac:structured-macro ac:name="anchor" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="">my-section</ac:parameter>');
  });

  it("throws ConverterError for empty anchor name", () => {
    expect(() => convert(":anchor[]")).toThrow("non-empty anchor name");
  });

  it("throws ConverterError for whitespace-only anchor name", () => {
    expect(() => convert(":anchor[   ]")).toThrow("non-empty anchor name");
  });

  // Directives inside table cells
  it("renders :status inside a table cell", () => {
    const md = [
      "| Feature | Status |",
      "|---------|--------|",
      "| Auth | :status[Done]{colour=Green} |",
    ].join("\n");
    const out = convert(md);
    expect(out).toContain("<table>");
    expect(out).toContain('<ac:structured-macro ac:name="status"');
    expect(out).toContain('<ac:parameter ac:name="colour">Green</ac:parameter>');
  });

  // Multiple directives in one paragraph
  it("renders multiple directives in one paragraph", () => {
    const out = convert(":emoji[smile] :jira[EX-1] :date[2026-01-01]");
    expect(out).toContain('<ac:emoticon ac:name="smile"/>');
    expect(out).toContain('<ac:parameter ac:name="key">EX-1</ac:parameter>');
    expect(out).toContain('<time datetime="2026-01-01"/>');
  });
});

// ---------------------------------------------------------------------------
// Stream 10 — Frontmatter + ToC injection
// ---------------------------------------------------------------------------

describe("frontmatter and ToC injection (Stream 10)", () => {
  it("injects ToC macro when toc: is present in frontmatter", () => {
    const md = [
      "---",
      "toc:",
      "  maxLevel: 3",
      "  minLevel: 1",
      "---",
      "# Page",
    ].join("\n");
    const out = convert(md);
    expect(out).toContain('<ac:structured-macro ac:name="toc" ac:schema-version="1">');
    expect(out).toContain('<ac:parameter ac:name="maxLevel">3</ac:parameter>');
    expect(out).toContain('<ac:parameter ac:name="minLevel">1</ac:parameter>');
    // ToC must come first.
    expect(out.indexOf("<ac:structured-macro ac:name=\"toc\"")).toBeLessThan(
      out.indexOf("<h1")
    );
  });

  it("injects ToC with style param", () => {
    const md = ["---", "toc:", '  style: "disc"', "---", "# Title"].join("\n");
    const out = convert(md);
    expect(out).toContain('<ac:parameter ac:name="style">disc</ac:parameter>');
  });

  it("does not inject ToC when frontmatter is absent", () => {
    const out = convert("# Page without frontmatter");
    expect(out).not.toContain("<ac:structured-macro ac:name=\"toc\"");
  });

  it("strips frontmatter from the body (does not include --- markers)", () => {
    const md = ["---", "toc:", "  maxLevel: 2", "---", "# Content"].join("\n");
    const out = convert(md);
    expect(out).not.toContain("---");
    // The heading should still be rendered.
    expect(out).toContain("Content");
  });

  it("applies headingOffset: 1 to shift all headings up by 1", () => {
    const md = ["---", "headingOffset: 1", "---", "# H1 becomes H2", "## H2 becomes H3"].join("\n");
    const out = convert(md);
    // # becomes h2
    expect(out).toMatch(/<h2\b[^>]*>H1 becomes H2<\/h2>/);
    // ## becomes h3
    expect(out).toMatch(/<h3\b[^>]*>H2 becomes H3<\/h3>/);
    // Must not contain raw h1 or h2 for these headings.
    expect(out).not.toMatch(/<h1\b/);
  });

  it("headingOffset: 0 (default) leaves headings unchanged", () => {
    const md = ["---", "headingOffset: 0", "---", "# Top level"].join("\n");
    const out = convert(md);
    expect(out).toMatch(/<h1\b[^>]*>Top level<\/h1>/);
  });

  it("passes through markdown with no frontmatter unchanged", () => {
    const out = convert("Just a paragraph.");
    expect(out).toContain("<p>Just a paragraph.</p>");
    expect(out).not.toContain("<ac:structured-macro");
  });

  it("does not treat bare --- (horizontal rule) as frontmatter", () => {
    const out = convert("---");
    expect(out).toContain("<hr/>");
    expect(out).not.toContain("frontmatter");
    expect(out).not.toContain("<ac:structured-macro");
  });
});

// ---------------------------------------------------------------------------
// Stream 11 — Heading anchor slugger
// ---------------------------------------------------------------------------

describe("heading anchor slugger (Stream 11)", () => {
  it("generates slug ID for plain ASCII heading", () => {
    const out = convert("# Hello World");
    expect(out).toContain('<h1 id="hello-world">Hello World</h1>');
  });

  it("lowercases the heading text in the slug", () => {
    const out = convert("## My Heading");
    expect(out).toContain('id="my-heading"');
  });

  it("replaces non-alphanumeric runs with a single hyphen", () => {
    const out = convert("# Hello, World! How are you?");
    expect(out).toContain('id="hello-world-how-are-you"');
  });

  it("trims leading and trailing hyphens from slug", () => {
    const out = convert("# -- Leading and trailing --");
    expect(out).toContain('id="leading-and-trailing"');
  });

  it("handles special characters (collapses to hyphens)", () => {
    const out = convert("## C++ Performance");
    expect(out).toContain('id="c-performance"');
  });

  it("handles duplicate headings with dot-number suffix", () => {
    const md = "# Section\n\n## Section\n\n### Section";
    const out = convert(md);
    // First occurrence: bare slug.
    expect(out).toContain('<h1 id="section">Section</h1>');
    // Second occurrence: .1 suffix.
    expect(out).toContain('<h2 id="section.1">Section</h2>');
    // Third occurrence: .2 suffix.
    expect(out).toContain('<h3 id="section.2">Section</h3>');
  });

  it("assigns unique IDs even for different level headings with same text", () => {
    const md = "# Deploy\n\n## Deploy";
    const out = convert(md);
    expect(out).toContain('id="deploy"');
    expect(out).toContain('id="deploy.1"');
  });

  it("all heading levels get IDs", () => {
    const md = [1, 2, 3, 4, 5, 6].map((n) => `${"#".repeat(n)} Heading ${n}`).join("\n\n");
    const out = convert(md);
    for (let n = 1; n <= 6; n++) {
      expect(out).toContain(`id="heading-${n}"`);
    }
  });

  it("heading with numeric-only text gets a slug", () => {
    const out = convert("## 2026");
    expect(out).toContain('id="2026"');
  });

  it("heading with no alphanumeric chars falls back to 'heading'", () => {
    const out = convert("## ---");
    expect(out).toContain('id="heading"');
  });
});
