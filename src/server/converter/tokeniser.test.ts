import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { restoreFromTokens } from "./restore.js";
import { tokeniseStorage } from "./tokeniser.js";

/**
 * Extract every token ID from a canonical string in document order.
 */
function extractTokens(canonical: string): string[] {
  const re = /\[\[epi:(T\d+)\]\]/g;
  const ids: string[] = [];
  for (const m of canonical.matchAll(re)) ids.push(m[1]!);
  return ids;
}

describe("tokeniseStorage — basic cases", () => {
  it("empty input → empty canonical and sidecar", () => {
    const r = tokeniseStorage("");
    expect(r.canonical).toBe("");
    expect(r.sidecar).toEqual({});
  });

  it("plain <p>hello</p> is unchanged and has empty sidecar", () => {
    const input = "<p>hello</p>";
    const r = tokeniseStorage(input);
    expect(r.canonical).toBe(input);
    expect(r.sidecar).toEqual({});
  });

  it("plain text without elements passes through", () => {
    const r = tokeniseStorage("just words, no markup");
    expect(r.canonical).toBe("just words, no markup");
    expect(r.sidecar).toEqual({});
  });

  it("single <ac:structured-macro> → one token, one sidecar entry", () => {
    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>`;
    const r = tokeniseStorage(macro);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(r.sidecar).toEqual({ T0001: macro });
  });

  it("mixed siblings: paragraph, macro, paragraph → macro between", () => {
    const macro = `<ac:structured-macro ac:name="note"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>`;
    const input = `<p>a</p>${macro}<p>b</p>`;
    const r = tokeniseStorage(input);
    expect(r.canonical).toBe("<p>a</p>[[epi:T0001]]<p>b</p>");
    expect(r.sidecar.T0001).toBe(macro);
  });

  it("nested macros are captured as a single outer token (panel > code > emoticon)", () => {
    const panel =
      `<ac:structured-macro ac:name="panel" ac:macro-id="p-1">` +
      `<ac:parameter ac:name="title">T</ac:parameter>` +
      `<ac:rich-text-body>` +
      `<ac:structured-macro ac:name="code" ac:macro-id="c-1">` +
      `<ac:parameter ac:name="language">js</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[return 1;]]></ac:plain-text-body>` +
      `</ac:structured-macro>` +
      `<p>and <ac:emoticon ac:name="smile"/>.</p>` +
      `</ac:rich-text-body>` +
      `</ac:structured-macro>`;
    const r = tokeniseStorage(panel);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(Object.keys(r.sidecar)).toEqual(["T0001"]);
    expect(r.sidecar.T0001).toBe(panel);
  });

  it("<ac:layout> with multiple sections and cells is a single token", () => {
    const layout =
      `<ac:layout>` +
      `<ac:layout-section ac:type="two_equal">` +
      `<ac:layout-cell><p>left</p></ac:layout-cell>` +
      `<ac:layout-cell><p>right</p></ac:layout-cell>` +
      `</ac:layout-section>` +
      `<ac:layout-section ac:type="single">` +
      `<ac:layout-cell><p>bottom</p></ac:layout-cell>` +
      `</ac:layout-section>` +
      `</ac:layout>`;
    const r = tokeniseStorage(layout);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(r.sidecar.T0001).toBe(layout);
  });

  it("drawio macro round-trips verbatim", () => {
    const drawio =
      `<ac:structured-macro ac:name="drawio" ac:macro-id="dm-42">` +
      `<ac:parameter ac:name="diagramName">flow</ac:parameter>` +
      `<ac:parameter ac:name="revision">3</ac:parameter>` +
      `<ac:parameter ac:name="simple">0</ac:parameter>` +
      `</ac:structured-macro>`;
    const r = tokeniseStorage(drawio);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(r.sidecar.T0001).toBe(drawio);
    expect(restoreFromTokens(r.canonical, r.sidecar)).toBe(drawio);
  });

  it("standalone <time datetime=...> tokenises", () => {
    const input = `<p>date: <time datetime="2024-06-01"/></p>`;
    const r = tokeniseStorage(input);
    // The <time> element is inside a <p>; the <p> remains, but <time> becomes a token.
    expect(r.canonical).toBe(`<p>date: [[epi:T0001]]</p>`);
    expect(r.sidecar.T0001).toBe(`<time datetime="2024-06-01"/>`);
  });

  it("standalone <ri:page/> tokenises", () => {
    const input = `<ri:page ri:content-title="Home" ri:space-key="ETD"/>`;
    const r = tokeniseStorage(input);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(r.sidecar.T0001).toBe(input);
  });

  it("multiple top-level ac:* siblings → sequentially numbered tokens", () => {
    const m1 = `<ac:structured-macro ac:name="info"></ac:structured-macro>`;
    const m2 = `<ac:structured-macro ac:name="note"></ac:structured-macro>`;
    const m3 = `<ac:structured-macro ac:name="warning"></ac:structured-macro>`;
    const input = `${m1}${m2}${m3}`;
    const r = tokeniseStorage(input);
    expect(r.canonical).toBe("[[epi:T0001]][[epi:T0002]][[epi:T0003]]");
    expect(r.sidecar.T0001).toBe(m1);
    expect(r.sidecar.T0002).toBe(m2);
    expect(r.sidecar.T0003).toBe(m3);
  });

  it("preserves whitespace, attribute order, and ac:macro-id UUIDs byte-for-byte", () => {
    const macro =
      `<ac:structured-macro\n` +
      `    ac:name="info"\n` +
      `    ac:schema-version="1"\n` +
      `    ac:macro-id="8f2a7c5e-1b3d-4e9a-9c12-abcdef012345"\n` +
      `  >\n` +
      `    <ac:parameter ac:name="title">Hello  World</ac:parameter>\n` +
      `    <ac:rich-text-body>\n` +
      `      <p>inside</p>\n` +
      `    </ac:rich-text-body>\n` +
      `</ac:structured-macro>`;
    const input = `before ${macro} after`;
    const r = tokeniseStorage(input);
    // The sidecar entry MUST be an exact substring of the original input.
    const id = extractTokens(r.canonical)[0]!;
    expect(input.includes(r.sidecar[id]!)).toBe(true);
    expect(r.sidecar[id]).toBe(macro);
    // And round-tripping must reproduce the original input byte-for-byte.
    expect(restoreFromTokens(r.canonical, r.sidecar)).toBe(input);
  });

  it("preserves CDATA sections, including embedded ']]>' sequences", () => {
    const code =
      `<ac:structured-macro ac:name="code">` +
      `<ac:plain-text-body><![CDATA[some ]]]]><![CDATA[> code]]></ac:plain-text-body>` +
      `</ac:structured-macro>`;
    const r = tokeniseStorage(code);
    expect(r.canonical).toBe("[[epi:T0001]]");
    expect(r.sidecar.T0001).toBe(code);
    expect(restoreFromTokens(r.canonical, r.sidecar)).toBe(code);
  });

  it("does not tokenise plain HTML elements like <p>, <ul>, <table>", () => {
    const input = `<p>a</p><ul><li>x</li></ul><table><tr><td>c</td></tr></table>`;
    const r = tokeniseStorage(input);
    expect(r.sidecar).toEqual({});
    expect(r.canonical).toBe(input);
  });

  it("tokens inside nested non-ac elements still tokenise (e.g. <p><time/></p>)", () => {
    const input = `<p>x <time datetime="2024-01-01"/> y</p>`;
    const r = tokeniseStorage(input);
    expect(r.canonical).toBe(`<p>x [[epi:T0001]] y</p>`);
    expect(r.sidecar.T0001).toBe(`<time datetime="2024-01-01"/>`);
  });

  it("counter zero-pads to at least 4 digits and grows beyond 9999", () => {
    // Build 10001 simple tokenisable elements. Verify the 10000th is T10000.
    const one = `<ri:user ri:account-id="u"/>`;
    const input = one.repeat(10001);
    const r = tokeniseStorage(input);
    expect(r.sidecar.T0001).toBe(one);
    expect(r.sidecar.T0009).toBe(one);
    expect(r.sidecar.T9999).toBe(one);
    expect(r.sidecar.T10000).toBe(one);
    expect(r.sidecar.T10001).toBe(one);
    // Round-trip integrity.
    expect(restoreFromTokens(r.canonical, r.sidecar)).toBe(input);
  });
});

describe("tokeniseStorage — round-trip property tests", () => {
  // Fixture pool of Confluence-style opaque elements.
  const MACRO_FIXTURES: string[] = [
    `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>`,
    `<ac:structured-macro ac:name="warning" ac:macro-id="w-1"><ac:rich-text-body><p>W</p></ac:rich-text-body></ac:structured-macro>`,
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>`,
    `<ac:link><ri:page ri:content-title="Home" ri:space-key="ETD"/></ac:link>`,
    `<ac:image ac:align="center"><ri:attachment ri:filename="pic.png"/></ac:image>`,
    `<time datetime="2024-02-14"/>`,
    `<ac:emoticon ac:name="smile"/>`,
    `<ac:structured-macro ac:name="panel"><ac:rich-text-body><ac:structured-macro ac:name="info"><ac:rich-text-body><p>n</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>`,
    `<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>L</p></ac:layout-cell><ac:layout-cell><p>R</p></ac:layout-cell></ac:layout-section></ac:layout>`,
  ];

  const TEXT_FIXTURES: string[] = [
    "",
    " ",
    "hello",
    "<p>a paragraph</p>",
    "<h1>heading</h1>",
    "<ul><li>x</li><li>y</li></ul>",
    "text with <em>emphasis</em> in it",
    "\n\n  \n",
  ];

  /**
   * Deterministic pseudo-random generator so failures are reproducible.
   * xorshift32 over a seed that is incremented per test iteration.
   */
  function rng(seed: number): () => number {
    let s = seed | 0;
    if (s === 0) s = 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 1_000_000) / 1_000_000;
    };
  }

  function pick<T>(arr: T[], r: () => number): T {
    return arr[Math.floor(r() * arr.length)]!;
  }

  function buildRandomStorage(r: () => number): string {
    const pieces: string[] = [];
    const count = 1 + Math.floor(r() * 8);
    for (let i = 0; i < count; i++) {
      if (r() < 0.5) pieces.push(pick(TEXT_FIXTURES, r));
      else pieces.push(pick(MACRO_FIXTURES, r));
    }
    return pieces.join("");
  }

  it("1000 random storage samples round-trip byte-for-byte", () => {
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const rand = rng(i + 1);
      const src = buildRandomStorage(rand);
      const { canonical, sidecar } = tokeniseStorage(src);
      const restored = restoreFromTokens(canonical, sidecar);
      if (restored !== src) {
        // Surface the failing input in the assertion message.
        throw new Error(
          `round-trip mismatch on iteration ${i}: ` +
            `src=${JSON.stringify(src)} restored=${JSON.stringify(restored)}`
        );
      }
    }
  });
});

describe("token form — GFM table cell compatibility", () => {
  // This test is the canary for the choice of token form documented at
  // the top of tokeniser.ts. If it fails, the token literal no longer
  // survives markdown-it's GFM-table renderer and must be changed.
  it("the bracket token form survives a markdown-it render inside a table cell", () => {
    const md = new MarkdownIt({ html: false });
    const table =
      `| Col A | Col B |\n` +
      `| ----- | ----- |\n` +
      `| [[epi:T0042]] | plain cell |\n`;
    const rendered = md.render(table);
    expect(rendered).toContain("[[epi:T0042]]");
  });

  it("the bracket token form survives rendering in paragraphs and lists", () => {
    const md = new MarkdownIt({ html: false });
    const src =
      `Paragraph with [[epi:T0001]] inside.\n\n` +
      `- list item [[epi:T0002]]\n` +
      `- other\n`;
    const rendered = md.render(src);
    expect(rendered).toContain("[[epi:T0001]]");
    expect(rendered).toContain("[[epi:T0002]]");
  });
});
