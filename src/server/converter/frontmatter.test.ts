import { afterEach, describe, expect, it } from "vitest";
import { MAX_FRONTMATTER_CHARS, splitFrontmatter } from "./frontmatter.js";
import { markdownToStorage } from "./md-to-storage.js";

const lines = (...l: string[]): string => l.join("\n");

describe("splitFrontmatter", () => {
  it("splits a mapping block from the body", () => {
    const r = splitFrontmatter(lines("---", "toc:", "  maxLevel: 3", "---", "# Body", ""));
    expect(r).toEqual({ data: { toc: { maxLevel: 3 } }, body: "# Body\n" });
  });

  it("handles CRLF line endings", () => {
    const r = splitFrontmatter("---\r\ntoc:\r\n  maxLevel: 3\r\n---\r\n# Body\r\n");
    expect(r?.data).toEqual({ toc: { maxLevel: 3 } });
    expect(r?.body).toBe("# Body\r\n");
  });

  it("ignores a leading byte-order mark", () => {
    const r = splitFrontmatter("\uFEFF---\nheadingOffset: 1\n---\nbody\n");
    expect(r).toEqual({ data: { headingOffset: 1 }, body: "body\n" });
  });

  it("accepts the YAML `...` terminator and keeps the body", () => {
    const r = splitFrontmatter(lines("---", "toc:", "  maxLevel: 3", "...", "# Body", "", "text", ""));
    expect(r?.data).toEqual({ toc: { maxLevel: 3 } });
    expect(r?.body).toBe("# Body\n\ntext\n");
  });

  it("closes at the first terminator line and leaves later rules in the body", () => {
    const r = splitFrontmatter(lines("---", "a: 1", "---", "text", "", "---", "", "more"));
    expect(r?.body).toBe("text\n\n---\n\nmore");
  });

  it("accepts a closing delimiter at the very end of the input", () => {
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({ data: { a: 1 }, body: "" });
  });

  it("treats an empty or comment-only block as empty frontmatter", () => {
    expect(splitFrontmatter(lines("---", "# just a comment", "---", "body"))).toEqual({
      data: {},
      body: "body",
    });
    expect(splitFrontmatter(lines("---", "~", "---", "body"))).toEqual({ data: {}, body: "body" });
  });

  describe("returns undefined (document untouched) when", () => {
    const untouched: Record<string, string> = {
      "no frontmatter": "# Heading\n\ntext",
      "a bare horizontal rule": "---",
      "a rule pair with no block between": lines("---", "---", "body"),
      "there is no closing delimiter": lines("---", "toc:", "  maxLevel: 3", "# Body"),
      "leading whitespace precedes the opening line": lines("", "---", "a: 1", "---", "body"),
      "the opening line carries a language tag": lines("---json", '{"a": 1}', "---", "body"),
      "the block is prose between two rules (a scalar)": lines("---", "Some intro text", "---", "Rest"),
      "the block is a sequence": lines("---", "- a", "- b", "---", "body"),
      "the YAML is malformed": lines("---", "a: [unclosed", "---", "body"),
      "a key is duplicated": lines("---", "a: 1", "a: 2", "---", "body"),
      "the block uses a JavaScript tag": lines("---", "a: !!js/function 'function(){}'", "---", "body"),
    };
    for (const [name, md] of Object.entries(untouched)) {
      it(name, () => {
        expect(splitFrontmatter(md)).toBeUndefined();
      });
    }

    it("the block exceeds the size limit", () => {
      const big = `---\n${"k: v\n".repeat(Math.ceil(MAX_FRONTMATTER_CHARS / 5) + 1)}---\nbody`;
      expect(splitFrontmatter(big)).toBeUndefined();
    });
  });

  describe("JSON_SCHEMA only", () => {
    it("does not evaluate code from a `---js` block", () => {
      (globalThis as Record<string, unknown>).__frontmatterProbe = undefined;
      splitFrontmatter(lines("---js", "globalThis.__frontmatterProbe = true", "---", "body"));
      expect((globalThis as Record<string, unknown>).__frontmatterProbe).toBeUndefined();
    });

    it("does not give timestamps or merge keys special meaning", () => {
      const r = splitFrontmatter(
        lines("---", "date: 2020-01-01", "base: &b {x: 1}", "child:", "  <<: *b", "---", "body"),
      );
      expect(r?.data["date"]).toBe("2020-01-01");
      expect(r?.data["child"]).toEqual({ "<<": { x: 1 } });
    });
  });

  describe("anchors and aliases", () => {
    afterEach(() => {
      (globalThis as Record<string, unknown>).__frontmatterProbe = undefined;
    });

    it("resolves a simple alias", () => {
      const r = splitFrontmatter(lines("---", "a: &x [1, 2]", "b: *x", "---", "body"));
      expect(r?.data).toEqual({ a: [1, 2], b: [1, 2] });
    });

    it("parses an exponential alias chain in bounded time (aliases share, not copy)", () => {
      // Nine levels of nine references would expand to ~387 million entries if copied.
      const levels = ["l0: &l0 [x, x, x, x, x, x, x, x, x]"];
      for (let i = 1; i < 9; i++) {
        const prev = `*l${i - 1}`;
        levels.push(`l${i}: &l${i} [${Array(9).fill(prev).join(", ")}]`);
      }
      const started = Date.now();
      const r = splitFrontmatter(lines("---", ...levels, "---", "body"));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r?.body).toBe("body");
    });
  });
});

describe("markdownToStorage frontmatter handling", () => {
  it("keeps the whole body when the block is closed with `...`", () => {
    const out = markdownToStorage(
      lines("---", "toc:", "  maxLevel: 2", "...", "# Title", "", "Paragraph one.", ""),
    );
    expect(out).toContain('<ac:parameter ac:name="maxLevel">2</ac:parameter>');
    expect(out).toContain("Title</h1>");
    expect(out).toContain("<p>Paragraph one.</p>");
  });

  it("does not drop prose that sits between two horizontal rules", () => {
    const out = markdownToStorage(lines("---", "Some intro text", "---", "Rest"));
    expect(out).toContain("Some intro text");
    expect(out).toContain("Rest");
  });

  it("keeps the document intact when the YAML is malformed", () => {
    const out = markdownToStorage(lines("---", "toc: [", "---", "# Title"));
    expect(out).toContain("Title");
    expect(out).not.toContain('ac:name="toc"');
  });

  it("ignores a non-integer headingOffset instead of emitting an invalid tag", () => {
    for (const offset of [".nan", "1.5", ".inf"]) {
      const out = markdownToStorage(lines("---", `headingOffset: ${offset}`, "---", "# Top"));
      expect(out, offset).toMatch(/<h1\b[^>]*>Top<\/h1>/);
      expect(out, offset).not.toMatch(/<hNaN|<h[0-9]\./);
    }
  });

  it("drops a ToC field written as a map or sequence instead of stringifying it", () => {
    const out = markdownToStorage(
      lines("---", "toc:", "  maxLevel: [1, 2]", "  minLevel: {a: 1}", "  style: disc", "---", "# T"),
    );
    expect(out).toContain('<ac:parameter ac:name="style">disc</ac:parameter>');
    expect(out).not.toContain('ac:name="maxLevel"');
    expect(out).not.toContain('ac:name="minLevel"');
    expect(out).not.toContain("[object Object]");
  });

  it("does not expand an alias-bomb ToC field", () => {
    const levels = ["l0: &l0 [x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 9; i++) {
      levels.push(`l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(", ")}]`);
    }
    const started = Date.now();
    const out = markdownToStorage(
      lines("---", ...levels, "toc:", "  maxLevel: *l8", "---", "# T"),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).not.toContain('ac:name="maxLevel"');
  });

  it("passes string ToC values through as before", () => {
    const out = markdownToStorage(lines("---", "toc:", '  maxLevel: "3"', "---", "# T"));
    expect(out).toContain('<ac:parameter ac:name="maxLevel">3</ac:parameter>');
  });
});
