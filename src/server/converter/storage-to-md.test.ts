import { describe, expect, it } from "vitest";
import { storageToMarkdown } from "./storage-to-md.js";
import { restoreFromTokens } from "./restore.js";

describe("storageToMarkdown", () => {
  // ------------------------------------------------------------------ basics
  it("empty storage returns empty markdown and empty sidecar", () => {
    const { markdown, sidecar } = storageToMarkdown("");
    expect(markdown).toBe("");
    expect(sidecar).toEqual({});
  });

  it("plain HTML (no macros) returns markdown with empty sidecar", () => {
    const { markdown, sidecar } = storageToMarkdown(
      "<p>Hello <strong>world</strong></p>"
    );
    expect(markdown).toContain("**world**");
    expect(sidecar).toEqual({});
  });

  // ------------------------------------------------------------------ tokens
  it("single macro produces one token in markdown and one sidecar entry", () => {
    const storage =
      '<p>Before</p>' +
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>' +
      '<p>After</p>';
    const { markdown, sidecar } = storageToMarkdown(storage);

    expect(markdown).toContain("Before");
    expect(markdown).toContain("After");

    const tokenCount = Object.keys(sidecar).length;
    expect(tokenCount).toBe(1);

    // Token must appear verbatim (not backslash-escaped) in the markdown
    const [tokenId, xml] = Object.entries(sidecar)[0];
    expect(markdown).toContain(`[[epi:${tokenId}]]`);
    expect(xml).toContain('ac:name="toc"');
  });

  it("token survives turndown verbatim — [[epi:T####]] not mangled to \\[\\[", () => {
    const storage = '<p>before [[epi:T0042]] after</p>';
    // Feed a pre-formed token as plain text (no Confluence macros) to verify
    // turndown doesn't escape the brackets in the canonical.
    // We use a macro to get a real token so we can verify the final form.
    const macroStorage =
      '<p>start</p><ac:structured-macro ac:name="code"></ac:structured-macro><p>end</p>';
    const { markdown } = storageToMarkdown(macroStorage);
    // Must contain [[epi:T####]] in unescaped form
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
    // Must NOT contain the backslash-escaped form
    expect(markdown).not.toMatch(/\\\[\\\[epi:T\d+\\\]\\\]/);
  });

  it("nested macros (panel containing code) produce a single outer token", () => {
    const storage =
      '<ac:structured-macro ac:name="panel">' +
      '<ac:rich-text-body>' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x = 1]]></ac:plain-text-body></ac:structured-macro>' +
      '</ac:rich-text-body>' +
      '</ac:structured-macro>';
    const { markdown, sidecar } = storageToMarkdown(storage);

    // Outermost-first tokenisation: only one token for the outer panel
    expect(Object.keys(sidecar).length).toBe(1);
    // The sidecar entry contains the entire subtree including the nested code macro
    const xml = Object.values(sidecar)[0];
    expect(xml).toContain('ac:name="panel"');
    expect(xml).toContain('ac:name="code"');
    // Token in markdown
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
  });

  it("table with macros in cells preserves tokens inside the markdown table", () => {
    const storage =
      "<table><tbody><tr>" +
      "<th>Header</th>" +
      "<td><ac:structured-macro ac:name=\"status\"><ac:parameter ac:name=\"colour\">Green</ac:parameter><ac:parameter ac:name=\"title\">Done</ac:parameter></ac:structured-macro></td>" +
      "</tr></tbody></table>";
    const { markdown, sidecar } = storageToMarkdown(storage);

    // Should have exactly one token
    expect(Object.keys(sidecar).length).toBe(1);
    // Token must be verbatim in the markdown output
    const [tokenId] = Object.keys(sidecar);
    expect(markdown).toContain(`[[epi:${tokenId}]]`);
    // Table structure preserved
    expect(markdown).toContain("Header");
  });

  it("headings convert to ATX style", () => {
    const { markdown } = storageToMarkdown("<h1>Title</h1><h2>Section</h2>");
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("## Section");
  });

  it("unordered list converts to GFM bullets", () => {
    const { markdown } = storageToMarkdown(
      "<ul><li>Alpha</li><li>Beta</li></ul>"
    );
    // Turndown may emit "- Alpha" or "-   Alpha" (3 spaces) — either is valid GFM
    expect(markdown).toMatch(/^-\s+Alpha/m);
    expect(markdown).toMatch(/^-\s+Beta/m);
  });

  it("ordered list converts to numbered list", () => {
    const { markdown } = storageToMarkdown(
      "<ol><li>First</li><li>Second</li></ol>"
    );
    expect(markdown).toContain("1.");
    expect(markdown).toContain("First");
    expect(markdown).toContain("Second");
  });

  it("bold and italic convert correctly", () => {
    const { markdown } = storageToMarkdown(
      "<p><strong>bold</strong> and <em>italic</em></p>"
    );
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("_italic_");
  });

  it("inline link converts to GFM link", () => {
    const { markdown } = storageToMarkdown(
      '<p><a href="https://example.com">Example</a></p>'
    );
    expect(markdown).toContain("[Example](https://example.com)");
  });

  it("code block converts to fenced code block", () => {
    const { markdown } = storageToMarkdown(
      "<pre><code>const x = 1;</code></pre>"
    );
    expect(markdown).toContain("```");
    expect(markdown).toContain("const x = 1;");
  });

  // ------------------------------------------------------------------ multiple tokens
  it("multiple macros produce sequential tokens in document order", () => {
    const storage =
      '<ac:structured-macro ac:name="info"></ac:structured-macro>' +
      '<p>middle</p>' +
      '<ac:structured-macro ac:name="warning"></ac:structured-macro>';
    const { markdown, sidecar } = storageToMarkdown(storage);

    const entries = Object.entries(sidecar);
    expect(entries.length).toBe(2);

    const [id1, xml1] = entries[0];
    const [id2, xml2] = entries[1];
    expect(id1).toBe("T0001");
    expect(id2).toBe("T0002");
    expect(xml1).toContain('ac:name="info"');
    expect(xml2).toContain('ac:name="warning"');

    // Both tokens appear verbatim in markdown
    expect(markdown).toContain("[[epi:T0001]]");
    expect(markdown).toContain("[[epi:T0002]]");
    expect(markdown).toContain("middle");
  });

  // ------------------------------------------------------------------ restore round-trip
  it("tokens in markdown survive verbatim — restoreFromTokens produces original XML", () => {
    const storage =
      '<p>intro</p>' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[print("hi")]]></ac:plain-text-body></ac:structured-macro>' +
      '<p>outro</p>';
    const { markdown, sidecar } = storageToMarkdown(storage);

    // Tokens must be verbatim in the markdown
    const tokenIds = Object.keys(sidecar);
    for (const id of tokenIds) {
      expect(markdown).toContain(`[[epi:${id}]]`);
    }

    // Restore: the sidecar XML for each token must match what was tokenised
    const restored = restoreFromTokens(markdown, sidecar);
    // The restored string must contain the original macro XML
    expect(restored).toContain('ac:name="code"');
    expect(restored).toContain("print");
  });

  // ------------------------------------------------------------------ ri: elements
  it("ri: elements are tokenised", () => {
    const storage =
      '<p>See <ac:link><ri:page ri:content-title="Home"/></ac:link></p>';
    const { markdown, sidecar } = storageToMarkdown(storage);
    // The ac:link wraps the ri:page — outermost is ac:link
    expect(Object.keys(sidecar).length).toBeGreaterThan(0);
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
  });

  // ------------------------------------------------------------------ time element
  it("time element is tokenised", () => {
    const storage = '<p>Meeting on <time datetime="2024-01-15">Jan 15</time></p>';
    const { markdown, sidecar } = storageToMarkdown(storage);
    expect(Object.keys(sidecar).length).toBe(1);
    const xml = Object.values(sidecar)[0];
    expect(xml).toContain("<time");
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
  });
});
