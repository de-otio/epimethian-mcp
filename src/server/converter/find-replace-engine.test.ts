/**
 * W-FR (S1): find/replace engine. Pure-function tests; no mocks needed.
 * Property tests use fast-check with fixed seeds.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyFindReplace,
  buildViewMap,
  DUPLICATED_TOKEN,
  FIND_REPLACE_AMBIGUOUS,
  FIND_REPLACE_INVALID,
  FIND_REPLACE_MATCH_FAILED,
  FORGED_TOKEN,
  MAX_FIND_OCCURRENCES,
  toFenceView,
} from "./find-replace-engine.js";
import { placeholderLiteralSurplus, tokeniseStorage } from "./tokeniser.js";
import { sanitiseTenantText } from "./untrusted-fence.js";
import { PLACEHOLDER_LITERAL_IN_PAGE } from "./types.js";

const EMOTICON = '<ac:emoticon ac:name="smile"/>';
const INFO =
  '<ac:structured-macro ac:name="info" ac:macro-id="m-info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

describe("exactly-once matching", () => {
  it("rejects a find that matches twice, reporting the count", () => {
    const body = "<p>alpha beta alpha</p>";
    const fn = () => applyFindReplace(body, [{ find: "alpha", replace: "x" }]);
    expect(codeOf(fn)).toBe(FIND_REPLACE_AMBIGUOUS);
    expect(messageOf(fn)).toContain("matches 2 times");
  });

  it('counts overlapping occurrences: "aa" in "aaa" is ambiguous', () => {
    const fn = () => applyFindReplace("<p>aaa</p>", [{ find: "aa", replace: "b" }]);
    expect(codeOf(fn)).toBe(FIND_REPLACE_AMBIGUOUS);
    expect(messageOf(fn)).toContain("matches 2 times");
  });

  it("replace_all replaces every occurrence and reports the count", () => {
    const out = applyFindReplace("<p>a-b-a-c-a</p>", [
      { find: "a", replace: "Z", replace_all: true },
    ]);
    expect(out.body).toBe("<p>Z-b-Z-c-Z</p>");
    expect(out.perPair).toEqual([{ matched: "exact", count: 3 }]);
  });

  it("replace_all with overlapping occurrences is rejected", () => {
    const fn = () =>
      applyFindReplace("<p>aaa</p>", [{ find: "aa", replace: "b", replace_all: true }]);
    expect(codeOf(fn)).toBe(FIND_REPLACE_AMBIGUOUS);
    expect(messageOf(fn)).toContain("overlapping");
  });

  it("a single match is replaced and reported as exact", () => {
    const out = applyFindReplace("<p>alpha beta</p>", [{ find: "beta", replace: "gamma" }]);
    expect(out.body).toBe("<p>alpha gamma</p>");
    expect(out.perPair).toEqual([{ matched: "exact", count: 1 }]);
    expect(out.lostTokens).toEqual([]);
  });

  it("pairs apply in order on the running form", () => {
    const out = applyFindReplace("<p>one two</p>", [
      { find: "one", replace: "three" },
      { find: "three two", replace: "done" },
    ]);
    expect(out.body).toBe("<p>done</p>");
  });

  it("an earlier pair can make a later find ambiguous", () => {
    const fn = () =>
      applyFindReplace("<p>x y</p>", [
        { find: "x", replace: "y" },
        { find: "y", replace: "z" },
      ]);
    expect(codeOf(fn)).toBe(FIND_REPLACE_AMBIGUOUS);
    expect(messageOf(fn)).toContain("pair 2");
  });

  it("rejects an empty find", () => {
    expect(codeOf(() => applyFindReplace("<p>a</p>", [{ find: "", replace: "b" }]))).toBe(
      FIND_REPLACE_INVALID,
    );
  });

  it("no match fails with FIND_REPLACE_MATCH_FAILED", () => {
    expect(codeOf(() => applyFindReplace("<p>a</p>", [{ find: "zzz", replace: "b" }]))).toBe(
      FIND_REPLACE_MATCH_FAILED,
    );
  });

  it("refuses to count past the occurrence cap", () => {
    const body = `<p>${"a ".repeat(MAX_FIND_OCCURRENCES + 1)}</p>`;
    const fn = () => applyFindReplace(body, [{ find: "a", replace: "b", replace_all: true }]);
    expect(codeOf(fn)).toBe(FIND_REPLACE_AMBIGUOUS);
    expect(messageOf(fn)).toContain(`more than ${MAX_FIND_OCCURRENCES}`);
  });

  it("exactly MAX_FIND_OCCURRENCES occurrences are still replaced", () => {
    const body = `<p>${"a ".repeat(MAX_FIND_OCCURRENCES)}</p>`;
    const out = applyFindReplace(body, [{ find: "a", replace: "b", replace_all: true }]);
    expect(out.perPair[0].count).toBe(MAX_FIND_OCCURRENCES);
    expect(out.body).toBe(`<p>${"b ".repeat(MAX_FIND_OCCURRENCES)}</p>`);
  });

  it("a match may not cut a placeholder in half", () => {
    // "]] tail" occurs only as the end of the placeholder plus following text.
    const body = `<p>x${EMOTICON} tail</p>`;
    expect(codeOf(() => applyFindReplace(body, [{ find: "T0001]] tail", replace: "y" }]))).toBe(
      FIND_REPLACE_MATCH_FAILED,
    );
  });

  it("a match may not split a surrogate pair", () => {
    expect(
      codeOf(() => applyFindReplace("<p>\u{1F600}</p>", [{ find: "\uD83D", replace: "x" }])),
    ).toBe(FIND_REPLACE_MATCH_FAILED);
  });

  it("never matches text inside a macro", () => {
    const body = `<p>note</p>${INFO}`;
    const out = applyFindReplace(body, [{ find: "note", replace: "memo" }]);
    expect(out.body).toBe(`<p>memo</p>${INFO}`);
  });
});

describe("placeholder multiset", () => {
  it("a dropped placeholder is reported as lost (for the deletion gate)", () => {
    const body = `<p>a ${EMOTICON} b</p>`;
    const out = applyFindReplace(body, [{ find: "a [[epi:T0001]] b", replace: "a b" }]);
    expect(out.lostTokens).toEqual(["T0001"]);
    expect(out.body).toBe("<p>a b</p>");
    expect(out.sidecar.T0001).toBe(EMOTICON);
  });

  it("a moved placeholder keeps the macro exactly once", () => {
    const body = `<p>a ${EMOTICON} b c</p>`;
    const out = applyFindReplace(body, [
      { find: "a [[epi:T0001]] b c", replace: "a b c [[epi:T0001]]" },
    ]);
    expect(out.lostTokens).toEqual([]);
    expect(out.body).toBe(`<p>a b c ${EMOTICON}</p>`);
  });

  it("a duplicated placeholder is always rejected", () => {
    const body = `<p>a ${EMOTICON} b</p>`;
    expect(
      codeOf(() =>
        applyFindReplace(body, [{ find: "b", replace: "b [[epi:T0001]]" }]),
      ),
    ).toBe(DUPLICATED_TOKEN);
  });

  it("a forged placeholder in replace is rejected", () => {
    const body = `<p>a ${EMOTICON} b</p>`;
    expect(
      codeOf(() => applyFindReplace(body, [{ find: "b", replace: "[[epi:T0099]]" }])),
    ).toBe(FORGED_TOKEN);
    // A malformed `[[epi:` would plant a literal in the page.
    expect(
      codeOf(() => applyFindReplace(body, [{ find: "b", replace: "[[epi:oops" }])),
    ).toBe(FORGED_TOKEN);
  });

  it("a placeholder completed by neighbouring text is caught on the final form", () => {
    // The page text "i:T0001]]" is harmless on its own; replacing "Q" with
    // "[[ep" right before it would create a second copy of T0001.
    const body = `<p>${EMOTICON} Qi:T0001]]</p>`;
    expect(
      codeOf(() => applyFindReplace(body, [{ find: "Q", replace: "[[ep" }])),
    ).toBe(DUPLICATED_TOKEN);
  });

  it("a literal [[epi:T0001]] in a paragraph is refused", () => {
    const body = `<p>see [[epi:T0001]]</p>${EMOTICON}`;
    expect(codeOf(() => applyFindReplace(body, [{ find: "see", replace: "look" }]))).toBe(
      PLACEHOLDER_LITERAL_IN_PAGE,
    );
  });

  it("a literal placeholder inside a code macro's CDATA is not expanded", () => {
    const CODE =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x [[epi:T0002]] y]]></ac:plain-text-body></ac:structured-macro>';
    const body = `<p>a</p>${CODE}${EMOTICON}`;
    const out = applyFindReplace(body, [{ find: "<p>a</p>", replace: "<p>b</p>" }]);
    expect(out.body).toBe(`<p>b</p>${CODE}${EMOTICON}`);
    expect(out.body.split(EMOTICON)).toHaveLength(2);
  });

  it("placeholderLiteralSurplus counts only text outside macros", () => {
    const inCdata = tokeniseStorage(
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[[[epi:T0001]]]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(placeholderLiteralSurplus(inCdata.canonical, inCdata.sidecar)).toBe(0);
    const inText = tokeniseStorage(`<p>[[epi:T0001]]</p>${EMOTICON}`);
    expect(placeholderLiteralSurplus(inText.canonical, inText.sidecar)).toBe(1);
  });
});

describe("fence-equivalent (view) matching", () => {
  const STORED = "<p>Wait… a b x² y​z end</p>";

  it("text copied from a fenced read matches and keeps stored bytes outside the edit", () => {
    // What the agent sees inside the fence: NFKC + strip set.
    const fenced = sanitiseTenantText(STORED);
    expect(fenced).toBe("<p>Wait... a b x2 yz end</p>");
    const find = "a b x2 yz end";
    const out = applyFindReplace(STORED, [{ find, replace: "a b x2 yz END" }]);
    expect(out.perPair).toEqual([{ matched: "normalised", count: 1 }]);
    expect(out.body).toBe("<p>Wait… a b x² y​z END</p>");
  });

  it("an anchor-style insert never rewrites the anchor", () => {
    const out = applyFindReplace(STORED, [
      { find: "Wait... a b", replace: "Wait... a b (new)" },
    ]);
    expect(out.body).toBe("<p>Wait… a b (new) x² y​z end</p>");
  });

  it("an exact match wins over a view match", () => {
    const body = "<p>a b and a b</p>";
    const out = applyFindReplace(body, [{ find: "a b", replace: "X" }]);
    expect(out.perPair[0].matched).toBe("exact");
    expect(out.body).toBe("<p>a b and X</p>");
  });

  it("view occurrences that start inside an expansion are not counted", () => {
    // View "...." holds "..." twice (overlapping), but only the one that
    // starts on the ellipsis' piece boundary is a valid occurrence.
    const out = applyFindReplace("<p>….</p>", [{ find: "...", replace: "!" }]);
    expect(out.body).toBe("<p>!.</p>");
  });

  it("a view match must start and end on piece boundaries", () => {
    // ".." would need half of the ellipsis' three-dot expansion.
    expect(
      codeOf(() => applyFindReplace("<p>a…</p>", [{ find: "a..", replace: "x" }])),
    ).toBe(FIND_REPLACE_MATCH_FAILED);
  });

  it("two view matches are ambiguous", () => {
    const body = "<p>a b, a b</p>";
    expect(codeOf(() => applyFindReplace(body, [{ find: "a b", replace: "x" }]))).toBe(
      FIND_REPLACE_AMBIGUOUS,
    );
  });

  it("stripped characters next to the match keep their place, exactly once", () => {
    const body = "<p>x y​z</p>";
    expect(applyFindReplace(body, [{ find: "x y", replace: "x Y" }]).body).toBe(
      "<p>x Y​z</p>",
    );
    // Whole find kept as prefix: the zero-width space after the match must
    // not be pulled into (and then duplicated by) the kept prefix.
    expect(applyFindReplace(body, [{ find: "x y", replace: "x y!" }]).body).toBe(
      "<p>x y!​z</p>",
    );
    // Whole find kept as suffix, with a stripped character before the match.
    expect(
      applyFindReplace("<p>q​x y</p>", [{ find: "x y", replace: "!x y" }]).body,
    ).toBe("<p>q​!x y</p>");
    // Stripped character inside the kept prefix survives.
    expect(
      applyFindReplace("<p>a​ b</p>", [{ find: "a b", replace: "a c" }]).body,
    ).toBe("<p>a​ c</p>");
  });

  it("a find consisting only of stripped characters never view-matches", () => {
    expect(
      codeOf(() => applyFindReplace("<p>ab</p>", [{ find: "​", replace: "x" }])),
    ).toBe(FIND_REPLACE_MATCH_FAILED);
  });
});

describe("property tests (fast-check, fixed seeds)", () => {
  // Characters whose fence view differs from their bytes, plus plain text.
  // No combining marks: the per-code-point view does not reorder them.
  const textChar = fc.constantFrom(
    "a", "b", "c", " ", ".", "…", " ", "²", "​", "ﬁ", "Ａ", "Ⅳ",
  );
  const text = fc.array(textChar, { maxLength: 12 }).map((cs) => cs.join(""));
  const macro = fc.constantFrom(
    EMOTICON,
    INFO,
    '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a . b]]></ac:plain-text-body></ac:structured-macro>',
    '<ac:link><ri:page ri:content-title="a b"/></ac:link>',
  );
  const section = fc
    .array(fc.oneof(text, macro), { maxLength: 8 })
    .map((parts) => `<p>${parts.join("")}</p>`);

  it("the macro multiset is invariant when no placeholder appears in find or replace", () => {
    fc.assert(
      fc.property(section, text, text, fc.boolean(), (body, find, replace, all) => {
        fc.pre(find.length > 0);
        let out;
        try {
          out = applyFindReplace(body, [{ find, replace, replace_all: all }]);
        } catch {
          return; // rejected: nothing is written
        }
        const before = Object.values(tokeniseStorage(body).sidecar).sort();
        const after = Object.values(tokeniseStorage(out.body).sidecar).sort();
        expect(after).toEqual(before);
        expect(out.lostTokens).toEqual([]);
      }),
      { seed: 20261006, numRuns: 400 },
    );
  });

  it("bytes outside the matched range are unchanged (exact and view matches)", () => {
    fc.assert(
      fc.property(text, text, text, text, (left, middle, right, replacement) => {
        // "§" occurs only in the target, so the match is unique.
        const target = `§${middle}§`;
        const body = `<p>${left}${target}${right}</p>`;
        const find = sanitiseTenantText(target); // as copied from a fenced read
        const out = applyFindReplace(body, [{ find, replace: replacement }]);
        expect(out.body.startsWith(`<p>${left}`)).toBe(true);
        expect(out.body.endsWith(`${right}</p>`)).toBe(true);
        expect(out.perPair[0].count).toBe(1);
      }),
      { seed: 7001, numRuns: 400 },
    );
  });

  it("a no-op replacement (find = replace) leaves the stored bytes untouched", () => {
    fc.assert(
      fc.property(text, text, text, (left, middle, right) => {
        const target = `§${middle}§`;
        const body = `<p>${left}${target}${right}</p>`;
        const find = sanitiseTenantText(target);
        expect(applyFindReplace(body, [{ find, replace: find }]).body).toBe(body);
      }),
      { seed: 7002, numRuns: 300 },
    );
  });

  it("stripped and folded characters inside the match keep their stored bytes", () => {
    // The match range itself is full of characters the fence strips (ZWSP,
    // ZWJ) or folds (NBSP, ellipsis, superscript); there are no "§" anchors,
    // so the common prefix/suffix runs through those characters.
    const oddChar = fc.constantFrom("​", "‍", " ", "…", "²", "a", " ");
    const middle = fc
      .array(oddChar, { minLength: 1, maxLength: 10 })
      .map((cs) => cs.join(""))
      .filter((m) => sanitiseTenantText(m) !== m);
    fc.assert(
      fc.property(middle, (m) => {
        const body = `<p>a${m}b</p>`;
        const find = sanitiseTenantText(`a${m}b`); // as copied from a fenced read
        // No-op replacement: nothing changes.
        expect(applyFindReplace(body, [{ find, replace: find }]).body).toBe(body);
        // Anchor-style insert: the stored match survives, only "X" is added.
        expect(applyFindReplace(body, [{ find, replace: `${find}X` }]).body).toBe(`<p>a${m}bX</p>`);
        // Prepend: the same, on the other side.
        expect(applyFindReplace(body, [{ find, replace: `X${find}` }]).body).toBe(`<p>Xa${m}b</p>`);
      }),
      { seed: 7005, numRuns: 300 },
    );
  });

  it("the offset map is monotone and consistent with the view", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        const m = buildViewMap(s);
        expect(m.view).toBe(toFenceView(s));
        const n = m.srcStart.length;
        for (let k = 0; k < n; k++) {
          expect(m.srcEnd[k]).toBeGreaterThan(m.srcStart[k]);
          expect(m.viewEnd[k]).toBeGreaterThanOrEqual(m.viewStart[k]);
          if (k > 0) {
            expect(m.srcStart[k]).toBe(m.srcEnd[k - 1]);
            expect(m.viewStart[k]).toBe(m.viewEnd[k - 1]);
          }
        }
        expect(n === 0 ? 0 : m.srcEnd[n - 1]).toBe(s.length);
        expect(n === 0 ? 0 : m.viewEnd[n - 1]).toBe(m.view.length);
      }),
      { seed: 7003, numRuns: 300 },
    );
  });

  it("fenced text has the same view as its source", () => {
    fc.assert(
      fc.property(text, (s) => {
        expect(toFenceView(sanitiseTenantText(s))).toBe(toFenceView(s));
      }),
      { seed: 7004, numRuns: 300 },
    );
  });
});
