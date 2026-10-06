import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/test-connection.js", () => ({
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  verifyTenantIdentity: vi.fn().mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com", message: "Verified" }),
}));

import { toMarkdownView } from "./confluence-client.js";

const macro = (name: string, body: string, params = "") =>
  `<ac:structured-macro ac:name="${name}" ac:schema-version="1" ac:macro-id="id-${name}">` +
  params +
  `<ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;

const param = (n: string, v: string) => `<ac:parameter ac:name="${n}">${v}</ac:parameter>`;

describe("toMarkdownView: rich-text macro bodies (S6)", () => {
  it.each(["info", "note", "warning", "tip", "panel", "expand"])(
    "renders the body of %s as a labelled block quote",
    (name) => {
      const md = toMarkdownView(`<p>before</p>${macro(name, "<p>Edited text inside.</p>")}<p>after</p>`);
      expect(md).toContain(`> [macro: ${name}]`);
      expect(md).toContain("> Edited text inside.");
      expect(md).toContain("before");
      expect(md).toContain("after");
    },
  );

  it("shows safe parameters in the label and keeps formatting inside the quote", () => {
    const md = toMarkdownView(
      macro("expand", "<p>Hello <strong>bold</strong></p><ul><li>one</li><li>two</li></ul>", param("title", "Details") + param("apiKey", "s3cret")),
    );
    expect(md).toContain("> [macro: expand (title=Details)]");
    expect(md).toContain("> Hello **bold**");
    expect(md).toMatch(/>\s+\*\s+one/);
    expect(md).not.toContain("s3cret");
  });

  it("makes an edit inside a panel visible as a text difference", () => {
    const a = toMarkdownView(macro("panel", "<p>Owner: Alice</p>"));
    const b = toMarkdownView(macro("panel", "<p>Owner: Bob</p>"));
    expect(a).not.toBe(b);
    expect(b).toContain("Owner: Bob");
  });

  it("handles nested macros: each body ends where its own macro ends", () => {
    const md = toMarkdownView(
      macro("expand", `<p>outer start</p>${macro("panel", "<p>inner text</p>")}<p>outer end</p>`, param("title", "Outer")) +
        "<p>after everything</p>",
    );
    expect(md).toContain("> [macro: expand (title=Outer)]");
    expect(md).toContain("> > [macro: panel]");
    expect(md).toContain("> > inner text");
    expect(md).toContain("> outer end");
    // The old non-greedy regex left a stray close tag, so the tail text ended up inside the quote.
    const tail = md.split("\n").find((l) => l.includes("after everything"));
    expect(tail).toBe("after everything");
    expect(md).not.toContain("</ac:");
  });

  it("collapses non-rich macros to placeholders and counts only those as hidden", () => {
    const md = toMarkdownView(
      macro("info", "<p>shown</p>") +
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body><![CDATA[secret = 1]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(md).toContain("> shown");
    expect(md).toContain("[macro: code (language=python)]");
    expect(md).not.toContain("secret = 1");
    expect(md).toContain("[Page contains 1 Confluence element not shown");
  });

  it("a rich-text macro nested inside a collapsed macro stays hidden with it", () => {
    const md = toMarkdownView(
      `<ac:structured-macro ac:name="details"><ac:rich-text-body>${macro("info", "<p>hidden inside details</p>")}</ac:rich-text-body></ac:structured-macro>`,
    );
    expect(md).toContain("[macro: details]");
    expect(md).not.toContain("hidden inside details");
  });

  it("takes parameters from the macro itself, not from a nested one", () => {
    const md = toMarkdownView(
      macro("panel", macro("info", "<p>x</p>", param("title", "Inner Title")), param("title", "Outer Title")),
    );
    expect(md).toContain("[macro: panel (title=Outer Title)]");
    expect(md).toContain("[macro: info (title=Inner Title)]");
  });

  it("handles an empty rich-text body, a missing body and a self-closing macro", () => {
    expect(toMarkdownView(macro("info", ""))).toContain("[macro: info]");
    expect(toMarkdownView('<ac:structured-macro ac:name="note"></ac:structured-macro>')).toContain("[macro: note]");
    const md = toMarkdownView('<p>a</p><ac:structured-macro ac:name="toc" /><p>b</p>');
    expect(md).toContain("[macro: toc]");
    expect(md).toContain("a");
    expect(md).toContain("b");
  });

  it("counts images and layouts inside a rendered macro body", () => {
    const md = toMarkdownView(macro("info", '<p>see</p><ac:image><ri:attachment ri:filename="d.png" /></ac:image>'));
    expect(md).toContain("[image: d.png]");
    expect(md).toContain("[Page contains 1 Confluence element not shown");
  });

  it("escapes tenant text in labels instead of injecting markup", () => {
    const md = toMarkdownView(
      `<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">&lt;img src=x onerror=1&gt; **bold**</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>`,
    );
    // The title is shown as literal text, and its markdown is escaped rather than interpreted.
    expect(md).toContain("<img src=x onerror=1>");
    expect(md).not.toMatch(/(?<!\\)\*\*bold\*\*/);
  });

  it("stops expanding at the nesting cap and still terminates", () => {
    let body = "<p>core</p>";
    for (let i = 0; i < 60; i++) body = macro("expand", body);
    const md = toMarkdownView(body);
    expect(md).toContain("[macro: expand]");
    expect(md).not.toContain("</ac:");
  });

  it("stays fast on deep nesting, wide pages and hostile input", () => {
    let deep = "<p>core</p>";
    for (let i = 0; i < 400; i++) deep = macro("panel", deep);
    const wide = Array.from({ length: 2_000 }, (_, i) => macro("info", `<p>item ${i}</p>`)).join("");
    // Deep plain nesting exercises the iterative macro walk. (turndown itself
    // recurses, so this stays well below its own limit.)
    const manyDivs = "<div>".repeat(500) + macro("info", "<p>x</p>") + "</div>".repeat(500);
    const unterminated = '<ac:structured-macro ac:name="info"><ac:rich-text-body>'.repeat(100);

    for (const input of [deep, wide, manyDivs, unterminated]) {
      const started = performance.now();
      toMarkdownView(input);
      expect(performance.now() - started).toBeLessThan(10_000);
    }
  }, 60_000);

  it("keeps the existing behaviour for the plain cases", () => {
    expect(toMarkdownView("")).toBe("");
    expect(toMarkdownView("<p>Just a paragraph</p>")).not.toContain("Confluence element");
    expect(toMarkdownView("<ac:layout><ac:layout-section><ac:layout-cell><p>A</p></ac:layout-cell></ac:layout-section></ac:layout>")).toContain("[layout: 1-column]");
  });
});
