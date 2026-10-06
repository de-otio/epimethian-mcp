import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  macroNamesPerLine,
  splitStorageBlocks,
  stripVolatileAttributes,
} from "./storage-normalise.js";

const FC = { seed: 20261006, numRuns: 200 };

describe("stripVolatileAttributes", () => {
  it("removes local-id, ac:local-id and ac:macro-id from start tags", () => {
    const html =
      '<p local-id="a1">x</p>' +
      '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="m-1" ac:local-id="l-1">' +
      "<ac:rich-text-body><p>y</p></ac:rich-text-body></ac:structured-macro>";
    expect(stripVolatileAttributes(html)).toBe(
      "<p>x</p>" +
        '<ac:structured-macro ac:name="info" ac:schema-version="1">' +
        "<ac:rich-text-body><p>y</p></ac:rich-text-body></ac:structured-macro>",
    );
  });

  it("handles single-quoted values, repeated whitespace and self-closing tags", () => {
    expect(stripVolatileAttributes("<p   local-id='z'   class=\"c\">t</p>")).toBe('<p   class="c">t</p>');
    expect(stripVolatileAttributes('<ri:user ri:account-id="u" local-id="q" />')).toBe(
      '<ri:user ri:account-id="u" />',
    );
  });

  it("leaves other attributes, near-miss names and attribute VALUES alone", () => {
    const html = '<p data-local-id="keep" title=\'x local-id="not an attribute"\' ac:name="local-id">t</p>';
    expect(stripVolatileAttributes(html)).toBe(html);
  });

  it("does not touch CDATA payloads or comments", () => {
    const html =
      '<ac:plain-text-body><![CDATA[<p local-id="in-code">x</p>]]></ac:plain-text-body>' +
      '<!-- <p local-id="in-comment"> -->' +
      '<p local-id="gone">t</p>';
    expect(stripVolatileAttributes(html)).toBe(
      '<ac:plain-text-body><![CDATA[<p local-id="in-code">x</p>]]></ac:plain-text-body>' +
        '<!-- <p local-id="in-comment"> -->' +
        "<p>t</p>",
    );
  });

  it("does not touch text content that looks like an attribute", () => {
    const html = '<p>set local-id="5" and ac:macro-id="6" here</p>';
    expect(stripVolatileAttributes(html)).toBe(html);
  });

  it("copes with a quoted '>' inside an attribute value", () => {
    expect(stripVolatileAttributes('<p title="a > b" local-id="x">t</p>')).toBe('<p title="a > b">t</p>');
  });

  it("returns empty and attribute-free input unchanged", () => {
    expect(stripVolatileAttributes("")).toBe("");
    expect(stripVolatileAttributes("<p>plain</p>")).toBe("<p>plain</p>");
  });

  it("two bodies that differ only in regenerated ids normalise equal", () => {
    const a = '<ac:structured-macro ac:name="toc" ac:macro-id="one"></ac:structured-macro>';
    const b = '<ac:structured-macro ac:name="toc" ac:macro-id="two"></ac:structured-macro>';
    expect(stripVolatileAttributes(a)).toBe(stripVolatileAttributes(b));
  });

  it("a real parameter change survives normalisation", () => {
    const a = '<ac:structured-macro ac:name="info" ac:macro-id="one"><ac:parameter ac:name="title">A</ac:parameter></ac:structured-macro>';
    const b = '<ac:structured-macro ac:name="info" ac:macro-id="two"><ac:parameter ac:name="title">B</ac:parameter></ac:structured-macro>';
    expect(stripVolatileAttributes(a)).not.toBe(stripVolatileAttributes(b));
  });

  it("is linear on a hostile input of unterminated quotes", () => {
    const hostile = '<a "'.repeat(50_000);
    const start = performance.now();
    stripVolatileAttributes(hostile);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("property: idempotent, and never leaves a volatile attribute in a generated tag", () => {
    const attrName = fc.constantFrom("local-id", "ac:local-id", "ac:macro-id", "class", "ac:name", "data-local-id", "id");
    const attr = fc.tuple(attrName, fc.stringMatching(/^[A-Za-z0-9 _-]{0,8}$/), fc.boolean()).map(
      ([n, v, single]) => (single ? ` ${n}='${v}'` : ` ${n}="${v}"`),
    );
    const tag = fc.tuple(fc.constantFrom("p", "ac:structured-macro", "span"), fc.array(attr, { maxLength: 4 }), fc.stringMatching(/^[a-z ]{0,6}$/)).map(
      ([t, attrs, text]) => `<${t}${attrs.join("")}>${text}</${t}>`,
    );
    fc.assert(
      fc.property(fc.array(tag, { maxLength: 6 }), (tags) => {
        const html = tags.join("");
        const once = stripVolatileAttributes(html);
        expect(stripVolatileAttributes(once)).toBe(once);
        expect(once).not.toMatch(/\s(?:ac:local-id|ac:macro-id|local-id)\s*=/);
        // Everything that is not a volatile attribute is preserved.
        expect(once.replace(/<[^>]*>/g, "")).toBe(html.replace(/<[^>]*>/g, ""));
      }),
      FC,
    );
  });
});

describe("splitStorageBlocks", () => {
  it("puts block tags on their own lines without blank lines", () => {
    const out = splitStorageBlocks("<h1>T</h1><p>a <strong>b</strong></p><ul><li>x</li></ul>");
    expect(out.split("\n")).toEqual([
      "<h1>T",
      "</h1>",
      "<p>a <strong>b</strong>",
      "</p>",
      "<ul>",
      "<li>x",
      "</li>",
      "</ul>",
    ]);
  });

  it("splits macro parts so a parameter change is its own line", () => {
    const out = splitStorageBlocks(
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>',
    );
    const lines = out.split("\n");
    expect(lines).toContain('<ac:parameter ac:name="title">T');
    expect(lines.some((l) => l.startsWith("<ac:rich-text-body>"))).toBe(true);
  });

  it("leaves CDATA payloads byte-identical, including their own newlines and fake tags", () => {
    const cdata = "<![CDATA[line1\n<p>not a block</p>\nline3]]>";
    const out = splitStorageBlocks(`<p>a</p><ac:plain-text-body>${cdata}</ac:plain-text-body>`);
    expect(out).toContain(cdata);
  });

  it("preserves all non-newline characters", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z<>/ ="p0-9]{0,60}$/), (s) => {
        expect(splitStorageBlocks(s).replace(/\n/g, "")).toBe(s.replace(/\n/g, ""));
      }),
      FC,
    );
  });
});

describe("macroNamesPerLine", () => {
  it("attributes lines inside a macro, including parameter lines, to that macro", () => {
    const lines = splitStorageBlocks(
      '<p>intro</p><ac:structured-macro ac:name="info"><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro><p>after</p>',
    ).split("\n");
    const names = macroNamesPerLine(lines);
    const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(names[idx("intro")]).toEqual([]);
    expect(names[idx('ac:name="title"')]).toEqual(["info"]);
    expect(names[idx("<p>x")]).toEqual(["info"]);
    expect(names[idx("after")]).toEqual([]);
  });

  it("tracks nesting and self-closing macros", () => {
    const lines = splitStorageBlocks(
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body><ac:structured-macro ac:name="panel"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="toc" /><p>tail</p>',
    ).split("\n");
    const names = macroNamesPerLine(lines);
    const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(names[idx("deep")]).toEqual(["panel"]);
    expect(names[idx("tail")]).toEqual([]);
  });

  it("drops names outside [A-Za-z0-9_-] instead of reporting them", () => {
    const lines = ['<ac:structured-macro ac:name="bad name!&lt;x">', "<p>in</p>", "</ac:structured-macro>"];
    expect(macroNamesPerLine(lines).flat()).toEqual([]);
  });
});
