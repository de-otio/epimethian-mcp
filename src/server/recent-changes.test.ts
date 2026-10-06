import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SearchHit, VersionMetadata } from "./confluence-client.js";
import { scopeCql } from "./cql-scope.js";
import {
  MAX_WINDOW_HOURS,
  VERSION_FETCH_LIMIT,
  buildRecentChangesCql,
  condenseDiff,
  filterToWindow,
  formatReport,
  hitModifiedMs,
  resolveEffectiveSpaces,
  resolveWindow,
  sortEntries,
  summariseVersions,
  type Fence,
  type ReportEntry,
  type ReportInput,
  type Window,
} from "./recent-changes.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const HOUR = 3_600_000;
const SEED = { seed: 42, numRuns: 200 };

function mustWindow(input: { hours?: number; since?: string }): Window {
  const r = resolveWindow(input, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.window;
}

const ver = (number: number, whenMs: number, name = "A. Editor"): VersionMetadata => ({
  number,
  by: { displayName: name, accountId: `acc-${name}` },
  when: new Date(whenMs).toISOString(),
  message: "",
  minorEdit: false,
});

const hit = (over: Partial<SearchHit> & { id: string }): SearchHit => ({
  title: "Page",
  type: "page",
  spaceKey: "DOCS",
  ...over,
});

describe("resolveWindow", () => {
  it("accepts hours", () => {
    const w = mustWindow({ hours: 24 });
    expect(w.sinceMs).toBe(NOW - 24 * HOUR);
    expect(w.label).toBe("24h");
    expect(w.cqlMinutes).toBe(24 * 60 + 10);
  });
  it("labels fractional hours", () => {
    expect(mustWindow({ hours: 1.5 }).label).toBe("1.5h");
  });
  it("rejects both and neither", () => {
    expect(resolveWindow({ hours: 1, since: "2026-10-06T00:00:00Z" }, NOW).ok).toBe(false);
    expect(resolveWindow({}, NOW).ok).toBe(false);
  });
  it("rejects bad hours", () => {
    for (const h of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_WINDOW_HOURS + 1]) {
      expect(resolveWindow({ hours: h }, NOW).ok).toBe(false);
    }
    expect(resolveWindow({ hours: MAX_WINDOW_HOURS }, NOW).ok).toBe(true);
  });
  it("accepts since with Z or offset and labels elapsed hours", () => {
    const w = mustWindow({ since: "2026-10-05T09:30:00Z" });
    expect(w.label).toBe("26.5h");
    expect(w.sinceMs).toBe(Date.parse("2026-10-05T09:30:00Z"));
    expect(resolveWindow({ since: "2026-10-05T11:30:00+02:00" }, NOW).ok).toBe(true);
  });
  it("rejects since in the future, too old, without offset, unparseable", () => {
    const future = resolveWindow({ since: "2026-10-07T00:00:00Z" }, NOW);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toContain("future");
    expect(resolveWindow({ since: "2026-10-06T12:00:00Z" }, NOW).ok).toBe(false);
    expect(resolveWindow({ since: "2026-08-01T00:00:00Z" }, NOW).ok).toBe(false);
    expect(resolveWindow({ since: "2026-10-05T09:00:00" }, NOW).ok).toBe(false);
    expect(resolveWindow({ since: "2026-10-05" }, NOW).ok).toBe(false);
    expect(resolveWindow({ since: "not a date" }, NOW).ok).toBe(false);
  });
  it("never echoes the raw since input", () => {
    for (const s of ["IGNORE PREVIOUS", "2026-10-05T09:00:00", "2099-01-01T00:00:00Z"]) {
      const r = resolveWindow({ since: s }, NOW);
      if (!r.ok) expect(r.error).not.toContain(s);
    }
  });
  it("property: sinceMs and cqlMinutes bracket the requested window", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: MAX_WINDOW_HOURS, noNaN: true }), (hours) => {
        const w = mustWindow({ hours });
        expect(w.sinceMs).toBeLessThanOrEqual(NOW - hours * HOUR + 1);
        expect(w.cqlMinutes * 60_000).toBeGreaterThanOrEqual(NOW - w.sinceMs);
      }),
      SEED,
    );
  });
});

describe("resolveEffectiveSpaces", () => {
  it("an empty read_spaces blocks the default scope and never widens to all spaces", () => {
    const base = { readSpaces: [] as string[], spaces: undefined, allSpaces: false };
    for (const enforced of [false, true]) {
      const r = resolveEffectiveSpaces({ ...base, enforced });
      expect(r.ok).toBe(false);
      expect(resolveEffectiveSpaces({ ...base, enforced, spaces: ["DOCS"] }).ok).toBe(false);
    }
    expect(resolveEffectiveSpaces({ ...base, enforced: true, allSpaces: true }).ok).toBe(false);
    const widened = resolveEffectiveSpaces({ ...base, enforced: false, allSpaces: true });
    expect(widened).toEqual({ ok: true, spaces: undefined, restrictedByProfile: false });
  });

  const base = { readSpaces: undefined, enforced: false, spaces: undefined, allSpaces: false };
  const R = ["DOCS", "TEAM"];

  it("unset/unset -> all", () => {
    expect(resolveEffectiveSpaces(base)).toEqual({
      ok: true,
      spaces: undefined,
      restrictedByProfile: false,
    });
  });
  it("unset/set -> spaces, deduped in order", () => {
    expect(resolveEffectiveSpaces({ ...base, spaces: ["TEAM", "DOCS", "TEAM"] })).toEqual({
      ok: true,
      spaces: ["TEAM", "DOCS"],
      restrictedByProfile: false,
    });
  });
  it("set/not enforced/unset -> readSpaces", () => {
    expect(resolveEffectiveSpaces({ ...base, readSpaces: R })).toEqual({
      ok: true,
      spaces: R,
      restrictedByProfile: true,
    });
  });
  it("set/not enforced/set -> intersection", () => {
    expect(resolveEffectiveSpaces({ ...base, readSpaces: R, spaces: ["TEAM", "~123abc"] })).toEqual({
      ok: true,
      spaces: ["TEAM"],
      restrictedByProfile: true,
    });
  });
  it("empty intersection errors, names allowed keys, suggests all_spaces", () => {
    const r = resolveEffectiveSpaces({ ...base, readSpaces: R, spaces: ["~123abc"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("DOCS");
      expect(r.error).toContain("TEAM");
      expect(r.error).toContain("all_spaces: true");
    }
  });
  it("set/not enforced/all_spaces -> spaces or all", () => {
    expect(resolveEffectiveSpaces({ ...base, readSpaces: R, allSpaces: true })).toEqual({
      ok: true,
      spaces: undefined,
      restrictedByProfile: false,
    });
    expect(
      resolveEffectiveSpaces({ ...base, readSpaces: R, allSpaces: true, spaces: ["~123abc"] }),
    ).toEqual({ ok: true, spaces: ["~123abc"], restrictedByProfile: false });
  });
  it("enforced, not a subset -> error naming allowed keys", () => {
    const r = resolveEffectiveSpaces({ ...base, readSpaces: R, enforced: true, spaces: ["DOCS", "~123abc"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("[DOCS, TEAM]");
  });
  it("enforced, subset or unset -> spaces or readSpaces", () => {
    expect(resolveEffectiveSpaces({ ...base, readSpaces: R, enforced: true, spaces: ["DOCS"] })).toEqual({
      ok: true,
      spaces: ["DOCS"],
      restrictedByProfile: true,
    });
    expect(resolveEffectiveSpaces({ ...base, readSpaces: R, enforced: true })).toEqual({
      ok: true,
      spaces: R,
      restrictedByProfile: true,
    });
  });
  it("enforced + all_spaces -> exact error", () => {
    const r = resolveEffectiveSpaces({ ...base, readSpaces: R, enforced: true, allSpaces: true, spaces: ["DOCS"] });
    expect(r).toEqual({
      ok: false,
      error:
        "This profile restricts search to spaces [DOCS, TEAM] (read_spaces_enforced); all_spaces is not permitted.",
    });
  });
  it("rejects empty spaces and bad keys without echoing them", () => {
    expect(resolveEffectiveSpaces({ ...base, spaces: [] }).ok).toBe(false);
    const bad = 'EVIL") OR space = "X';
    const r = resolveEffectiveSpaces({ ...base, spaces: ["DOCS", bad] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("EVIL");
  });
  it("validates keys before the table (even when enforced + all_spaces)", () => {
    const r = resolveEffectiveSpaces({ readSpaces: R, enforced: true, allSpaces: true, spaces: ["bad key"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("read_spaces_enforced");
  });
});

describe("buildRecentChangesCql", () => {
  const w: Window = { sinceMs: 0, cqlMinutes: 91, label: "1.5h" };
  it("includes both types by default", () => {
    expect(buildRecentChangesCql(w, undefined, true)).toBe(
      'type in (page, blogpost) AND lastmodified >= now("-91m") ORDER BY lastmodified DESC',
    );
  });
  it("pages only when blog posts are excluded", () => {
    expect(buildRecentChangesCql(w, undefined, false)).toBe(
      'type = page AND lastmodified >= now("-91m") ORDER BY lastmodified DESC',
    );
  });
  it("adds a space clause", () => {
    expect(buildRecentChangesCql(w, ["DOCS", "~123abc"], true)).toBe(
      'type in (page, blogpost) AND lastmodified >= now("-91m") AND space in ("DOCS","~123abc") ORDER BY lastmodified DESC',
    );
  });
  it("throws on an empty space list", () => {
    expect(() => buildRecentChangesCql(w, [], true)).toThrow();
  });
  it("property: fuzzed keys appear only escaped, quotes balance, scopeCql accepts it", () => {
    const keyArb = fc
      .array(fc.constantFrom("A", "b", '"', "\\", "'", " ", ")", "("), { minLength: 1, maxLength: 8 })
      .map((cs) => cs.join(""));
    fc.assert(
      fc.property(fc.array(keyArb, { minLength: 1, maxLength: 4 }), fc.boolean(), (keys, blog) => {
        const cql = buildRecentChangesCql(w, keys, blog);
        const m = /AND space in \((.*)\) ORDER BY/.exec(cql);
        expect(m).not.toBeNull();
        const expected = keys
          .map((k) => `"${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(",");
        expect(m?.[1]).toBe(expected);
        // Count unescaped quotes with a scan: must be even.
        let quotes = 0;
        for (let i = 0; i < cql.length; i++) {
          if (cql[i] === "\\") i++;
          else if (cql[i] === '"') quotes++;
        }
        expect(quotes % 2).toBe(0);
      }),
      SEED,
    );
    fc.assert(
      fc.property(fc.boolean(), (blog) => {
        expect(scopeCql(buildRecentChangesCql(w, undefined, blog), ["DOCS"]).ok).toBe(true);
      }),
      SEED,
    );
  });
});

describe("hitModifiedMs / filterToWindow", () => {
  it("takes the later of lastModified and version.when", () => {
    const h = hit({
      id: "1",
      lastModified: "2026-10-06T08:00:00.000Z",
      version: { number: 2, when: "2026-10-06T08:00:00.500Z" },
    });
    expect(hitModifiedMs(h)).toBe(Date.parse("2026-10-06T08:00:00.500Z"));
  });
  it("ignores unparseable values and returns undefined when none parse", () => {
    expect(hitModifiedMs(hit({ id: "1", lastModified: "garbage", version: { number: 1, when: "2026-10-06T08:00:00Z" } }))).toBe(
      Date.parse("2026-10-06T08:00:00Z"),
    );
    expect(hitModifiedMs(hit({ id: "1", lastModified: "garbage" }))).toBeUndefined();
    expect(hitModifiedMs(hit({ id: "1" }))).toBeUndefined();
  });
  it("keeps boundary hits, drops older ones, keeps and counts undated", () => {
    const since = Date.parse("2026-10-06T08:00:00Z");
    const r = filterToWindow(
      [
        hit({ id: "edge", lastModified: "2026-10-06T08:00:00Z" }),
        hit({ id: "old", lastModified: "2026-10-06T07:59:59Z" }),
        hit({ id: "none" }),
      ],
      since,
    );
    expect(r.inWindow.map((h) => h.id)).toEqual(["edge", "none"]);
    expect(r.undated).toBe(1);
  });
});

describe("summariseVersions", () => {
  const since = NOW - 24 * HOUR;
  const recent = (n: number) => since + n * 1000;

  it("is a lower bound whenever every returned version is in the window, even below fetchLimit", () => {
    // The endpoint may honour a smaller page size than requested.
    const v = [25, 24, 23].map((n) => ver(n, recent(n)));
    const s = summariseVersions(v, since, 50);
    expect(s).toMatchObject({ kind: "edits", count: 3, atLeast: true, baseline: 22 });
  });

  it("names an editor with an empty display name as unknown user", () => {
    const v = [{ ...ver(5, recent(5)), by: { displayName: " ", accountId: "" } }, ver(4, since - 1000)];
    const s = summariseVersions(v, since, 50);
    expect(s).toMatchObject({ kind: "edits", editors: ["unknown user"] });
  });

  it("created in window", () => {
    const s = summariseVersions([ver(1, recent(1)), ver(2, recent(2), "B. Editor")], since, 50);
    expect(s).toEqual({
      kind: "edits",
      count: 2,
      atLeast: false,
      editors: ["B. Editor", "A. Editor"],
      moreEditors: 0,
      baseline: "created",
      current: 2,
    });
  });
  it("numeric baseline", () => {
    const s = summariseVersions([ver(12, since - 1000), ver(13, recent(1)), ver(14, recent(2))], since, 50);
    expect(s).toMatchObject({ kind: "edits", count: 2, baseline: 12, current: 14, atLeast: false });
  });
  it("atLeast at exactly fetchLimit when every version is in the window", () => {
    const vs = Array.from({ length: VERSION_FETCH_LIMIT }, (_, i) => ver(i + 20, recent(i)));
    const s = summariseVersions(vs, since, VERSION_FETCH_LIMIT);
    expect(s).toMatchObject({ kind: "edits", atLeast: true, count: 50, baseline: 19, current: 69 });
  });
  it("atLeast false when the batch includes v1", () => {
    const vs = Array.from({ length: VERSION_FETCH_LIMIT }, (_, i) => ver(i + 1, recent(i)));
    const s = summariseVersions(vs, since, VERSION_FETCH_LIMIT);
    expect(s).toMatchObject({ kind: "edits", atLeast: false, baseline: "created" });
  });
  it("atLeast false when some fetched version is outside the window", () => {
    const vs = [ver(5, since - 1000), ...Array.from({ length: 49 }, (_, i) => ver(i + 6, recent(i)))];
    expect(summariseVersions(vs, since, 50)).toMatchObject({ atLeast: false, baseline: 5 });
  });
  it("metadataOnly when nothing is in the window", () => {
    expect(summariseVersions([ver(3, since - 5000), ver(2, since - 9000)], since, 50)).toEqual({
      kind: "metadataOnly",
      current: 3,
    });
  });
  it("unavailable on empty list and on unparseable when", () => {
    expect(summariseVersions([], since, 50)).toEqual({ kind: "unavailable", reason: "no versions returned" });
    const bad: VersionMetadata = { ...ver(2, recent(1)), when: "yesterday-ish" };
    expect(summariseVersions([ver(1, recent(0)), bad], since, 50)).toEqual({
      kind: "unavailable",
      reason: "unreadable version times",
    });
  });
  it("caps editors at 3 and counts the rest", () => {
    const names = ["A", "B", "C", "D", "E"];
    const vs = names.map((n, i) => ver(i + 1, recent(i), n));
    expect(summariseVersions(vs, since, 50)).toMatchObject({
      editors: ["E", "D", "C"],
      moreEditors: 2,
    });
  });
  it("property: baseline/count invariants and order independence", () => {
    const arb = fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 30 }).chain((nums) =>
      fc.tuple(
        fc.constant(nums),
        fc.array(fc.integer({ min: -48, max: 24 }), { minLength: nums.length, maxLength: nums.length }),
        fc.array(fc.constantFrom("A. Editor", "B. Editor", "C. Editor", "D. Editor"), {
          minLength: nums.length,
          maxLength: nums.length,
        }),
      ),
    );
    fc.assert(
      fc.property(arb, fc.integer(), ([nums, offsets, names], salt) => {
        // Monotone times so that higher number = later, as in real data.
        const sorted = [...nums].sort((a, b) => a - b);
        const times = [...offsets].sort((a, b) => a - b);
        const vs = sorted.map((n, i) => ver(n, since + times[i] * HOUR, names[i]));
        const s = summariseVersions(vs, since, 50);
        const inWin = vs.filter((v) => Date.parse(v.when) >= since);
        if (s.kind === "edits") {
          expect(s.count).toBe(inWin.length);
          const base = s.baseline === "created" ? 0 : s.baseline;
          for (const v of inWin) {
            expect(v.number).toBeGreaterThan(base);
            expect(v.number).toBeLessThanOrEqual(s.current);
          }
        } else {
          expect(s.kind).toBe("metadataOnly");
          expect(inWin.length).toBe(0);
        }
        const shuffled = [...vs].sort((a, b) => ((a.number * 2654435761 + salt) % 97) - ((b.number * 2654435761 + salt) % 97));
        expect(summariseVersions(shuffled, since, 50)).toEqual(s);
      }),
      SEED,
    );
  });
});

describe("condenseDiff", () => {
  const mk = (sections: { type: "added" | "removed" | "modified"; section: string; added: number; removed: number }[], summary = "S") =>
    ({ totalAdded: 0, totalRemoved: 0, sections, summary }) as Parameters<typeof condenseDiff>[0];
  it("formats modified, added, removed", () => {
    expect(
      condenseDiff(
        mk([
          { type: "modified", section: "Rollback", added: 4, removed: 1 },
          { type: "added", section: "Sign-off", added: 2, removed: 0 },
          { type: "removed", section: "Old", added: 0, removed: 3 },
        ]),
      ),
    ).toBe("Changed: Rollback (+4 −1), Sign-off (added), Old (removed)");
  });
  it("caps at 3 with +n more", () => {
    const secs = ["a", "b", "c", "d", "e"].map((s) => ({ type: "added" as const, section: s, added: 1, removed: 0 }));
    expect(condenseDiff(mk(secs))).toBe("Changed: a (added), b (added), c (added) +2 more");
  });
  it("falls back to the summary when there are no sections", () => {
    expect(condenseDiff(mk([], "Content unchanged"))).toBe("Changed: Content unchanged");
  });
});

describe("formatReport", () => {
  const w: Window = { sinceMs: Date.parse("2026-10-05T09:00:00Z"), cqlMinutes: 1, label: "24h" };
  const fence: Fence = (c) => `<<F>>${c}<</F>>`;
  const clean = (s: string) => s.replace(/\s+/g, " ");
  const input = (over: Partial<ReportInput> = {}): ReportInput => ({
    window: w,
    spaces: ["DOCS", "TEAM"],
    entries: [],
    more: false,
    limit: 50,
    diffsSkipped: 0,
    undated: 0,
    tenantEcho: "[tenant: example.com]",
    ...over,
  });
  const entry = (over: Partial<ReportEntry> & { id?: string; spaceKey?: string; type?: "page" | "blogpost"; title?: string } = {}): ReportEntry => {
    const { id = "100", spaceKey = "DOCS", type = "page", title = "Title", ...rest } = over;
    return {
      hit: { id, title, type, spaceKey, version: { number: 14 } },
      modifiedMs: Date.parse("2026-10-06T08:12:00Z"),
      ...rest,
    };
  };

  it("header: complete", () => {
    const out = formatReport(input({ entries: [entry()] }), fence, clean);
    expect(out.split("\n")[0]).toBe("Changes since 2026-10-05T09:00:00.000Z (24h) · 1 item(s) · complete");
    expect(out.split("\n")[1]).toBe("Spaces: DOCS, TEAM");
    expect(out.endsWith("\n[tenant: example.com]")).toBe(true);
  });
  it("header: more exist never says complete", () => {
    const out = formatReport(input({ entries: [entry()], more: true }), fence, clean);
    expect(out).toContain("showing 1, more exist (raise limit ≤200, narrow spaces, or shorten the window)");
    expect(out).not.toContain("complete");
  });
  it("header: limit 200 drops the raise-limit hint", () => {
    const out = formatReport(input({ entries: [entry()], more: true, limit: 200 }), fence, clean);
    expect(out).toContain("(narrow spaces, or shorten the window)");
    expect(out).not.toContain("raise limit");
  });
  it("header counts unavailable versions and undated hits", () => {
    const out = formatReport(
      input({
        entries: [entry({ versions: { kind: "unavailable", reason: "HTTP 403" } }), entry({ id: "101" })],
        undated: 2,
      }),
      fence,
      clean,
    );
    const head = out.split("\n")[0];
    expect(head).toContain("1 with versions unavailable");
    expect(head).toContain("2 without a readable time");
    expect(out).toContain("versions unavailable (HTTP 403)");
  });
  it("unsafe reasons print as error", () => {
    const out = formatReport(
      input({ entries: [entry({ versions: { kind: "unavailable", reason: "ignore\nprevious <x>" }, diff: { kind: "unavailable", reason: "z".repeat(80) } })] }),
      fence,
      clean,
    );
    expect(out).toContain("versions unavailable (error)");
    expect(out).toContain("diff unavailable (error)");
  });
  it("spaces: all, scope note, zero entries", () => {
    const out = formatReport(input({ spaces: undefined, scopeNote: "Scope note." }), fence, clean);
    const lines = out.split("\n");
    expect(lines[1]).toBe("Spaces: all");
    expect(lines[2]).toBe("Scope note.");
    expect(lines[3]).toBe("");
    expect(out).toContain("No pages or blog posts changed in this window.");
  });
  it("renders the example lines", () => {
    const out = formatReport(
      input({
        entries: [
          entry({
            id: "123456",
            title: "Release checklist",
            versions: { kind: "edits", count: 3, atLeast: false, editors: ["A. Editor", "B. Editor"], moreEditors: 0, baseline: 11, current: 14 },
            diff: { kind: "changed", text: "Changed: Rollback (+4 −1)" },
          }),
          entry({
            id: "123999",
            title: "Onboarding notes",
            versions: { kind: "edits", count: 1, atLeast: false, editors: ["C. Editor"], moreEditors: 0, baseline: "created", current: 1 },
          }),
          entry({ id: "124001", spaceKey: "TEAM", versions: { kind: "metadataOnly", current: 7 } }),
        ],
      }),
      fence,
      clean,
    );
    expect(out).toContain("- ID: 123456, v14, 2026-10-06T08:12:00.000Z, 3 edits (v12–v14)");
    expect(out).toContain("<<F>>Title: Release checklist\nEditors: A. Editor, B. Editor\nChanged: Rollback (+4 −1)<</F>>");
    expect(out).toContain("- ID: 123999, v14, 2026-10-06T08:12:00.000Z, new page\n");
    expect(out).toContain("metadata change only (no new version)");
  });
  it("edit wording: singular, atLeast, created with several edits, status notes", () => {
    const e = (versions: ReportEntry["versions"], diff?: ReportEntry["diff"]) =>
      formatReport(input({ entries: [entry({ versions, diff })] }), fence, clean);
    expect(e({ kind: "edits", count: 1, atLeast: false, editors: [], moreEditors: 0, baseline: 13, current: 14 })).toContain(", 1 edit (v14)");
    expect(e({ kind: "edits", count: 50, atLeast: true, editors: [], moreEditors: 0, baseline: 19, current: 69 })).toContain(", ≥50 edits (v20–v69)");
    expect(e({ kind: "edits", count: 3, atLeast: false, editors: [], moreEditors: 0, baseline: "created", current: 3 })).toContain(", new page, 3 edits (v1–v3)");
    expect(e(undefined, { kind: "tooLarge" })).toContain(", too large to diff");
  });
  it("editors cap prints +n more", () => {
    const out = formatReport(
      input({ entries: [entry({ versions: { kind: "edits", count: 5, atLeast: false, editors: ["A", "B", "C"], moreEditors: 2, baseline: 1, current: 6 } })] }),
      fence,
      clean,
    );
    expect(out).toContain("Editors: A, B, C +2 more");
  });
  it("[blog] marker and unknown time", () => {
    const out = formatReport(input({ entries: [entry({ type: "blogpost", modifiedMs: undefined })] }), fence, clean);
    expect(out).toContain("- ID: 100 [blog], v14, time unknown");
  });
  it("orders groups, newest first, ties by id, unknown space last, undefined time last", () => {
    const t = (s: string) => Date.parse(s);
    const out = formatReport(
      input({
        entries: [
          entry({ id: "9", spaceKey: "TEAM" }),
          { hit: { id: "8", title: "x", type: "page" }, modifiedMs: t("2026-10-06T10:00:00Z") },
          entry({ id: "3", modifiedMs: t("2026-10-06T07:00:00Z") }),
          entry({ id: "2", modifiedMs: t("2026-10-06T09:00:00Z") }),
          entry({ id: "1", modifiedMs: t("2026-10-06T09:00:00Z") }),
          entry({ id: "4", modifiedMs: undefined }),
        ],
      }),
      fence,
      clean,
    );
    const order = out
      .split("\n")
      .filter((l) => /^(- ID: |DOCS$|TEAM$|\(unknown space\)$)/.test(l))
      .map((l) => l.replace(/^- ID: (\d+).*$/, "id$1"));
    expect(order).toEqual(["DOCS", "id1", "id2", "id3", "id4", "TEAM", "id9", "(unknown space)", "id8"]);
  });
  it("printed ID order equals sortEntries order", () => {
    const t = (s: string) => Date.parse(s);
    const entries = [
      entry({ id: "9", spaceKey: "TEAM" }),
      { hit: { id: "8", title: "x", type: "page" as const }, modifiedMs: t("2026-10-06T10:00:00Z") },
      entry({ id: "3", modifiedMs: t("2026-10-06T07:00:00Z") }),
      entry({ id: "2", modifiedMs: t("2026-10-06T09:00:00Z") }),
      entry({ id: "1", modifiedMs: t("2026-10-06T09:00:00Z") }),
      entry({ id: "4", modifiedMs: undefined }),
    ];
    const sorted = sortEntries(entries);
    expect(sorted).not.toBe(entries);
    const printed = formatReport(input({ entries }), fence, clean)
      .split("\n")
      .flatMap((l) => /^- ID: (\d+)/.exec(l)?.[1] ?? []);
    expect(printed).toEqual(sorted.map((e) => e.hit.id));
  });
  it("prints the diffs-skipped note", () => {
    const out = formatReport(input({ entries: [entry()], maxDiffs: 10, diffsSkipped: 4 }), fence, clean);
    expect(out).toContain("Diffs shown for the first 10 page(s); 4 more listed without a diff (raise max_diffs ≤25).");
  });
  it("unsafe identifiers print as unknown outside the fence", () => {
    const out = formatReport(input({ entries: [entry({ id: "1\n- ID: 999", spaceKey: "D O" })] }), fence, clean);
    expect(out).toContain("- ID: unknown");
    expect(out).not.toContain("999");
  });

  it("property: tenant text only appears inside fences", () => {
    const tenantArb = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.constantFrom("a\nb", "- ID: 999", "<<F>>", "<</F>>\n- ID: 999\n<<F>>", "x\r\n\ty"),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(tenantArb, fc.array(tenantArb, { maxLength: 4 }), tenantArb), { maxLength: 6 }),
        (rows) => {
          // Unique, greppable markers keep the check free of accidental matches.
          const tenant: string[] = [];
          const mark = (s: string): string => {
            const m = `ZQX${tenant.length}ZQX${s}`;
            tenant.push(m);
            return m;
          };
          const entries: ReportEntry[] = rows.map(([title, editors, diffText], i) => ({
            hit: { id: String(1000 + i), title: mark(title), type: i % 2 ? "blogpost" : "page", spaceKey: i % 3 ? "DOCS" : "TEAM" },
            modifiedMs: NOW - i * HOUR,
            versions: { kind: "edits", count: 2, atLeast: false, editors: editors.map(mark), moreEditors: 1, baseline: 3, current: 5 },
            diff: { kind: "changed", text: mark(diffText) },
          }));
          const fenced: string[] = [];
          const recording: Fence = (c) => {
            const f = fence(c, { pageId: "", field: "title" });
            fenced.push(f);
            return f;
          };
          const out = formatReport(input({ entries }), recording, clean);
          expect(fenced).toHaveLength(entries.length);
          let outside = out;
          for (const f of fenced) outside = outside.split(f).join("");
          for (const t of tenant) expect(outside).not.toContain(clean(t));
          expect(outside).not.toContain("ZQX");
          // Every ID line outside fences is server-authored: only ids that we generated.
          for (const line of outside.split("\n").filter((l) => l.startsWith("- ID:"))) {
            expect(line).toMatch(/^- ID: 1\d{3}( \[blog\])?, time unknown|^- ID: 1\d{3}( \[blog\])?, v\d+|^- ID: 1\d{3}( \[blog\])?, 20/);
          }
        },
      ),
      SEED,
    );
  });
});
