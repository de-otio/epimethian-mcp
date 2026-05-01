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
    // versionMessage reports the wholesale rewrite so audits can see what was dropped.
    expect(plan.versionMessage).toContain("Wholesale rewrite");
    expect(plan.versionMessage).toContain("dropped");
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
// C1: Stable ac:macro-id for unchanged code-block bodies
//
// When a caller re-emits a fenced code block whose body text is unchanged,
// `markdownToStorage` generates a fresh `ac:macro-id` UUID, which the
// tokeniser then sees as "old macro deleted, new macro inserted". Before
// C1 that forced `confirm_deletions: true` for what is semantically a
// no-op. After C1, `planUpdate` rescues the code macro by swapping the
// new-UUID XML for the old sidecar XML when the normalised body matches.
//
// Scope: code macros only. Deletions of non-code macros (drawio, panel,
// info, etc.) still require confirmation.
// ---------------------------------------------------------------------------

describe("planUpdate — C1: stable code-macro IDs", () => {
  // A code macro that mirrors Confluence's on-wire shape (with macro-id).
  const CODE_WITH_ID = (id: string, body: string) =>
    `<ac:structured-macro ac:name="code" ac:macro-id="${id}"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;

  it("re-emitting a code block with an unchanged body reuses the old ac:macro-id and does not report a deletion", () => {
    const oldId = "old-uuid-1111";
    const body = "const x = 1;";
    const S = `<p>Intro</p>${CODE_WITH_ID(oldId, body)}<p>Outro</p>`;

    // Caller writes markdown that includes a fenced code block with the
    // same body — no token reference, just fresh markdown. Without C1
    // this would throw DELETIONS_NOT_CONFIRMED.
    const callerMd = "Intro\n\n```ts\nconst x = 1;\n```\n\nOutro";

    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });

    // The original ac:macro-id survives — this is the whole point.
    expect(plan.newStorage).toContain(`ac:macro-id="${oldId}"`);
    // No freshly-minted UUID for the code macro.
    const macroIds = [...plan.newStorage.matchAll(/ac:macro-id="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(macroIds).toEqual([oldId]);
    // The deletion gate was not triggered and nothing is reported deleted.
    expect(plan.deletedTokens).toEqual([]);
    expect(plan.versionMessage).toBeUndefined();
    // The body text is still there.
    expect(plan.newStorage).toContain("const x = 1;");
  });

  it("re-emitting a code block with the SAME body but different surrounding whitespace still matches (leading/trailing trim)", () => {
    const oldId = "old-uuid-2222";
    // Sidecar body has no leading/trailing whitespace.
    const S = CODE_WITH_ID(oldId, "return 42;");
    // Caller's markdown fence has trailing newline in the body (markdown-it
    // always includes a trailing newline from the fence close).
    const callerMd = "```ts\nreturn 42;\n```";

    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });

    expect(plan.newStorage).toContain(`ac:macro-id="${oldId}"`);
    expect(plan.deletedTokens).toEqual([]);
  });

  it("a CHANGED code body is still reported as a deletion (scope guard: behaviour must not regress for genuine edits)", () => {
    const oldId = "old-uuid-3333";
    const S = CODE_WITH_ID(oldId, "const x = 1;");
    // Caller changes the body — the new macro does not match the old sidecar entry.
    const callerMd = "```ts\nconst x = 999;\n```";

    // Without confirm_deletions this must still throw — C1 is narrow to
    // "body unchanged", not "any code block".
    expect(() =>
      planUpdate({ currentStorage: S, callerMarkdown: callerMd })
    ).toThrow(ConverterError);

    // And the thrown error references the original code token.
    try {
      planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    } catch (err) {
      expect((err as ConverterError).code).toBe("DELETIONS_NOT_CONFIRMED");
      expect((err as ConverterError).message).toContain("T0001");
      expect((err as ConverterError).message).toContain(`ac:name="code"`);
    }
  });

  it("a code body that differs by one character does not match (case-sensitive, internal whitespace preserved)", () => {
    const oldId = "old-uuid-casecheck";
    // Internal spacing matters: two spaces inside "=  1".
    const S = CODE_WITH_ID(oldId, "const x =  1;");
    const callerMd = "```ts\nconst x = 1;\n```"; // single space
    expect(() =>
      planUpdate({ currentStorage: S, callerMarkdown: callerMd })
    ).toThrow(/DELETIONS_NOT_CONFIRMED|deletions/i);
  });

  it("narrow scope: a non-code macro deletion (drawio) is still reported even when a code body is unchanged", () => {
    const oldCodeId = "old-code-uuid";
    const DRAWIO_MACRO =
      `<ac:structured-macro ac:name="drawio" ac:macro-id="drawio-uuid"><ac:parameter ac:name="diagramName">arch</ac:parameter></ac:structured-macro>`;
    const CODE = CODE_WITH_ID(oldCodeId, "const x = 1;");
    const S = CODE + DRAWIO_MACRO;

    // Caller re-emits the code block (same body) but drops the drawio
    // entirely. The code rescue fires; the drawio is still a deletion.
    const callerMd = "```ts\nconst x = 1;\n```";

    // Without confirm_deletions: must still throw for the drawio.
    try {
      planUpdate({ currentStorage: S, callerMarkdown: callerMd });
      throw new Error("expected DELETIONS_NOT_CONFIRMED");
    } catch (err) {
      expect(err).toBeInstanceOf(ConverterError);
      const e = err as ConverterError;
      expect(e.code).toBe("DELETIONS_NOT_CONFIRMED");
      // The error must name the drawio deletion, NOT the code one
      // (the code macro was rescued and is no longer deleted).
      expect(e.message).toContain(`ac:name="drawio"`);
      expect(e.message).not.toContain(`ac:name="code"`);
      // Exactly one deletion reported (drawio), not two.
      expect(e.message).toMatch(/1 preserved element/);
    }
  });

  it("a code-body match plus an unrelated drawio deletion: the drawio is still rescued by confirm_deletions, but the code is not listed in the version message", () => {
    const oldCodeId = "old-code-uuid";
    const DRAWIO_MACRO =
      `<ac:structured-macro ac:name="drawio" ac:macro-id="drawio-uuid"><ac:parameter ac:name="diagramName">arch</ac:parameter></ac:structured-macro>`;
    const CODE = CODE_WITH_ID(oldCodeId, "const x = 1;");
    const S = CODE + DRAWIO_MACRO;
    const callerMd = "```ts\nconst x = 1;\n```";

    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: callerMd,
      confirmDeletions: true,
    });

    // Only the drawio token ID appears in deletedTokens — the code one was rescued.
    expect(plan.deletedTokens.length).toBe(1);
    // The rescued code macro retains its old ac:macro-id in the output.
    expect(plan.newStorage).toContain(`ac:macro-id="${oldCodeId}"`);
    // The drawio is genuinely gone from the output.
    expect(plan.newStorage).not.toContain(`ac:name="drawio"`);
    // The version message names the drawio, not the code.
    expect(plan.versionMessage).toContain(`ac:name="drawio"`);
    expect(plan.versionMessage).not.toContain(`ac:name="code"`);
  });

  it("re-emitting a code block at a new position keeps the old ac:macro-id (position doesn't affect match)", () => {
    const oldId = "old-uuid-4444";
    const S = `<p>A</p>${CODE_WITH_ID(oldId, "return 1;")}<p>B</p>`;
    // Caller moves the code to the bottom.
    const callerMd = "A\n\nB\n\n```ts\nreturn 1;\n```";

    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });

    expect(plan.newStorage).toContain(`ac:macro-id="${oldId}"`);
    expect(plan.deletedTokens).toEqual([]);
  });

  it("two identical code blocks in current storage, caller re-emits only one → one rescue, one deletion reported (with confirmation)", () => {
    // Both code macros have the same body; they differ only in ac:macro-id.
    // This is an unusual page shape but it's the edge case that pins down
    // the 1:1 claim contract of the rescue.
    const idA = "uuid-A";
    const idB = "uuid-B";
    const body = "print('hi')";
    const S = CODE_WITH_ID(idA, body) + CODE_WITH_ID(idB, body);

    const callerMd = "```python\nprint('hi')\n```";

    // Without confirmation, throws because exactly one of the two
    // code macros ends up deleted (the other is rescued).
    expect(() =>
      planUpdate({ currentStorage: S, callerMarkdown: callerMd })
    ).toThrow(/DELETIONS_NOT_CONFIRMED|deletion/i);

    // With confirmation, exactly one is reported deleted.
    const plan = planUpdate({
      currentStorage: S,
      callerMarkdown: callerMd,
      confirmDeletions: true,
    });
    expect(plan.deletedTokens.length).toBe(1);
    // Output contains the rescued macro's id exactly once.
    const ids = [...plan.newStorage.matchAll(/ac:macro-id="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(ids.length).toBe(1);
    // First-match-wins: the first deleted token with a matching body is
    // the one that gets rescued. Both IDs are valid rescue candidates;
    // assert it's one of them, not a fresh UUID.
    expect([idA, idB]).toContain(ids[0]);
  });

  it("sidecar attribute ordering does not break the match (old macro-id attr before ac:name vs after)", () => {
    // Build a sidecar entry where ac:macro-id appears BEFORE ac:name —
    // a shape that Confluence has been observed to emit.
    const S = `<ac:structured-macro ac:macro-id="swap-uuid-5" ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[echo hi]]></ac:plain-text-body></ac:structured-macro>`;
    const callerMd = "```bash\necho hi\n```";

    const plan = planUpdate({ currentStorage: S, callerMarkdown: callerMd });
    expect(plan.newStorage).toContain(`ac:macro-id="swap-uuid-5"`);
    expect(plan.deletedTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ConverterOptions plumbing
// ---------------------------------------------------------------------------

describe("planUpdate — converterOptions forwarded", () => {
  it("confluenceBaseUrl is passed through to markdownToStorage", () => {
    // Use replaceBody to isolate the markdownToStorage call path.
    const url = "https://example.atlassian.net/wiki/spaces/FOO/pages/12345/Title";
    const callerMd = `[click](${url})`;
    const plan = planUpdate({
      currentStorage: "",
      callerMarkdown: callerMd,
      replaceBody: true,
      converterOptions: { confluenceBaseUrl: "https://example.atlassian.net" },
    });
    // Post-B2: internal Confluence URLs are emitted as plain <a href> anchors
    // (identical to external links). The option still affects behaviour via
    // URL recognition paths elsewhere, but the emitted link shape is plain.
    expect(plan.newStorage).toContain(`<a href="${url}">click</a>`);
    expect(plan.newStorage).not.toContain(`<ac:link>`);
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
