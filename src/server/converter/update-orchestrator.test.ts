/**
 * Tests for the Stream 4 token-aware write path orchestrator.
 *
 * These tests cover the data-preservation invariant end-to-end through
 * the `planUpdate` function: tokenise current storage, diff, enforce
 * the `invented` / `deleted` gates, convert caller markdown, unwrap
 * markdown-it's paragraph-wrappers, restore tokens. The property test
 * at the bottom asserts byte-identity across 100+ randomised samples.
 */
import { describe, expect, it } from "vitest";
import { planUpdate } from "./update-orchestrator.js";
import { tokeniseStorage } from "./tokeniser.js";
import { ConverterError } from "./types.js";

// ---------------------------------------------------------------------------
// Shared fixtures — concrete Confluence storage elements used throughout.
// ---------------------------------------------------------------------------

const MACRO_INFO =
  `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>`;
const MACRO_NOTE =
  `<ac:structured-macro ac:name="note" ac:macro-id="n-1"><ac:rich-text-body><p>N</p></ac:rich-text-body></ac:structured-macro>`;
const MACRO_CODE =
  `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>`;
const EMOTICON = `<ac:emoticon ac:name="smile"/>`;
const TIME = `<time datetime="2024-02-14"/>`;

// ---------------------------------------------------------------------------
// Round-trip no-op (the mandatory acceptance criterion)
// ---------------------------------------------------------------------------

describe("planUpdate — no-op round-trip (acceptance criterion)", () => {
  it("single macro: currentStorage === newStorage byte-for-byte", () => {
    const S = MACRO_INFO;
    const { canonical } = tokeniseStorage(S);
    const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(S);
    expect(plan.deletedTokens).toEqual([]);
    expect(plan.versionMessage).toBeUndefined();
  });

  it("adjacent macros: preserves byte-identity and attribute ordering", () => {
    const S = MACRO_INFO + MACRO_NOTE + MACRO_CODE;
    const { canonical } = tokeniseStorage(S);
    const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(S);
  });

  it("inline tokens (emoticon) standalone round-trip losslessly", () => {
    const S = EMOTICON;
    const { canonical } = tokeniseStorage(S);
    const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(S);
  });

  it("time element round-trips losslessly", () => {
    const S = TIME;
    const { canonical } = tokeniseStorage(S);
    const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(S);
  });

  it("CDATA bodies (literal `]]>`) survive the round-trip", () => {
    const S = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x ]]]]><![CDATA[> y]]></ac:plain-text-body></ac:structured-macro>`;
    const { canonical } = tokeniseStorage(S);
    const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(S);
  });
});

// ---------------------------------------------------------------------------
// Adding content — new paragraphs alongside preserved macros
// ---------------------------------------------------------------------------

describe("planUpdate — add content, preserve macros", () => {
  it("caller appends a paragraph: existing macro restored, new paragraph present", () => {
    const S = MACRO_INFO;
    const { canonical } = tokeniseStorage(S);
    // Caller keeps the token and adds a new markdown paragraph below.
    const callerMd = `${canonical}\n\nA brand-new paragraph.`;
    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    // The macro must appear byte-for-byte (no re-derivation).
    expect(plan.newStorage).toContain(MACRO_INFO);
    // The new paragraph must be present as a proper <p>.
    expect(plan.newStorage).toContain("<p>A brand-new paragraph.</p>");
    expect(plan.deletedTokens).toEqual([]);
    expect(plan.versionMessage).toBeUndefined();
  });

  it("caller prepends a heading: preserved macro still present unchanged", () => {
    const S = MACRO_NOTE;
    const { canonical } = tokeniseStorage(S);
    const callerMd = `# New Heading\n\n${canonical}`;
    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    expect(plan.newStorage).toContain('<h1 id="new-heading">New Heading</h1>');
    expect(plan.newStorage).toContain(MACRO_NOTE);
  });
});

// ---------------------------------------------------------------------------
// Explicit deletion gate
// ---------------------------------------------------------------------------

describe("planUpdate — explicit deletion with confirmDeletions", () => {
  it("removes a token from canonical with confirmDeletions=true → macro gone", () => {
    const S = MACRO_INFO + MACRO_NOTE;
    const { canonical } = tokeniseStorage(S);
    // canonical === "[[epi:T0001]][[epi:T0002]]"; caller keeps only T0001.
    const callerMd = `[[epi:T0001]]`;
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: callerMd,
      confirmDeletions: true,
    });
    // MACRO_INFO restored byte-for-byte; MACRO_NOTE absent.
    expect(plan.newStorage).toContain(MACRO_INFO);
    expect(plan.newStorage).not.toContain(`ac:name="note"`);
    expect(plan.deletedTokens).toEqual(["T0002"]);
    expect(plan.versionMessage).toBeDefined();
    // Version message lists the deleted ID and tag name (never content).
    expect(plan.versionMessage).toContain("T0002");
    expect(plan.versionMessage).toContain("ac:structured-macro");
    expect(plan.versionMessage).toContain(`ac:name="note"`);
  });

  it("version message pluralises correctly for multiple deletions", () => {
    const S = MACRO_INFO + MACRO_NOTE;
    const { canonical } = tokeniseStorage(S);
    void canonical;
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: "",
      confirmDeletions: true,
    });
    expect(plan.deletedTokens).toEqual(["T0001", "T0002"]);
    expect(plan.versionMessage).toMatch(/Removed 2 preserved elements:/);
  });

  it("version message uses singular form for one deletion", () => {
    const S = MACRO_INFO;
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: "",
      confirmDeletions: true,
    });
    expect(plan.versionMessage).toMatch(/Removed 1 preserved element:/);
  });
});

// ---------------------------------------------------------------------------
// Implicit deletion is rejected
// ---------------------------------------------------------------------------

describe("planUpdate — implicit deletion rejected", () => {
  it("throws DELETIONS_NOT_CONFIRMED when a token is dropped without confirmation", () => {
    const S = MACRO_INFO;
    const callerMd = ``; // caller dropped the only token
    try {
      planUpdate({ currentStorage: S, callerMarkdown: callerMd });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConverterError);
      const e = err as ConverterError;
      expect(e.code).toBe("DELETIONS_NOT_CONFIRMED");
      // Error surfaces the tag name (helpful for the caller) but NEVER
      // the sidecar content — 06-security.md §11.
      expect(e.message).toContain("T0001");
      expect(e.message).toContain("ac:structured-macro");
      // The sidecar entry's inner body (`<p>I</p>`) must not leak.
      expect(e.message).not.toContain("<p>I</p>");
      expect(e.message).not.toContain("rich-text-body");
      expect(e.message).toContain("confirm_deletions");
    }
  });

  it("explicit confirmDeletions: false also rejects", () => {
    const S = MACRO_NOTE;
    expect(() =>
      planUpdate({ currentStorage: S, callerMarkdown: "", confirmDeletions: false })
    ).toThrow(ConverterError);
  });

  it("emoticon deletion surfaces ac:emoticon (no ac:name attr to report)", () => {
    const S = EMOTICON;
    try {
      planUpdate({ currentStorage: S, callerMarkdown: "" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ConverterError).message).toContain("ac:emoticon");
      // No ac:name="…" attribute for bare emoticon — tag name only.
    }
  });

  it("singular error message for a single deletion uses 'element' not 'elements'", () => {
    const S = MACRO_INFO;
    try {
      planUpdate({ currentStorage: S, callerMarkdown: "" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ConverterError).message).toMatch(/1 preserved element:/);
      expect((err as ConverterError).message).not.toMatch(/elements:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Invented tokens
// ---------------------------------------------------------------------------

describe("planUpdate — invented tokens rejected", () => {
  it("throws INVENTED_TOKEN when caller introduces a token not in the sidecar", () => {
    const S = MACRO_INFO;
    const callerMd = `[[epi:T0001]] [[epi:T9999]]`;
    try {
      planUpdate({ currentStorage: S, callerMarkdown: callerMd });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConverterError);
      const e = err as ConverterError;
      expect(e.code).toBe("INVENTED_TOKEN");
      expect(e.message).toContain("T9999");
      // Message must not reveal T0001's content either (defence in depth).
      expect(e.message).not.toContain("rich-text-body");
    }
  });

  it("invention is checked BEFORE deletion (invention is a harder error)", () => {
    // Caller drops T0001 (would trigger DELETIONS_NOT_CONFIRMED) AND
    // invents T9999 — the invention error must win.
    const S = MACRO_INFO;
    try {
      planUpdate({ currentStorage: S, callerMarkdown: `[[epi:T9999]]` });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ConverterError).code).toBe("INVENTED_TOKEN");
    }
  });
});

// ---------------------------------------------------------------------------
// replaceBody opts out of preservation
// ---------------------------------------------------------------------------

describe("planUpdate — replaceBody opt-out", () => {
  it("replaceBody=true skips preservation entirely", () => {
    const S = MACRO_INFO + MACRO_NOTE; // page full of preserved macros
    const callerMd = `# Fresh start\n\nBrand new page.`;
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: callerMd,
      replaceBody: true,
    });
    // No tokens, no macros carried over.
    expect(plan.newStorage).toContain('<h1 id="fresh-start">Fresh start</h1>');
    expect(plan.newStorage).toContain("<p>Brand new page.</p>");
    expect(plan.newStorage).not.toContain("ac:structured-macro");
    // deletedTokens is empty even when preserved elements were dropped —
    // the caller explicitly opted out of preservation.
    expect(plan.deletedTokens).toEqual([]);
    expect(plan.versionMessage).toBeUndefined();
  });

  it("replaceBody=true does not tokenise currentStorage (no invention check)", () => {
    // A caller using replaceBody wouldn't normally include token
    // literals, but if they did, they pass through as text.
    const S = MACRO_INFO;
    const callerMd = `[[epi:T9999]]`;
    // Would throw INVENTED_TOKEN without replaceBody; shouldn't throw with.
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: callerMd,
      replaceBody: true,
    });
    // The token literal survives as text — markdownToStorage doesn't
    // know about tokens.
    expect(plan.newStorage).toContain("[[epi:T9999]]");
  });
});

// ---------------------------------------------------------------------------
// Channel 4 passthrough — caller adds a raw allowlisted macro
// ---------------------------------------------------------------------------

describe("planUpdate — new content via Channel 4 passthrough", () => {
  it("caller adds a new ac:structured-macro that passes through unchanged", () => {
    const S = MACRO_INFO;
    const { canonical } = tokeniseStorage(S);
    const newMacro =
      `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>new</p></ac:rich-text-body></ac:structured-macro>`;
    const callerMd = `${canonical}\n\n${newMacro}`;
    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    // The preserved macro appears byte-for-byte.
    expect(plan.newStorage).toContain(MACRO_INFO);
    // The newly-authored macro is also in the output.
    expect(plan.newStorage).toContain(`<p>new</p>`);
  });
});

// ---------------------------------------------------------------------------
// Token reordering
// ---------------------------------------------------------------------------

describe("planUpdate — token reordering preserves content", () => {
  it("caller swaps two tokens' positions → macros end up at their new positions byte-for-byte", () => {
    const S = MACRO_INFO + MACRO_NOTE;
    const { canonical } = tokeniseStorage(S);
    // canonical = "[[epi:T0001]][[epi:T0002]]"
    expect(canonical).toBe("[[epi:T0001]][[epi:T0002]]");
    const callerMd = `[[epi:T0002]][[epi:T0001]]`;
    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    // Note comes first in the new storage, info second.
    expect(plan.newStorage).toBe(MACRO_NOTE + MACRO_INFO);
    expect(plan.deletedTokens).toEqual([]);
    // Reordering does not trigger a version message (silent per design).
    expect(plan.versionMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ConverterOptions plumbing
// ---------------------------------------------------------------------------

describe("planUpdate — converterOptions forwarded", () => {
  it("confluenceBaseUrl is passed through to markdownToStorage", () => {
    // Use replaceBody to isolate the markdownToStorage call path.
    const callerMd = `[click](https://example.atlassian.net/wiki/spaces/FOO/pages/12345/Title)`;
    const plan = planUpdate({
      currentStorage: "",
      callerMarkdown: callerMd,
      replaceBody: true,
      converterOptions: { confluenceBaseUrl: "https://example.atlassian.net" },
    });
    // Rewritten to an ac:link with the content-id.
    expect(plan.newStorage).toContain(`<ac:link>`);
    expect(plan.newStorage).toContain(`ri:content-id="12345"`);
  });
});

// ---------------------------------------------------------------------------
// Property test: 100+ random no-op round-trips are byte-identical.
// ---------------------------------------------------------------------------

describe("planUpdate — round-trip property test", () => {
  /**
   * Pool of macro fixtures. These are the only building blocks — we
   * specifically avoid interleaving raw HTML fragments because the
   * Stream 4 round-trip is only byte-identical when the caller's
   * markdown (here, the canonical) survives `markdownToStorage`'s
   * `html: false` escaping. Stream 6 (storage→markdown) will produce
   * proper markdown from arbitrary storage; for Stream 4's standalone
   * test we use the achievable shape.
   */
  const MACROS: string[] = [
    MACRO_INFO,
    MACRO_NOTE,
    MACRO_CODE,
    EMOTICON,
    TIME,
    `<ri:user ri:account-id="abc123"/>`,
    `<ac:structured-macro ac:name="panel" ac:macro-id="p-1"><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>`,
    `<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>L</p></ac:layout-cell><ac:layout-cell><p>R</p></ac:layout-cell></ac:layout-section></ac:layout>`,
    `<ac:image ac:align="center"><ri:attachment ri:filename="pic.png"/></ac:image>`,
  ];

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
    const count = 1 + Math.floor(r() * 8);
    const pieces: string[] = [];
    for (let i = 0; i < count; i++) pieces.push(pick(MACROS, r));
    return pieces.join("");
  }

  it("200 random macro-only storages round-trip byte-for-byte", () => {
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = rng(i + 1);
      const S = buildRandomStorage(r);
      const { canonical } = tokeniseStorage(S);
      const plan = planUpdate({ currentStorage: S, callerMarkdown: canonical });
      if (plan.newStorage !== S) {
        throw new Error(
          `round-trip mismatch on iteration ${i}: ` +
            `S=${JSON.stringify(S)} out=${JSON.stringify(plan.newStorage)}`
        );
      }
    }
  });
});
