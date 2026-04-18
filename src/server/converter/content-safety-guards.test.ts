/**
 * Tests for content-safety guards (1A, 1B, 1C).
 *
 * These guards protect against accidental content loss on both the
 * markdown and storage-format code paths — see Finding 1 in the
 * security review.
 */
import { describe, expect, it } from "vitest";
import {
  enforceContentSafetyGuards,
  enforceContentFloorGuard,
  countHeadings,
  extractTextContent,
  SHRINKAGE_GUARD_MIN_OLD_LEN,
  SHRINKAGE_GUARD_MAX_RATIO,
  STRUCTURE_GUARD_MIN_OLD_HEADINGS,
  EMPTY_BODY_MIN_OLD_LEN,
  EMPTY_BODY_MIN_TEXT_LEN,
  CONTENT_FLOOR_MIN_OLD_LEN,
  CONTENT_FLOOR_MIN_RATIO,
  CONTENT_FLOOR_MIN_OLD_TEXT_LEN,
  CONTENT_FLOOR_MIN_NEW_TEXT_LEN,
} from "./content-safety-guards.js";
import {
  ConverterError,
  SHRINKAGE_NOT_CONFIRMED,
  STRUCTURE_LOSS_NOT_CONFIRMED,
  EMPTY_BODY_REJECTED,
  CONTENT_FLOOR_BREACHED,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a storage body of a given character length. */
function bigStorage(len: number): string {
  const inner = "x".repeat(Math.max(0, len - 7)); // <p>...</p>
  return `<p>${inner}</p>`;
}

/** Build storage with a given number of headings. */
function storageWithHeadings(count: number, bodyLen = 600): string {
  const headings = Array.from(
    { length: count },
    (_, i) => `<h${(i % 6) + 1}>Heading ${i + 1}</h${(i % 6) + 1}>`,
  ).join("\n");
  const padding = "<p>" + "x".repeat(Math.max(0, bodyLen - headings.length)) + "</p>";
  return headings + "\n" + padding;
}

// ---------------------------------------------------------------------------
// 1A: Content-shrinkage guard
// ---------------------------------------------------------------------------

describe("enforceContentSafetyGuards — shrinkage guard (1A)", () => {
  const bigOld = bigStorage(1000);

  it("throws SHRINKAGE_NOT_CONFIRMED when body shrinks >50%", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: "<p>tiny</p>",
      }),
    ).toThrow(
      expect.objectContaining({
        code: SHRINKAGE_NOT_CONFIRMED,
      }),
    );
  });

  it("includes percentage in error message", () => {
    try {
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: "<p>tiny</p>",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConverterError);
      expect((err as ConverterError).message).toMatch(/\d+% reduction/);
    }
  });

  it("allows shrinkage when confirmShrinkage is true", () => {
    // New body must have >100 chars of text to avoid empty-body guard (1C)
    const text = "a".repeat(150);
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: `<p>${text}</p>`,
        confirmShrinkage: true,
      }),
    ).not.toThrow();
  });

  it("does not trigger on small pages (< 500 chars)", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: "<p>small</p>",
        newStorage: "<p>x</p>",
      }),
    ).not.toThrow();
  });

  it("does not trigger when reduction is < 50%", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: bigStorage(600), // > 50% of 1000
      }),
    ).not.toThrow();
  });

  it("does not trigger when new body is exactly 50% of old", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: bigStorage(500), // exactly 50%
      }),
    ).not.toThrow();
  });

  it("triggers at the threshold boundary (just under 50%)", () => {
    const oldLen = SHRINKAGE_GUARD_MIN_OLD_LEN + 100;
    const old = bigStorage(oldLen);
    const newLen = Math.floor(oldLen * SHRINKAGE_GUARD_MAX_RATIO) - 1;
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: bigStorage(newLen),
      }),
    ).toThrow(
      expect.objectContaining({ code: SHRINKAGE_NOT_CONFIRMED }),
    );
  });
});

// ---------------------------------------------------------------------------
// 1B: Structural integrity check
// ---------------------------------------------------------------------------

describe("enforceContentSafetyGuards — structural integrity (1B)", () => {
  it("throws STRUCTURE_LOSS_NOT_CONFIRMED when heading count drops >50%", () => {
    const old = storageWithHeadings(6);
    const newS = storageWithHeadings(2);
    expect(() =>
      enforceContentSafetyGuards({ oldStorage: old, newStorage: newS }),
    ).toThrow(
      expect.objectContaining({ code: STRUCTURE_LOSS_NOT_CONFIRMED }),
    );
  });

  it("allows heading drop when confirmStructureLoss is true", () => {
    const old = storageWithHeadings(6);
    const newS = storageWithHeadings(2);
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: newS,
        confirmStructureLoss: true,
      }),
    ).not.toThrow();
  });

  it("does not trigger with fewer than 3 old headings", () => {
    const old = storageWithHeadings(2);
    const newS = storageWithHeadings(0);
    expect(() =>
      enforceContentSafetyGuards({ oldStorage: old, newStorage: newS }),
    ).not.toThrow();
  });

  it("does not trigger when heading drop is < 50%", () => {
    const old = storageWithHeadings(6);
    const newS = storageWithHeadings(4); // 33% drop
    expect(() =>
      enforceContentSafetyGuards({ oldStorage: old, newStorage: newS }),
    ).not.toThrow();
  });

  it("includes heading counts in error message", () => {
    try {
      enforceContentSafetyGuards({
        oldStorage: storageWithHeadings(10),
        newStorage: storageWithHeadings(2),
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ConverterError).message).toMatch(/from 10 to 2/);
    }
  });
});

// ---------------------------------------------------------------------------
// countHeadings — CDATA / code block exclusion (Finding 7)
// ---------------------------------------------------------------------------

describe("countHeadings — CDATA/code block exclusion (Finding 7)", () => {
  it("counts top-level headings", () => {
    expect(countHeadings("<h1>A</h1><h2>B</h2><h3>C</h3>")).toBe(3);
  });

  it("excludes headings inside ac:plain-text-body (code macros)", () => {
    const storage =
      '<h1>Real</h1>' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body>' +
      "<h2>Not real</h2><h3>Also not real</h3>" +
      "</ac:plain-text-body></ac:structured-macro>";
    expect(countHeadings(storage)).toBe(1);
  });

  it("excludes headings inside HTML comments", () => {
    const storage = "<h1>Real</h1><!-- <h2>Commented out</h2> -->";
    expect(countHeadings(storage)).toBe(1);
  });

  it("returns 0 for storage with no headings", () => {
    expect(countHeadings("<p>No headings here</p>")).toBe(0);
  });

  it("handles empty string", () => {
    expect(countHeadings("")).toBe(0);
  });

  it("counts headings with attributes", () => {
    expect(countHeadings('<h1 class="title">A</h1><h2 id="b">B</h2>')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 1C: Empty-body rejection
// ---------------------------------------------------------------------------

describe("enforceContentSafetyGuards — empty-body rejection (1C)", () => {
  const bigOld = bigStorage(1000);

  it("rejects body with only tags and no text content", () => {
    const onlyMacro =
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>';
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: onlyMacro,
        confirmShrinkage: true, // bypass 1A to test 1C
      }),
    ).toThrow(
      expect.objectContaining({ code: EMPTY_BODY_REJECTED }),
    );
  });

  it("rejects body with only whitespace after tag stripping", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: "<p>   </p>",
        confirmShrinkage: true, // bypass 1A to test 1C
      }),
    ).toThrow(
      expect.objectContaining({ code: EMPTY_BODY_REJECTED }),
    );
  });

  it("has no opt-out — confirmShrinkage does not bypass empty-body guard", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: "<p></p>",
        confirmShrinkage: true,
        confirmStructureLoss: true,
      }),
    ).toThrow(
      expect.objectContaining({ code: EMPTY_BODY_REJECTED }),
    );
  });

  it("does not trigger when old body is small (< 500 chars)", () => {
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: "<p>tiny</p>",
        newStorage: "<p></p>",
      }),
    ).not.toThrow();
  });

  it("allows body with >100 chars of text content", () => {
    const text = "a".repeat(150);
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigOld,
        newStorage: `<p>${text}</p>`,
        confirmShrinkage: true, // bypass 1A to test 1C threshold
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractTextContent — HTML entity bypass prevention (Finding 3)
// ---------------------------------------------------------------------------

describe("extractTextContent — entity handling (Finding 3)", () => {
  it("strips HTML tags", () => {
    expect(extractTextContent("<p>hello</p>")).toBe("hello");
  });

  it("normalizes &nbsp; entities to space (not inflated chars)", () => {
    const html = "&nbsp;".repeat(50);
    // Each &nbsp; becomes a single space, not 6 chars
    const result = extractTextContent(html);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("normalizes numeric entities", () => {
    const html = "&#160;".repeat(50);
    const result = extractTextContent(html);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("strips HTML comments", () => {
    const html = "<!-- 200 chars of comment text here --><p>short</p>";
    expect(extractTextContent(html)).toBe("short");
  });

  it("handles mixed content", () => {
    const html = "<h1>Title</h1><p>Body &amp; more</p><!-- comment -->";
    const result = extractTextContent(html);
    expect(result).toContain("Title");
    expect(result).toContain("Body");
    expect(result).not.toContain("<!--");
  });
});

// ---------------------------------------------------------------------------
// Guard ordering: shrinkage fires before structural, structural before empty
// ---------------------------------------------------------------------------

describe("enforceContentSafetyGuards — guard ordering", () => {
  it("shrinkage guard fires before structural guard", () => {
    // Body that triggers both: big -> tiny, many headings -> none
    const old = storageWithHeadings(10, 1000);
    try {
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: "<p>x</p>",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      // Shrinkage fires first
      expect((err as ConverterError).code).toBe(SHRINKAGE_NOT_CONFIRMED);
    }
  });

  it("structural guard fires when shrinkage is confirmed but headings drop", () => {
    const old = storageWithHeadings(10, 1000);
    const newS = "<p>" + "x".repeat(800) + "</p>"; // size ok, no headings
    try {
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: newS,
        confirmShrinkage: true,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ConverterError).code).toBe(STRUCTURE_LOSS_NOT_CONFIRMED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: guards apply to storage-format bodies (Finding 1 fix)
// ---------------------------------------------------------------------------

describe("enforceContentSafetyGuards — works on raw storage format (Finding 1)", () => {
  it("catches shrinkage in raw storage body", () => {
    const bigHtml = "<p>" + "x".repeat(1000) + "</p>";
    const tinyHtml = "<p>y</p>";
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigHtml,
        newStorage: tinyHtml,
      }),
    ).toThrow(
      expect.objectContaining({ code: SHRINKAGE_NOT_CONFIRMED }),
    );
  });

  it("catches empty body in raw storage format", () => {
    const bigHtml = "<p>" + "x".repeat(1000) + "</p>";
    const emptyHtml = '<ac:structured-macro ac:name="toc"/>';
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: bigHtml,
        newStorage: emptyHtml,
        confirmShrinkage: true, // bypass 1A to test 1C
      }),
    ).toThrow(
      expect.objectContaining({ code: EMPTY_BODY_REJECTED }),
    );
  });
});

// ---------------------------------------------------------------------------
// 1F: Content floor guard (hard floor, no opt-out) — security audit Finding 3
// ---------------------------------------------------------------------------

describe("enforceContentFloorGuard — length floor (1F)", () => {
  it("rejects when new body drops below 10% of old body on a >500 char page", () => {
    const old = "<p>" + "x".repeat(1000) + "</p>"; // ~1006 chars
    const tiny = "<p>y</p>"; // ~8 chars, well below 10% floor
    expect(() => enforceContentFloorGuard(old, tiny)).toThrow(
      expect.objectContaining({ code: CONTENT_FLOOR_BREACHED }),
    );
  });

  it("passes when new body stays above 10% of old body", () => {
    const old = "<p>" + "x".repeat(1000) + "</p>";
    const large = "<p>" + "y".repeat(200) + "</p>"; // ~20% — above floor
    expect(() => enforceContentFloorGuard(old, large)).not.toThrow();
  });

  it("exempts short pages (oldLen <= 500)", () => {
    const short = "<p>" + "x".repeat(400) + "</p>"; // ~406 chars — below threshold
    const tiny = "<p>y</p>";
    // Length floor does not apply (oldLen < 500). Text floor may still
    // apply, but text length of ~400 chars old vs 1 char new triggers the
    // text floor if oldText > 200 — so this particular case DOES throw via
    // the text floor. Use a shorter old body that dodges both.
    const reallyShort = "<p>" + "x".repeat(150) + "</p>";
    expect(() => enforceContentFloorGuard(reallyShort, tiny)).not.toThrow();
    // The earlier example throws via text floor, not length floor —
    // verifying that specific path here for completeness.
    expect(() => enforceContentFloorGuard(short, tiny)).toThrow(
      expect.objectContaining({ code: CONTENT_FLOOR_BREACHED }),
    );
  });

  it("error message cites the hard floor and the no-opt-out policy", () => {
    const old = "<p>" + "x".repeat(1000) + "</p>";
    const tiny = "<p>y</p>";
    expect(() => enforceContentFloorGuard(old, tiny)).toThrow(
      /confirm_shrinkage: true.*confirm_structure_loss: true/s,
    );
    expect(() => enforceContentFloorGuard(old, tiny)).toThrow(
      /delete and recreate/,
    );
  });
});

describe("enforceContentFloorGuard — text floor (1F)", () => {
  it("rejects when visible text drops below 10 chars on a >200 text page", () => {
    const old =
      "<p>" + "word ".repeat(60) + "</p>"; // ~300 chars visible text
    // New has lots of markup but <10 visible chars
    const mostlyMarkup = '<ac:structured-macro ac:name="toc"/>hi';
    expect(() => enforceContentFloorGuard(old, mostlyMarkup)).toThrow(
      expect.objectContaining({ code: CONTENT_FLOOR_BREACHED }),
    );
  });

  it("passes when visible text stays above 10 chars", () => {
    const old = "<p>" + "word ".repeat(60) + "</p>";
    const smallButVisible = "<p>hello world here</p>";
    expect(() => enforceContentFloorGuard(old, smallButVisible)).not.toThrow();
  });
});

describe("enforceContentSafetyGuards — floor guard is the last line of defence", () => {
  it("fires even with confirm_shrinkage: true AND confirm_structure_loss: true", () => {
    // This is the exact attack the floor guard defends against: prompt
    // injection talks the agent into setting both confirm flags, defeating
    // 1A and 1B. 1F MUST still reject the write.
    // Build a new body that survives 1C (≥3 visible chars) but still
    // breaches 1F's length floor — so we exercise 1F specifically.
    const old = "<h1>Real heading</h1>" + "<p>" + "x".repeat(1500) + "</p>";
    const smallButNonEmpty = "<h1>Hello world</h1>"; // 20 chars, 11 visible
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: smallButNonEmpty,
        confirmShrinkage: true,
        confirmStructureLoss: true,
        confirmDeletions: true,
      }),
    ).toThrow(expect.objectContaining({ code: CONTENT_FLOOR_BREACHED }));
  });

  it("does not fire on legitimate moderate rewrites even with confirms set", () => {
    // Heading loss (1B) + mild shrinkage (1A) — confirms bypass those. The
    // floor must pass because the new body still has substantive content.
    const old =
      "<h1>Old heading</h1>" +
      "<h2>Subsection</h2>" +
      "<p>" +
      "x".repeat(2000) +
      "</p>";
    const rewrite =
      "<p>" + "replaced content goes here. ".repeat(20) + "</p>"; // ~560 chars
    expect(() =>
      enforceContentSafetyGuards({
        oldStorage: old,
        newStorage: rewrite,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      }),
    ).not.toThrow();
  });

  it("lets 1A fire first (SHRINKAGE_NOT_CONFIRMED) when no confirms are set", () => {
    // Ordering: floor runs LAST. If 1A's gate applies (no confirm), the
    // caller gets the actionable "set confirm_shrinkage" error, not the
    // unrecoverable floor error.
    const old = "<p>" + "x".repeat(1000) + "</p>";
    const tiny = "<p>y</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage: old, newStorage: tiny }),
    ).toThrow(expect.objectContaining({ code: SHRINKAGE_NOT_CONFIRMED }));
  });
});
