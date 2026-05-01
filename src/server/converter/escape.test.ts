import { describe, expect, it } from "vitest";
import { escapeCdata, escapeXmlAttr, escapeXmlText } from "./escape.js";

/**
 * Minimal, standards-conformant CDATA extractor for round-trip tests.
 * Reads the content between the first `<![CDATA[` and its matching
 * terminating `]]>`, honouring the real XML rule: any `]]>` inside the
 * CDATA section closes it. Because our escape inserts `]]]]><![CDATA[>`,
 * the extractor has to concatenate sibling CDATA sections separated by
 * nothing.
 */
function readCdata(xmlFragment: string): string {
  // Strip <root> wrappers from tests.
  const OPEN = "<![CDATA[";
  const CLOSE = "]]>";
  let out = "";
  let i = 0;
  while (i < xmlFragment.length) {
    const open = xmlFragment.indexOf(OPEN, i);
    if (open === -1) {
      // Copy any trailing non-CDATA text verbatim (there is none in our
      // tests, but this keeps the helper honest).
      break;
    }
    const close = xmlFragment.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      throw new Error("Unterminated CDATA section in test fixture");
    }
    out += xmlFragment.slice(open + OPEN.length, close);
    i = close + CLOSE.length;
  }
  return out;
}

/**
 * Minimal check that a fragment of the form `<root attr="...">` has no
 * structure-breaking characters. We simply assert no raw `<`, `&` that
 * isn't the head of a valid entity, and no closing quote inside the attr.
 */
function attrValueFromXml(xml: string): string {
  const m = xml.match(/^<root attr="([^"]*)"\/>$/);
  if (!m) throw new Error(`Malformed XML fragment: ${xml}`);
  // Decode XML entities we emit.
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&amp;/g, "&"); // last — don't double-decode
}

describe("escapeXmlAttr", () => {
  it("escapes the five XML predefined entities", () => {
    expect(escapeXmlAttr("&")).toBe("&amp;");
    expect(escapeXmlAttr("<")).toBe("&lt;");
    expect(escapeXmlAttr(">")).toBe("&gt;");
    expect(escapeXmlAttr('"')).toBe("&quot;");
    expect(escapeXmlAttr("'")).toBe("&#39;");
  });

  it("escapes all five characters in a single string", () => {
    expect(escapeXmlAttr(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes control characters as numeric references", () => {
    expect(escapeXmlAttr("\u0000")).toBe("&#x0;");
    expect(escapeXmlAttr("\t")).toBe("&#x9;");
    expect(escapeXmlAttr("\n")).toBe("&#xA;");
    expect(escapeXmlAttr("\r")).toBe("&#xD;");
    expect(escapeXmlAttr("\u001f")).toBe("&#x1F;");
    expect(escapeXmlAttr("\u007f")).toBe("&#x7F;");
    expect(escapeXmlAttr("\u009f")).toBe("&#x9F;");
  });

  it("passes through ordinary ASCII, space, and high-BMP characters", () => {
    expect(escapeXmlAttr("Hello, world!")).toBe("Hello, world!");
    expect(escapeXmlAttr("café 日本語 🐉")).toBe("café 日本語 🐉");
  });

  it("produces output safe to embed in an attribute — double quotes closed", () => {
    const payload = `value&with<all>"special'chars`;
    const escaped = escapeXmlAttr(payload);
    // No raw structural characters remain.
    expect(escaped).not.toContain('"');
    expect(escaped).not.toMatch(/(^|[^&])</);
    // Round-trips via our canonical decoder.
    const xml = `<root attr="${escaped}"/>`;
    expect(attrValueFromXml(xml)).toBe(payload);
  });

  it("breaks-out attempt is neutralised", () => {
    const payload = `" onmouseover="evil()`;
    const escaped = escapeXmlAttr(payload);
    expect(escaped).not.toContain('"');
    expect(`<root attr="${escaped}"/>`).toMatch(/^<root attr="[^"]*"\/>$/);
  });

  it("empty string round-trips", () => {
    expect(escapeXmlAttr("")).toBe("");
  });
});

describe("escapeXmlText", () => {
  it("escapes only &, <, >", () => {
    expect(escapeXmlText("&")).toBe("&amp;");
    expect(escapeXmlText("<")).toBe("&lt;");
    expect(escapeXmlText(">")).toBe("&gt;");
  });

  it("leaves quotes and apostrophes alone", () => {
    expect(escapeXmlText(`"'`)).toBe(`"'`);
  });

  it("leaves control characters alone", () => {
    expect(escapeXmlText("\u0001\n")).toBe("\u0001\n");
  });

  it("empty string round-trips", () => {
    expect(escapeXmlText("")).toBe("");
  });

  it("preserves multi-byte UTF-8", () => {
    expect(escapeXmlText("café <日本語> 🐉")).toBe("café &lt;日本語&gt; 🐉");
  });

  it("escapes ampersand first so that later <, > escaping isn't double-encoded", () => {
    // If the implementation replaced & last, '&lt;' would become '&amp;lt;'.
    expect(escapeXmlText("<tag>")).toBe("&lt;tag&gt;");
    expect(escapeXmlText("A & B < C")).toBe("A &amp; B &lt; C");
  });
});

describe("escapeCdata", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeCdata("nothing special")).toBe("nothing special");
  });

  it("splits a single ]]> into the canonical replacement", () => {
    expect(escapeCdata("]]>")).toBe("]]]]><![CDATA[>");
  });

  it("makes literal ]]> survive a CDATA round-trip", () => {
    const payload = "foo ]]> bar";
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    expect(readCdata(cdata)).toBe(payload);
  });

  it("handles overlapping sequences ]]]]> correctly", () => {
    const payload = "]]]]>";
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    expect(readCdata(cdata)).toBe(payload);
  });

  it("handles three-deep nesting ]]]]]]>  correctly", () => {
    const payload = "]]]]]]>";
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    expect(readCdata(cdata)).toBe(payload);
  });

  it("handles multiple distinct ]]> occurrences", () => {
    const payload = "a]]>b]]>c";
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    expect(readCdata(cdata)).toBe(payload);
  });

  it("preserves multi-byte UTF-8 surrounding a ]]> sequence", () => {
    const payload = "日本語 ]]> 🐉 end";
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    expect(readCdata(cdata)).toBe(payload);
  });

  it("does not touch isolated ]] or > that are not the full terminator", () => {
    expect(escapeCdata("]] and > alone")).toBe("]] and > alone");
  });

  it("empty string round-trips", () => {
    expect(escapeCdata("")).toBe("");
  });

  it("injected macro inside ]]> is neutralised — no structural escape", () => {
    const payload = `]]><ac:structured-macro ac:name="html">evil</ac:structured-macro><![CDATA[ignored`;
    const cdata = `<![CDATA[${escapeCdata(payload)}]]>`;
    // The round-trip must yield the payload verbatim (no tags interpreted
    // as structure).
    expect(readCdata(cdata)).toBe(payload);
  });
});
