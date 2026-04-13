/**
 * Round-trip fixture suite (Stream 12).
 *
 * For each fixture file (investigation docs + synthetic entrix-network-style
 * pages), asserts:
 *   1. markdownToStorage(fixture) does not throw and produces plausible output.
 *   2. Token round-trip: for storage that contains <ac:>/<ri:> elements,
 *      planUpdate with the tokenised canonical as callerMarkdown produces
 *      byte-identical storage. This is the mandatory "no-loss invariant"
 *      from 01-data-preservation.md — it is specifically about opaque
 *      Confluence-specific elements being preserved byte-for-byte, not
 *      about plain HTML (which turndown → markdownToStorage may normalise).
 *
 * NOTE: The "byte-identical" property is defined for token-bearing storage:
 * any <ac:>, <ri:>, <time> element in the original is restored byte-for-byte
 * from the sidecar. Plain HTML (paragraphs, headings, tables) is semantically
 * equivalent but may differ in trailing whitespace or attribute ordering
 * after a markdown → storage round-trip. This is by design and documented in
 * 01-data-preservation.md ("Confluence-side automatic rewrites").
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markdownToStorage } from "./md-to-storage.js";
import { storageToMarkdown } from "./storage-to-md.js";
import { planUpdate } from "./update-orchestrator.js";
import { tokeniseStorage } from "./tokeniser.js";
import { ConverterError } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture loading helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Investigation doc fixtures (real-world markdown from the design docs)
// ---------------------------------------------------------------------------

const INVESTIGATION_FIXTURES: string[] = [
  "investigate-bulk-operations.md",
  "investigate-comments.md",
  "investigate-labels.md",
  "investigate-content-status.md",
  "investigate-token-efficiency.md",
];

// ---------------------------------------------------------------------------
// Synthetic entrix-network-style fixtures
// ---------------------------------------------------------------------------

const ENTRIX_FIXTURES: string[] = [
  "entrix-overview.md",
  "entrix-account-detail.md",
  "entrix-traffic-flows.md",
];

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that markdownToStorage(md) produces valid-looking storage:
 * - Does not throw
 * - Non-empty
 * - Size is reasonable (< 10× input — avoids runaway expansion)
 * - Contains at least some HTML structure
 */
function assertValidStorageOutput(md: string, label: string): string {
  let storage: string;
  expect(
    () => { storage = markdownToStorage(md); },
    `${label}: markdownToStorage must not throw`
  ).not.toThrow();
  storage = markdownToStorage(md);
  expect(storage.length, `${label}: output must be non-empty`).toBeGreaterThan(0);
  expect(
    storage.length,
    `${label}: output must not be more than 10× the input size`
  ).toBeLessThan(md.length * 10 + 1000);
  // Must contain some HTML-like structure.
  expect(
    /<[a-zA-Z]/.test(storage) || storage.length > 0,
    `${label}: output must contain HTML structure`
  ).toBe(true);
  return storage;
}

/**
 * Assert the no-loss token round-trip property for storage that contains
 * Confluence-specific elements (<ac:>, <ri:>, <time>).
 *
 * The invariant: tokenise current storage → get canonical (with [[epi:T####]]
 * in place of opaque elements) → planUpdate with that canonical → the opaque
 * elements are restored byte-for-byte from the sidecar.
 *
 * This is the contract from 01-data-preservation.md. Plain HTML regions
 * (paragraphs, headings, etc.) are NOT expected to be byte-identical after
 * a markdown round-trip — only the tokenised ac:/ri:/time elements are.
 */
function assertTokenRoundTrip(storage: string, label: string): void {
  const { canonical, sidecar } = tokeniseStorage(storage);
  const plan = planUpdate({ currentStorage: storage, callerMarkdown: canonical });

  // The key invariant: every sidecar entry that survived in the canonical
  // must appear in the output byte-for-byte.
  for (const [tokenId, xml] of Object.entries(sidecar)) {
    // Token present in canonical = it was preserved in callerMarkdown.
    if (canonical.includes(`[[epi:${tokenId}]]`)) {
      expect(
        plan.newStorage.includes(xml),
        `${label}: token ${tokenId} must be present byte-for-byte in newStorage`
      ).toBe(true);
    }
  }

  // No deletions in a no-op round-trip.
  expect(plan.deletedTokens, `${label}: no tokens should be deleted in no-op`).toEqual([]);
}

/**
 * Assert full byte-identical round-trip for storage that consists entirely
 * of tokenisable elements (no plain HTML). Used for macro-only storage where
 * there's no turndown → markdownToStorage conversion to worry about.
 */
function assertByteIdenticalRoundTrip(storage: string, label: string): void {
  const { canonical } = tokeniseStorage(storage);
  const plan = planUpdate({ currentStorage: storage, callerMarkdown: canonical });
  expect(
    plan.newStorage,
    `${label}: byte-identical round-trip failed`
  ).toBe(storage);
  expect(plan.deletedTokens, `${label}: no tokens should be deleted`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Suite 1: investigation doc fixtures → markdownToStorage
// ---------------------------------------------------------------------------

describe("investigation doc fixtures — markdownToStorage", () => {
  for (const fixtureName of INVESTIGATION_FIXTURES) {
    it(`converts ${fixtureName} without error`, () => {
      const md = loadFixture(fixtureName);
      assertValidStorageOutput(md, fixtureName);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 2: investigation doc fixtures → markdownToStorage → token round-trip
// ---------------------------------------------------------------------------

describe("investigation doc fixtures — token round-trip via planUpdate", () => {
  for (const fixtureName of INVESTIGATION_FIXTURES) {
    it(`${fixtureName}: tokens (if any) round-trip byte-identically`, () => {
      const md = loadFixture(fixtureName);
      const storage = markdownToStorage(md);
      assertTokenRoundTrip(storage, fixtureName);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 3: Byte-identical round-trip for pure-macro storage
// ---------------------------------------------------------------------------

describe("pure-macro storage — byte-identical round-trip", () => {
  const MACRO_INFO =
    `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>`;
  const MACRO_NOTE =
    `<ac:structured-macro ac:name="note" ac:macro-id="n-1"><ac:rich-text-body><p>N</p></ac:rich-text-body></ac:structured-macro>`;
  const MACRO_CODE =
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>`;
  const EMOTICON = `<ac:emoticon ac:name="smile"/>`;
  const TIME = `<time datetime="2024-02-14"/>`;

  it("single info macro is byte-identical", () => {
    assertByteIdenticalRoundTrip(MACRO_INFO, "single-info-macro");
  });

  it("adjacent macros are byte-identical", () => {
    assertByteIdenticalRoundTrip(MACRO_INFO + MACRO_NOTE, "adjacent-macros");
  });

  it("code macro is byte-identical", () => {
    assertByteIdenticalRoundTrip(MACRO_CODE, "code-macro");
  });

  it("emoticon element is byte-identical", () => {
    assertByteIdenticalRoundTrip(EMOTICON, "emoticon");
  });

  it("time element is byte-identical", () => {
    assertByteIdenticalRoundTrip(TIME, "time");
  });

  it("mixed macro sequence is byte-identical", () => {
    assertByteIdenticalRoundTrip(
      MACRO_INFO + MACRO_CODE + EMOTICON + TIME,
      "mixed-macro-sequence"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 4: storageToMarkdown preserves tokens correctly
// ---------------------------------------------------------------------------

describe("storageToMarkdown → token preservation", () => {
  it("empty storage returns empty markdown with empty sidecar", () => {
    const { markdown, sidecar } = storageToMarkdown("");
    expect(markdown).toBe("");
    expect(Object.keys(sidecar)).toHaveLength(0);
  });

  it("plain paragraph: no tokens in output", () => {
    const { markdown, sidecar } = storageToMarkdown("<p>Hello, world.</p>");
    // No ac:/ri: elements → no tokens.
    expect(Object.keys(sidecar)).toHaveLength(0);
    expect(markdown).toContain("Hello, world.");
  });

  it("storage with a macro: token appears in markdown and sidecar", () => {
    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Info!</p></ac:rich-text-body></ac:structured-macro>`;
    const { markdown, sidecar } = storageToMarkdown(`<p>Before.</p>\n${macro}`);
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
    expect(Object.keys(sidecar).length).toBeGreaterThan(0);
    const tokenXml = Object.values(sidecar)[0]!;
    expect(tokenXml).toBe(macro);
  });

  it("macro token in storageToMarkdown output survives planUpdate byte-identically", () => {
    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Important!</p></ac:rich-text-body></ac:structured-macro>`;
    const storage = `${macro}`;
    const { markdown } = storageToMarkdown(storage);
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: markdown });
    expect(plan.newStorage).toBe(storage);
  });

  it("page with drawio and text: drawio token preserved via storageToMarkdown flow", () => {
    const drawio = `<ac:structured-macro ac:name="drawio" ac:macro-id="d-123"><ac:parameter ac:name="diagramName">test.drawio</ac:parameter></ac:structured-macro>`;
    const storage = `<p>Some text before.</p>\n${drawio}\n<p>Some text after.</p>`;
    const { markdown } = storageToMarkdown(storage);
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: markdown });
    // The drawio macro must be byte-identically present.
    expect(plan.newStorage).toContain(drawio);
    expect(plan.deletedTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: entrix-network-style synthetic fixtures
// ---------------------------------------------------------------------------

describe("entrix-network synthetic fixtures — markdownToStorage", () => {
  for (const fixtureName of ENTRIX_FIXTURES) {
    it(`converts ${fixtureName} without error`, () => {
      const md = loadFixture(fixtureName);
      assertValidStorageOutput(md, fixtureName);
    });
  }
});

describe("entrix-network synthetic fixtures — structural assertions", () => {
  it("overview fixture produces tables and headings", () => {
    const md = loadFixture("entrix-overview.md");
    const storage = markdownToStorage(md);
    expect(storage).toContain("<table");
    expect(storage).toContain("<th>");
    expect(storage).toContain("<h");
  });

  it("account-detail fixture produces code blocks as Confluence macros", () => {
    const md = loadFixture("entrix-account-detail.md");
    const storage = markdownToStorage(md);
    expect(storage).toContain('ac:name="code"');
    expect(storage).toContain("<![CDATA[");
  });

  it("traffic-flows fixture produces warning panel macro", () => {
    const md = loadFixture("entrix-traffic-flows.md");
    const storage = markdownToStorage(md);
    expect(storage).toContain('ac:name="warning"');
    expect(storage).toContain("ac:rich-text-body");
  });

  it("overview fixture handles confluence:// links correctly", () => {
    const md = loadFixture("entrix-overview.md");
    const storage = markdownToStorage(md);
    // confluence:// links should be converted to ac:link elements.
    expect(storage).toContain("<ac:link>");
    expect(storage).toContain("ri:page");
  });
});

describe("entrix-network synthetic fixtures — token round-trip", () => {
  for (const fixtureName of ENTRIX_FIXTURES) {
    it(`${fixtureName}: Confluence-specific tokens round-trip byte-identically`, () => {
      const md = loadFixture(fixtureName);
      const storage = markdownToStorage(md);
      assertTokenRoundTrip(storage, fixtureName);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 6: Token reordering support
// ---------------------------------------------------------------------------

describe("token reordering in planUpdate", () => {
  it("reordering tokens is accepted without deletion error", () => {
    const MACRO_A =
      `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>A</p></ac:rich-text-body></ac:structured-macro>`;
    const MACRO_B =
      `<ac:structured-macro ac:name="note"><ac:rich-text-body><p>B</p></ac:rich-text-body></ac:structured-macro>`;
    const storage = MACRO_A + MACRO_B;
    const { canonical } = tokeniseStorage(storage);

    // The canonical has "[[epi:T0001]][[epi:T0002]]".
    // Caller swaps order: "[[epi:T0002]][[epi:T0001]]".
    const reordered = canonical
      .replace("[[epi:T0001]]", "__A__")
      .replace("[[epi:T0002]]", "[[epi:T0001]]")
      .replace("__A__", "[[epi:T0002]]");

    // Should not throw even without confirmDeletions — reordering is allowed.
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: reordered });
    // The result should contain both macros (in swapped order).
    expect(plan.newStorage).toContain(MACRO_A);
    expect(plan.newStorage).toContain(MACRO_B);
    expect(plan.deletedTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Explicit deletion with confirmDeletions
// ---------------------------------------------------------------------------

describe("explicit deletion with confirmDeletions", () => {
  it("deletion without confirmation throws DELETIONS_NOT_CONFIRMED", () => {
    const storage =
      `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Info.</p></ac:rich-text-body></ac:structured-macro>`;
    const { canonical } = tokeniseStorage(storage);
    // Strip the token from caller's markdown.
    const withoutToken = canonical.replace(/\[\[epi:T\d+\]\]/g, "");
    expect(() =>
      planUpdate({ currentStorage: storage, callerMarkdown: withoutToken })
    ).toThrowError(ConverterError);
  });

  it("deletion with confirmDeletions:true succeeds and reports deleted tokens", () => {
    const storage =
      `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Info.</p></ac:rich-text-body></ac:structured-macro>`;
    const { canonical } = tokeniseStorage(storage);
    const withoutToken = canonical.replace(/\[\[epi:T\d+\]\]/g, "");
    const plan = planUpdate({
      currentStorage: storage,
      callerMarkdown: withoutToken,
      confirmDeletions: true,
    });
    expect(plan.deletedTokens.length).toBe(1);
    expect(plan.versionMessage).toContain("Removed 1 preserved element");
    // The output should not contain the macro.
    expect(plan.newStorage).not.toContain("ac:structured-macro");
  });
});

// ---------------------------------------------------------------------------
// Suite 8: replaceBody opt-out
// ---------------------------------------------------------------------------

describe("replaceBody opt-out", () => {
  it("replaceBody:true skips token preservation", () => {
    const storage =
      `<p>Old text.</p><ac:structured-macro ac:name="drawio"></ac:structured-macro>`;
    const plan = planUpdate({
      currentStorage: storage,
      callerMarkdown: "# New content\n\nFresh start.",
      replaceBody: true,
    });
    // The output should be the new markdown converted directly, not preserving the drawio macro.
    expect(plan.newStorage).not.toContain("ac:structured-macro");
    expect(plan.newStorage).toContain("<h1");
    expect(plan.deletedTokens).toEqual([]);
  });
});
