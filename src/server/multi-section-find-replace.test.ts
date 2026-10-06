/**
 * W-MULTI (R3, M10): safePrepareMultiSectionBody with find_replace entries,
 * the aggregate content-safety guard and section-qualified token ids.
 * Pure function; the HTTP layer is mocked out and never reached.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://docs.example.com";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    getPage: vi.fn(),
    getPageByTitle: vi.fn(),
    _rawCreatePage: vi.fn(),
    _rawUpdatePage: vi.fn(),
  };
});

import {
  MultiSectionError,
  qualifyTokenId,
  safePrepareMultiSectionBody,
} from "./safe-write.js";
import { SHRINKAGE_NOT_CONFIRMED } from "./converter/types.js";

const EMOTICON = '<ac:emoticon ac:name="smile"/>';

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Five sections of ~20% of the page each; " DROPn:…" is ~70% of a section. */
const FILLER = "lorem ipsum ".repeat(22);
function fiveSectionPage(): string {
  return [1, 2, 3, 4, 5]
    .map((i) => `<h2>S${i}</h2><p>KEEP${i} ${"keep text ".repeat(9)} DROP${i}:${FILLER}</p>`)
    .join("");
}

describe("find_replace entries (R3)", () => {
  it("mixes body and find_replace entries into one merged document", async () => {
    const source =
      "<h2>A</h2><p>old A</p>" +
      "<h2>B</h2><p>alpha beta</p>" +
      "<h2>C</h2><p>keep C</p>";
    const out = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: [
        { section: "A", body: "<p>new A</p>" },
        { section: "B", find_replace: [{ find: "beta", replace: "gamma" }] },
      ],
    });
    expect(out.finalStorage).toBe(
      "<h2>A</h2><p>new A</p><h2>B</h2><p>alpha gamma</p><h2>C</h2><p>keep C</p>",
    );
    expect(out.perSectionResults.map((r) => r.section)).toEqual(["A", "B"]);
    expect(out.perSectionResults[1].perPair).toEqual([{ matched: "exact", count: 1 }]);
  });

  it("rejects an entry with both body and find_replace, or neither", async () => {
    const err = await thrown(
      safePrepareMultiSectionBody({
        currentStorage: "<h2>A</h2><p>a</p><h2>B</h2><p>b</p>",
        sections: [
          { section: "A", body: "<p>x</p>", find_replace: [{ find: "a", replace: "b" }] },
          { section: "B" },
        ],
      }),
    );
    expect(err).toBeInstanceOf(MultiSectionError);
    const failures = (err as MultiSectionError).failures;
    expect(failures.map((f) => [f.section, f.reason])).toEqual([
      ["A", "invalid"],
      ["B", "invalid"],
    ]);
  });

  it("a failing find_replace entry rejects the whole call", async () => {
    const err = await thrown(
      safePrepareMultiSectionBody({
        currentStorage: "<h2>A</h2><p>a a</p><h2>B</h2><p>b</p>",
        sections: [
          { section: "B", body: "<p>fine</p>" },
          { section: "A", find_replace: [{ find: "a", replace: "z" }] },
        ],
      }),
    );
    expect(err).toBeInstanceOf(MultiSectionError);
    const failures = (err as MultiSectionError).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ section: "A", reason: "prepare" });
    expect(failures[0].message).toContain("FIND_REPLACE_AMBIGUOUS");
  });
});

describe("aggregate guard (M10)", () => {
  it("five find_replace entries each removing ~15% trip the aggregate shrinkage guard", async () => {
    const page = fiveSectionPage();
    const sections = [1, 2, 3, 4, 5].map((i) => ({
      section: `S${i}`,
      find_replace: [{ find: ` DROP${i}:${FILLER}`, replace: "" }],
    }));
    const err = await thrown(safePrepareMultiSectionBody({ currentStorage: page, sections }));
    expect((err as { code?: string }).code).toBe(SHRINKAGE_NOT_CONFIRMED);
    expect((err as Error).message).toContain("Across all 5 sections combined");

    // One section alone is a small page-relative change and passes.
    await expect(
      safePrepareMultiSectionBody({ currentStorage: page, sections: sections.slice(0, 1) }),
    ).resolves.toBeDefined();
    // The flag acknowledges the aggregate.
    await expect(
      safePrepareMultiSectionBody({ currentStorage: page, sections, confirmShrinkage: true }),
    ).resolves.toBeDefined();
  });

  it("also catches body-only calls", async () => {
    const page = fiveSectionPage();
    const sections = [1, 2, 3, 4, 5].map((i) => ({ section: `S${i}`, body: `<p>KEEP${i}</p>` }));
    const err = await thrown(safePrepareMultiSectionBody({ currentStorage: page, sections }));
    expect((err as { code?: string }).code).toBe(SHRINKAGE_NOT_CONFIRMED);
  });
});

describe("section-qualified token ids", () => {
  const source =
    `<h2>A</h2><p>a ${EMOTICON} a2</p>` +
    `<h2>B</h2><p>b ${EMOTICON} b2</p>`;
  const dropBoth = [
    { section: "A", find_replace: [{ find: "a [[epi:T0001]] a2", replace: "a a2" }] },
    { section: "B", find_replace: [{ find: "b [[epi:T0001]] b2", replace: "b b2" }] },
  ];

  it("qualifies aggregated deletions by section (T0001 repeats per section)", async () => {
    const out = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: dropBoth,
      confirmDeletions: true,
    });
    expect(out.aggregatedDeletedTokens.map((t) => t.id)).toEqual(["A#T0001", "B#T0001"]);
    expect(qualifyTokenId("A", "T0001")).toBe("A#T0001");
    expect(out.finalStorage).toBe("<h2>A</h2><p>a a2</p><h2>B</h2><p>b b2</p>");
  });

  it("accepts section-qualified itemised acks", async () => {
    const out = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: dropBoth,
      confirmDeletions: ["A#T0001", "B#T0001"],
    });
    expect(out.aggregatedDeletedTokens).toHaveLength(2);
  });

  it("an itemised ack for one section does not cover the other", async () => {
    const err = await thrown(
      safePrepareMultiSectionBody({
        currentStorage: source,
        sections: dropBoth,
        confirmDeletions: ["A#T0001"],
      }),
    );
    expect(err).toBeInstanceOf(MultiSectionError);
    const failures = (err as MultiSectionError).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0].section).toBe("B");
    expect(failures[0].message).toContain("would delete 1 preserved element");
  });

  it("rejects an ack naming a section that is not in the call", async () => {
    const err = await thrown(
      safePrepareMultiSectionBody({
        currentStorage: source,
        sections: dropBoth,
        confirmDeletions: ["A#T0001", "B#T0001", "Z#T0001"],
      }),
    );
    expect(err).toBeInstanceOf(MultiSectionError);
    expect((err as MultiSectionError).failures[0]).toMatchObject({ reason: "invalid" });
  });
});
