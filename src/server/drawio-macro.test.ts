import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deflateRawSync } from "node:zlib";
import {
  bumpDrawioRevision,
  countMxCells,
  findDrawioMacros,
  looksLikeDrawioXml,
  MAX_INFLATED_DIAGRAM_BYTES,
} from "./drawio-macro.js";

const param = (name: string, value: string) =>
  `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;

function drawio(
  p: {
    name?: string;
    pageId?: string;
    revision?: string;
    contentVer?: string;
    custContentId?: string;
    macroName?: string;
  } = {},
): string {
  return (
    `<ac:structured-macro ac:name="${p.macroName ?? "drawio"}" ac:schema-version="1" ac:macro-id="m-1">` +
    (p.name !== undefined ? param("diagramName", p.name) : "") +
    (p.pageId !== undefined ? param("pageId", p.pageId) : "") +
    (p.custContentId !== undefined ? param("custContentId", p.custContentId) : "") +
    (p.revision !== undefined ? param("revision", p.revision) : "") +
    (p.contentVer !== undefined ? param("contentVer", p.contentVer) : "") +
    `</ac:structured-macro>`
  );
}

const opts = (diagramName: string, newRevision: number, pageId = "12345") => ({
  diagramName,
  pageId,
  newRevision,
});

describe("findDrawioMacros", () => {
  it("finds attribute order, quote and whitespace variants", () => {
    const variants = [
      `<ac:structured-macro ac:name="drawio">${param("diagramName", "x.drawio")}</ac:structured-macro>`,
      `<ac:structured-macro ac:name='drawio'>${param("diagramName", "x.drawio")}</ac:structured-macro>`,
      `<ac:structured-macro ac:schema-version="1" data-layout="wide" ac:name="drawio" ac:local-id="l">${param("diagramName", "x.drawio")}</ac:structured-macro>`,
      `<ac:structured-macro\n  ac:name = "drawio"\n>${param("diagramName", "x.drawio")}</ac:structured-macro>`,
      `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name='diagramName' ac:x="1">x.drawio</ac:parameter></ac:structured-macro>`,
    ];
    for (const v of variants) {
      const refs = findDrawioMacros(`<p>a</p>${v}<p>b</p>`);
      expect(refs).toHaveLength(1);
      expect(refs[0].diagramName).toBe("x.drawio");
    }
  });

  it("reports offsets of the macro and value spans", () => {
    const m = drawio({ name: "a.drawio", revision: "7" });
    const s = `xx${m}yy`;
    const [ref] = findDrawioMacros(s);
    expect(s.slice(ref.start, ref.end)).toBe(m);
    expect(s.slice(ref.revision!.start, ref.revision!.end)).toBe("7");
    expect(ref.revision!.value).toBe("7");
  });

  it("decodes entities in a single pass", () => {
    const s = drawio({ name: "a &amp; b &#65;&#x42; &amp;lt; &#0; &quot;&apos;", pageId: "&#49;23" });
    const [ref] = findDrawioMacros(s);
    expect(ref.diagramName).toBe(`a & b AB &lt; &#0; "'`);
    expect(ref.pageIdParam).toBe("123");
  });

  it("uses the first of a repeated parameter and flags custom content", () => {
    const s =
      `<ac:structured-macro ac:name="drawio">${param("diagramName", "first")}${param("diagramName", "second")}` +
      `${param("contentId", "55")}</ac:structured-macro>`;
    const [ref] = findDrawioMacros(s);
    expect(ref.diagramName).toBe("first");
    expect(ref.hasCustomContent).toBe(true);
    expect(findDrawioMacros(drawio({ name: "a", custContentId: "" }))[0].hasCustomContent).toBe(false);
  });

  it("never matches other macros", () => {
    const s = drawio({ name: "a", macroName: "inc-drawio" }) + drawio({ name: "a", macroName: "drawio-sketch" });
    expect(findDrawioMacros(s)).toEqual([]);
  });

  it("skips macros inside CDATA and comments, including unterminated ones", () => {
    const m = drawio({ name: "a", revision: "1" });
    expect(findDrawioMacros(`<![CDATA[${m}]]>`)).toEqual([]);
    expect(findDrawioMacros(`<!-- ${m} -->`)).toEqual([]);
    expect(findDrawioMacros(`<!-- ${m}`)).toEqual([]);
    expect(findDrawioMacros(`<![CDATA[ ${m}`)).toEqual([]);
    const after = `<!-- c -->${m}`;
    expect(findDrawioMacros(after)).toHaveLength(1);
  });

  it("skips a drawio macro that contains another macro", () => {
    const s =
      `<ac:structured-macro ac:name="drawio">${param("diagramName", "a")}` +
      `<ac:structured-macro ac:name="info"></ac:structured-macro></ac:structured-macro>`;
    expect(findDrawioMacros(s)).toEqual([]);
  });

  it("still finds a drawio macro nested in another macro's body", () => {
    const inner = drawio({ name: "a", revision: "1" });
    const s = `<ac:structured-macro ac:name="panel"><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`;
    expect(findDrawioMacros(s)).toHaveLength(1);
  });

  it("ignores parameters whose value is not plain text", () => {
    const s = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName"><b>x</b></ac:parameter></ac:structured-macro>`;
    expect(findDrawioMacros(s)[0].diagramName).toBe("");
  });

  it("handles a large input quickly", () => {
    const filler = "<ac:structured-macro ac:name='x'>".repeat(50_000);
    const t = Date.now();
    findDrawioMacros(filler + drawio({ name: "a", revision: "1" }));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("bumpDrawioRevision examples", () => {
  it("bumps a matching macro and leaves other bytes alone", () => {
    const body = `<p>x</p>${drawio({ name: "example.drawio", pageId: "12345", revision: "2" })}<p>y</p>`;
    const r = bumpDrawioRevision(body, opts("example.drawio", 3));
    expect(r.updated).toBe(1);
    expect(r.body).toBe(body.replace(param("revision", "2"), param("revision", "3")));
  });

  it("matches entity-encoded names", () => {
    const body = drawio({ name: "a &amp; b.drawio", revision: "1" });
    const r = bumpDrawioRevision(body, opts("a & b.drawio", 2));
    expect(r.updated).toBe(1);
    expect(r.body).toContain(">2<");
  });

  it("bumps every macro for the same diagram", () => {
    const m = drawio({ name: "a.drawio", revision: "1" });
    const r = bumpDrawioRevision(`${m}<p/>${m}`, opts("a.drawio", 5));
    expect(r.updated).toBe(2);
    expect(findDrawioMacros(r.body).map((x) => x.revision!.value)).toEqual(["5", "5"]);
  });

  it("skips a macro for another page", () => {
    const body = drawio({ name: "a.drawio", pageId: "999", revision: "1" });
    const r = bumpDrawioRevision(body, opts("a.drawio", 2));
    expect(r.skipped).toEqual([{ reason: "other-page" }]);
    expect(r.body).toBe(body);
  });

  it("reports a missing revision", () => {
    const body = drawio({ name: "a.drawio" });
    const r = bumpDrawioRevision(body, opts("a.drawio", 2));
    expect(r.skipped).toEqual([{ reason: "no-revision-param" }]);
    expect(r.body).toBe(body);
  });

  it("reports a non-numeric revision", () => {
    for (const rev of ["", "1.5", "-1", "x", " 1"]) {
      const body = drawio({ name: "a.drawio", revision: rev });
      const r = bumpDrawioRevision(body, opts("a.drawio", 2));
      expect(r.skipped).toEqual([{ reason: "non-numeric-revision" }]);
      expect(r.body).toBe(body);
    }
  });

  it("never lowers a revision and counts equal ones as current", () => {
    const ahead = drawio({ name: "a.drawio", revision: "9" });
    expect(bumpDrawioRevision(ahead, opts("a.drawio", 3))).toEqual({
      body: ahead,
      updated: 0,
      alreadyCurrent: 0,
      skipped: [{ reason: "revision-ahead" }],
    });
    const same = drawio({ name: "a.drawio", revision: "3" });
    const r = bumpDrawioRevision(same, opts("a.drawio", 3));
    expect(r.alreadyCurrent).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.body).toBe(same);
  });

  it("compares huge revisions exactly", () => {
    const body = drawio({ name: "a.drawio", revision: "99999999999999999999999" });
    expect(bumpDrawioRevision(body, opts("a.drawio", 2)).skipped).toEqual([{ reason: "revision-ahead" }]);
  });

  it("bumps contentVer only when it equalled the old revision", () => {
    const equal = bumpDrawioRevision(drawio({ name: "a", revision: "4", contentVer: "4" }), opts("a", 6));
    expect(findDrawioMacros(equal.body)[0].contentVer!.value).toBe("6");
    const diff = bumpDrawioRevision(drawio({ name: "a", revision: "4", contentVer: "2" }), opts("a", 6));
    expect(findDrawioMacros(diff.body)[0].contentVer!.value).toBe("2");
    const absent = bumpDrawioRevision(drawio({ name: "a", revision: "4" }), opts("a", 6));
    expect(findDrawioMacros(absent.body)[0].contentVer).toBeUndefined();
    const notUpdated = bumpDrawioRevision(drawio({ name: "a", revision: "6", contentVer: "6" }), opts("a", 6));
    expect(findDrawioMacros(notUpdated.body)[0].contentVer!.value).toBe("6");
  });

  it("skips custom-content macros and returns the same string", () => {
    const body = drawio({ name: "a", custContentId: "77", revision: "1" });
    const r = bumpDrawioRevision(body, opts("a", 2));
    expect(r.skipped).toEqual([{ reason: "custom-content" }]);
    expect(r.body).toBe(body);
  });

  it("matches the name exactly: no prefix, no case folding, no trim", () => {
    const body =
      drawio({ name: "a.drawio.bak", revision: "1" }) +
      drawio({ name: "A.DRAWIO", revision: "1" }) +
      drawio({ name: " a.drawio", revision: "1" });
    const r = bumpDrawioRevision(body, opts("a.drawio", 2));
    expect(r.body).toBe(body);
    expect(r.updated + r.alreadyCurrent + r.skipped.length).toBe(0);
  });

  it("ignores a nested macro and a CDATA example", () => {
    const nested =
      `<ac:structured-macro ac:name="drawio">${param("diagramName", "a")}${param("revision", "1")}` +
      `<ac:structured-macro ac:name="info"></ac:structured-macro></ac:structured-macro>`;
    expect(bumpDrawioRevision(nested, opts("a", 2)).body).toBe(nested);
    const code = `<ac:plain-text-body><![CDATA[${drawio({ name: "a", revision: "1" })}]]></ac:plain-text-body>`;
    expect(bumpDrawioRevision(code, opts("a", 2)).body).toBe(code);
    const comment = `<!-- ${drawio({ name: "a", revision: "1" })}`;
    expect(bumpDrawioRevision(comment, opts("a", 2)).body).toBe(comment);
  });

  it("rejects invalid newRevision", () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
      expect(() => bumpDrawioRevision("", opts("a", n))).toThrow(RangeError);
    }
    expect(() => bumpDrawioRevision("", opts("a", 1))).not.toThrow();
  });
});

describe("bumpDrawioRevision properties", () => {
  const rev = fc.option(fc.nat({ max: 20 }).map(String), { nil: undefined });
  const macro = fc
    .record({
      name: fc.constantFrom("a.drawio", "b.drawio", "a &amp; b.drawio"),
      pageId: fc.option(fc.constantFrom("12345", "999"), { nil: undefined }),
      revision: rev,
      contentVer: rev,
    })
    .map(drawio);
  const decoy = fc.oneof(
    macro.map((m) => m.replace('ac:name="drawio"', 'ac:name="inc-drawio"')),
    macro.map((m) => `<ac:plain-text-body><![CDATA[${m}]]></ac:plain-text-body>`),
    macro.map((m) => `<!-- ${m} -->`),
    fc.constant(`<ac:structured-macro ac:name="info"><ac:rich-text-body><p>hi &amp; bye</p></ac:rich-text-body></ac:structured-macro>`),
    fc.constantFrom("<p>text</p>", "<p>é ü 日本</p>", "\n  ", "&nbsp;"),
  );
  const page = fc.array(fc.oneof(macro, decoy), { maxLength: 8 }).map((xs) => xs.join(""));
  const target = fc.record({
    diagramName: fc.constantFrom("a.drawio", "b.drawio", "a & b.drawio", "zzz"),
    newRevision: fc.integer({ min: 1, max: 25 }),
  });
  const run = { seed: 42, numRuns: 300 };

  const stripSpans = (s: string) => {
    const spans = findDrawioMacros(s)
      .flatMap((r) => [r.revision, r.contentVer])
      .filter((x) => x !== undefined)
      .sort((x, y) => x.start - y.start);
    let pos = 0;
    let out = "";
    for (const sp of spans) {
      out += s.slice(pos, sp.start);
      pos = sp.end;
    }
    return out + s.slice(pos);
  };

  it("changes nothing outside the replaced value spans", () => {
    fc.assert(
      fc.property(page, target, (body, t) => {
        const r = bumpDrawioRevision(body, { ...t, pageId: "12345" });
        expect(stripSpans(r.body)).toBe(stripSpans(body));
        expect(findDrawioMacros(r.body)).toHaveLength(findDrawioMacros(body).length);
      }),
      run,
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(page, target, (body, t) => {
        const o = { ...t, pageId: "12345" };
        const once = bumpDrawioRevision(body, o);
        const twice = bumpDrawioRevision(once.body, o);
        expect(twice.body).toBe(once.body);
        expect(twice.updated).toBe(0);
      }),
      run,
    );
  });

  it("returns the same string when no macro matches", () => {
    fc.assert(
      fc.property(page, fc.integer({ min: 1, max: 25 }), (body, newRevision) => {
        const r = bumpDrawioRevision(body, { diagramName: "no-such.drawio", pageId: "12345", newRevision });
        expect(r.body).toBe(body);
        expect(r.updated).toBe(0);
      }),
      run,
    );
  });

  it("never lowers a revision and only touches revisions of matching, current-page macros", () => {
    fc.assert(
      fc.property(page, target, (body, t) => {
        const before = findDrawioMacros(body);
        const after = findDrawioMacros(bumpDrawioRevision(body, { ...t, pageId: "12345" }).body);
        expect(after).toHaveLength(before.length);
        before.forEach((b, i) => {
          const a = after[i];
          if (b.revision === undefined) {
            expect(a.revision).toBeUndefined();
            return;
          }
          if (/^\d+$/.test(b.revision.value)) {
            expect(Number(a.revision!.value)).toBeGreaterThanOrEqual(Number(b.revision.value));
          }
          const eligible =
            b.diagramName === t.diagramName && (b.pageIdParam === undefined || b.pageIdParam === "12345");
          if (!eligible) expect(a.revision!.value).toBe(b.revision.value);
          expect(a.diagramName).toBe(b.diagramName);
        });
      }),
      run,
    );
  });

  it("leaves decoys (inc-drawio, CDATA, comments, other macros) byte-identical", () => {
    fc.assert(
      fc.property(fc.array(decoy, { maxLength: 8 }), target, (parts, t) => {
        const body = parts.join("");
        expect(bumpDrawioRevision(body, { ...t, pageId: "12345" }).body).toBe(body);
      }),
      run,
    );
  });
});

describe("countMxCells", () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => `<mxCell id="${i}" value="" parent="1"/>`).join("");
  const model = (n: number) => `<mxGraphModel><root>${cells(n)}</root></mxGraphModel>`;
  const compress = (xml: string) => deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");

  it("counts plain cells, not lookalike elements", () => {
    const xml = `<mxfile><diagram name="p">${model(3)}</diagram></mxfile>`;
    expect(countMxCells(xml)).toEqual({ ok: true, count: 3 });
    expect(countMxCells("<mxCellX/><mxCell><mxCell\n/>")).toEqual({ ok: true, count: 2 });
    expect(countMxCells("")).toEqual({ ok: true, count: 0 });
  });

  it("counts a bare mxGraphModel", () => {
    expect(countMxCells(model(4))).toEqual({ ok: true, count: 4 });
  });

  it("inflates a compressed diagram", () => {
    const xml = `<mxfile><diagram id="a" name="P 1">${compress(model(5))}</diagram></mxfile>`;
    expect(countMxCells(xml)).toEqual({ ok: true, count: 5 });
  });

  it("sums across compressed and uncompressed diagrams", () => {
    const xml =
      `<mxfile><diagram name="1">${compress(model(2))}</diagram>` +
      `<diagram name="2">${model(3)}</diagram>` +
      `<diagram name="3">\n${compress(model(4))}\n</diagram></mxfile>`;
    expect(countMxCells(xml)).toEqual({ ok: true, count: 9 });
  });

  it("handles non-ASCII content via URI decoding", () => {
    const xml = `<mxfile><diagram>${compress(`<mxGraphModel><mxCell value="日本 é"/></mxGraphModel>`)}</diagram></mxfile>`;
    expect(countMxCells(xml)).toEqual({ ok: true, count: 1 });
  });

  it("fails on bad base64 and garbage without throwing", () => {
    for (const payload of ["!!!not base64!!!", "QUJD", "A", "====", Buffer.from("plain text").toString("base64")]) {
      const r = countMxCells(`<mxfile><diagram>${payload}</diagram></mxfile>`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/could not be decoded/);
    }
  });

  it("fails on a valid deflate stream that is not URI-encoded", () => {
    const bad = deflateRawSync(Buffer.from("100% sure")).toString("base64");
    expect(countMxCells(`<mxfile><diagram>${bad}</diagram></mxfile>`).ok).toBe(false);
  });

  it("refuses a decompression bomb", () => {
    const bomb = deflateRawSync(Buffer.alloc(MAX_INFLATED_DIAGRAM_BYTES + 6 * 1024 * 1024, "a")).toString("base64");
    const r = countMxCells(`<mxfile><diagram>${bomb}</diagram></mxfile>`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/64 MB/);
  });

  it("the inflate limit is for the whole file: pages under it one by one still add up", () => {
    // Each page inflates to 3/8 of the limit; three of them exceed it together.
    const page = deflateRawSync(Buffer.alloc((MAX_INFLATED_DIAGRAM_BYTES / 8) * 3, "a")).toString("base64");
    const two = countMxCells(`<mxfile><diagram>${page}</diagram><diagram>${page}</diagram></mxfile>`);
    // "a…" is not valid URI-encoded XML with cells, but it decodes; two fit.
    expect(two).toEqual({ ok: true, count: 0 });
    const three = countMxCells(
      `<mxfile><diagram>${page}</diagram><diagram>${page}</diagram><diagram>${page}</diagram></mxfile>`
    );
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.reason).toMatch(/64 MB in total/);
  });
});

describe("looksLikeDrawioXml", () => {
  it("accepts mxfile and mxGraphModel roots", () => {
    expect(looksLikeDrawioXml(`<mxfile host="x"><diagram/></mxfile>`).ok).toBe(true);
    expect(looksLikeDrawioXml(`<mxfile>`).ok).toBe(true);
    expect(looksLikeDrawioXml(`<mxGraphModel><root/></mxGraphModel>`).ok).toBe(true);
    expect(looksLikeDrawioXml(`<mxGraphModel/>`).ok).toBe(true);
  });

  it("accepts a BOM, whitespace and an XML declaration", () => {
    expect(looksLikeDrawioXml(`﻿  \n<?xml version="1.0" encoding="UTF-8"?>\n<mxfile></mxfile>`).ok).toBe(true);
    expect(looksLikeDrawioXml(`<?xml version="1.0"?><mxGraphModel/>`).ok).toBe(true);
  });

  it("rejects other content", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("latin1");
    for (const t of [png, "just some text", "<html><body>hi</body></html>", "", "<mxfileX/>", "<svg/>", "x<mxfile>"]) {
      expect(looksLikeDrawioXml(t).ok).toBe(false);
    }
  });

  it("rejects DOCTYPE and ENTITY anywhere, case-insensitively", () => {
    expect(looksLikeDrawioXml(`<!DOCTYPE foo><mxfile/>`).ok).toBe(false);
    expect(looksLikeDrawioXml(`<mxfile><!doctype x></mxfile>`).ok).toBe(false);
    expect(looksLikeDrawioXml(`<?xml version="1.0"?><!ENTITY a "b"><mxfile/>`).ok).toBe(false);
    const r = looksLikeDrawioXml(`<mxfile/><!EnTiTy x "y">`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/DOCTYPE|ENTITY/);
  });
});
