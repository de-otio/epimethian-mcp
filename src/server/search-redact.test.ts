import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  REDACTED,
  cleanSearchText,
  compileRedactor,
  decodeEntitiesOnce,
  normaliseRedactPattern,
  stripHighlightMarkers,
} from "./search-redact.js";

const ZWSP = "\u200B";
const SOFT_HYPHEN = "\u00AD";

function redact(patterns: string[], text: string): string {
  const r = compileRedactor(patterns);
  if (r === undefined) throw new Error("no redactor");
  return r(text);
}

describe("stripHighlightMarkers", () => {
  it("removes both marker forms", () => {
    expect(stripHighlightMarkers("a @@@hl@@@match@@@endhl@@@ b")).toBe("a match b");
  });

  it("removes a marker nested inside another until stable", () => {
    expect(stripHighlightMarkers("@@@h@@@hl@@@l@@@")).toBe("");
    expect(stripHighlightMarkers("@@@end@@@hl@@@hl@@@")).toBe("");
  });

  it("leaves other text alone", () => {
    expect(stripHighlightMarkers("@@@ not a marker @@@")).toBe("@@@ not a marker @@@");
  });
});

describe("decodeEntitiesOnce", () => {
  it("decodes numeric, hex and common named entities in one pass", () => {
    expect(decodeEntitiesOnce("&#99;&#x63;&amp;&nbsp;&eacute;")).toBe("cc&\u00A0\u00E9");
  });

  it("decodes invalid code points to U+FFFD instead of throwing", () => {
    expect(decodeEntitiesOnce("&#0;&#xD800;&#1114112;&#99999999999;")).toBe("\uFFFD".repeat(4));
  });

  it("leaves unknown named entities as written", () => {
    expect(decodeEntitiesOnce("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("cleanSearchText", () => {
  it("strips markers but does not decode or normalise when no redactor is set", () => {
    expect(cleanSearchText("@@@hl@@@a&amp;b@@@endhl@@@")).toBe("a&amp;b");
  });
});

describe("compileRedactor", () => {
  it("returns undefined for no patterns", () => {
    expect(compileRedactor([])).toBeUndefined();
  });

  it("replaces literal matches case-insensitively", () => {
    expect(redact(["Project Falcon"], "about project FALCON today")).toBe(
      `about ${REDACTED} today`,
    );
  });

  it("treats patterns as literals, never as regular expressions", () => {
    expect(redact(["a.c(", "x+y"], "abc a.c( xxy x+y")).toBe(`abc ${REDACTED} xxy ${REDACTED}`);
    expect(redact(["a-b"], "a-b ab")).toBe(`${REDACTED} ab`);
    expect(redact(["[x]"], "x [x]")).toBe(`x ${REDACTED}`);
  });

  it("redacts the longer pattern whole when one contains another", () => {
    expect(redact(["secret", "secret plan"], "the secret plan")).toBe(`the ${REDACTED}`);
  });

  it("sees through numeric and hex entities, including double encoding", () => {
    expect(redact(["secret"], "se&#99;ret and se&#x63;ret and se&amp;#99;ret")).toBe(
      `${REDACTED} and ${REDACTED} and ${REDACTED}`,
    );
  });

  it("sees through fullwidth letters and invisible characters", () => {
    expect(redact(["secret"], "\uFF53ecret")).toBe(REDACTED);
    expect(redact(["secret"], `sec${ZWSP}ret`)).toBe(REDACTED);
    expect(redact(["secret"], `sec${SOFT_HYPHEN}ret`)).toBe(REDACTED);
    expect(redact(["secret"], "sec&shy;ret")).toBe(REDACTED);
  });

  it("matches when the pattern itself is written with compatibility characters", () => {
    expect(redact(["\uFF53ecret"], "a secret")).toBe(`a ${REDACTED}`);
  });

  it("sees through highlight markers, including ones built by decoding or normalising", () => {
    expect(redact(["secret"], "sec@@@hl@@@ret")).toBe(REDACTED);
    expect(redact(["secret"], "sec@@&#64;hl@@@ret")).toBe(REDACTED);
    expect(redact(["secret"], "sec\uFF20\uFF20\uFF20hl\uFF20\uFF20\uFF20ret")).toBe(REDACTED);
  });

  it("is linear on pathological input: no regex semantics, so no ReDoS", () => {
    const text = `${"a".repeat(50_000)}!`;
    const started = Date.now();
    expect(redact(["(a+)+$", "a*a*a*b"], text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("hides text whose encoding never settles rather than showing it", () => {
    const nested = `&${"amp;".repeat(40)}#99;`;
    expect(redact(["secret"], nested)).toBe(REDACTED);
  });

  it("does not redact unrelated text", () => {
    expect(redact(["secret"], "nothing to see")).toBe("nothing to see");
  });

  it("rejects a pattern that is empty after normalisation, without echoing it", () => {
    expect(normaliseRedactPattern(`${ZWSP}${SOFT_HYPHEN}`)).toBeUndefined();
    expect(() => compileRedactor([`${ZWSP}`])).toThrow(/empty after normalisation/);
  });

  it("property: no configured pattern survives in the output", () => {
    const piece = fc.constantFrom(
      "x",
      "y",
      "z",
      "X",
      "&#120;",
      "&#x79;",
      "\uFF5A",
      ZWSP,
      SOFT_HYPHEN,
      "@@@hl@@@",
      "@@@endhl@@@",
      "&amp;#122;",
      " ",
    );
    const pattern = fc.stringMatching(/^[xyz]{1,4}$/);
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 40 }).map((p) => p.join("")),
        fc.array(pattern, { minLength: 1, maxLength: 3 }),
        (text, patterns) => {
          const out = compileRedactor(patterns)!(text);
          if (out === REDACTED) return true;
          const lowered = out.toLowerCase();
          return patterns.every((p) => !lowered.includes(p));
        },
      ),
      { seed: 20261006, numRuns: 500 },
    );
  });
});
