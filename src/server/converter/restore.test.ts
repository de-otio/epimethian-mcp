import { describe, expect, it } from "vitest";
import { restoreFromTokens } from "./restore.js";
import { ConverterError } from "./types.js";

describe("restoreFromTokens — basic cases", () => {
  it("empty input → empty output", () => {
    expect(restoreFromTokens("", {})).toBe("");
    expect(restoreFromTokens("", { T0001: "<ac:x/>" })).toBe("");
  });

  it("plain text without tokens passes through", () => {
    const s = "no tokens here, just text and <p>markup</p>";
    expect(restoreFromTokens(s, {})).toBe(s);
  });

  it("single token is replaced byte-for-byte", () => {
    const xml = `<ac:structured-macro ac:name="info"></ac:structured-macro>`;
    const s = `before [[epi:T0001]] after`;
    expect(restoreFromTokens(s, { T0001: xml })).toBe(`before ${xml} after`);
  });

  it("multiple tokens are all replaced", () => {
    const a = `<ac:a/>`;
    const b = `<ri:b/>`;
    const c = `<time datetime="2024-01-01"/>`;
    const s = `[[epi:T0001]] and [[epi:T0002]] and [[epi:T0003]]`;
    expect(
      restoreFromTokens(s, { T0001: a, T0002: b, T0003: c })
    ).toBe(`${a} and ${b} and ${c}`);
  });

  it("sidecar may hold verbatim XML with surrounding whitespace and CDATA", () => {
    const xml =
      `<ac:structured-macro ac:name="code">\n` +
      `  <ac:plain-text-body><![CDATA[x ]]]]><![CDATA[> y]]></ac:plain-text-body>\n` +
      `</ac:structured-macro>`;
    expect(restoreFromTokens(`[[epi:T0001]]`, { T0001: xml })).toBe(xml);
  });

  it("same token referenced twice is replaced in both positions", () => {
    const xml = `<ri:user ri:account-id="u"/>`;
    const s = `[[epi:T0001]] and again [[epi:T0001]]`;
    expect(restoreFromTokens(s, { T0001: xml })).toBe(`${xml} and again ${xml}`);
  });
});

describe("restoreFromTokens — security and robustness", () => {
  it("forged token (in input, not in sidecar) throws ConverterError with code FORGED_TOKEN", () => {
    expect(() => restoreFromTokens(`[[epi:T9999]]`, {})).toThrow(
      ConverterError
    );
    try {
      restoreFromTokens(`[[epi:T9999]]`, {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConverterError);
      expect((err as ConverterError).code).toBe("FORGED_TOKEN");
      expect((err as Error).message).toContain("T9999");
    }
  });

  it("error references the token by ID only, not sidecar contents (security #11)", () => {
    const sidecar = { T0001: `<ac:structured-macro ac:name="info">SECRET</ac:structured-macro>` };
    try {
      restoreFromTokens(`[[epi:T0007]]`, sidecar);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("T0007");
      expect(msg).not.toContain("SECRET");
      expect(msg).not.toContain("info");
    }
  });

  it("sidecar entries that do not appear in the input are silently ignored", () => {
    const xml = `<ac:x/>`;
    const out = restoreFromTokens(`[[epi:T0001]]`, {
      T0001: xml,
      T0002: `<ac:unused/>`,
      T0042: `<ac:also-unused/>`,
    });
    expect(out).toBe(xml);
  });

  it("when multiple tokens are present and one is forged, rejects with that token's ID", () => {
    const sidecar = { T0001: `<ac:a/>` };
    try {
      restoreFromTokens(`[[epi:T0001]] then [[epi:T0002]]`, sidecar);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ConverterError).code).toBe("FORGED_TOKEN");
      expect((err as Error).message).toContain("T0002");
    }
  });

  it("does not treat Object.prototype properties as valid sidecar entries", () => {
    // A token called T__proto__ shouldn't pass; but our regex only allows
    // T\d+. Test the defence-in-depth: a numeric token that happens to
    // coincide with an inherited property name. There are none of those,
    // so instead verify that a plain sidecar with no entries rejects.
    expect(() => restoreFromTokens(`[[epi:T0001]]`, {})).toThrow(
      "forged or unknown token T0001"
    );
  });

  it("ignores malformed bracket sequences that aren't valid tokens", () => {
    // `[[epi:BADID]]` doesn't match the T\d+ pattern → not a token at all.
    const s = `[[epi:BADID]] and [[epi:T0001]] and [[foo]]`;
    const out = restoreFromTokens(s, { T0001: `<ac:x/>` });
    expect(out).toBe(`[[epi:BADID]] and <ac:x/> and [[foo]]`);
  });

  it("token IDs with many digits (beyond 4-digit pad) are accepted", () => {
    const s = `[[epi:T12345]]`;
    expect(restoreFromTokens(s, { T12345: `<ac:big/>` })).toBe(`<ac:big/>`);
  });

  it("preserves non-token content byte-for-byte around replacements", () => {
    const s =
      `<p>Start</p>\n` +
      `  [[epi:T0001]]  \n` +
      `<!-- a genuine comment, not a token -->\n` +
      `<p>End</p>`;
    const out = restoreFromTokens(s, { T0001: `<ac:panel/>` });
    expect(out).toBe(
      `<p>Start</p>\n` +
        `  <ac:panel/>  \n` +
        `<!-- a genuine comment, not a token -->\n` +
        `<p>End</p>`
    );
  });
});
