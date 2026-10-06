/**
 * Pure core of `get_recent_changes`.
 *
 * Everything here is a function of its arguments: no I/O, no clock reads (the
 * caller passes `nowMs`), no network. The handler owns fetching; this module
 * owns the decisions that must be right and testable:
 *
 *   - the time window, and the relative CQL bound derived from it (CQL reads
 *     absolute dates in the viewer's profile timezone, so only a relative
 *     `now("-Nm")` is ever sent; the exact cut is applied afterwards);
 *   - which spaces are searched, under the profile's `read_spaces` scoping;
 *   - how a page's version list is summarised for the window;
 *   - the report text, in which tenant-authored strings (titles, editor
 *     names, section names) appear only inside a fence.
 *
 * Honesty rules: a page that CQL matched is never dropped for lack of data
 * (it is reported as undated / metadata-only / unavailable), and the header
 * only says `complete` when no more results exist.
 */

import { escapeCqlString } from "./confluence-client.js";
import type { SearchHit, VersionMetadata } from "./confluence-client.js";
import { safeIdentifier } from "./search-redact.js";
import type { computeSummaryDiff } from "./diff.js";

export const MAX_WINDOW_HOURS = 720;
export const VERSION_FETCH_LIMIT = 50;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/**
 * Extra minutes on the CQL bound. Covers clock skew between this host and
 * Confluence; the exact cut is applied afterwards, and only hits inside this
 * band are dropped by it (see filterToWindow).
 */
export const CQL_SLACK_MINUTES = 10;
const MAX_LIMIT = 200;
const MAX_EDITORS = 3;
const MAX_DIFF_ITEMS = 3;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export type Window = {
  readonly sinceMs: number;
  readonly cqlMinutes: number;
  readonly label: string;
};

type WindowResult =
  | { readonly ok: true; readonly window: Window }
  | { readonly ok: false; readonly error: string };

const EXPLICIT_OFFSET_RE = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i;

const windowFrom = (sinceMs: number, nowMs: number, label: string): Window => ({
  sinceMs,
  cqlMinutes: Math.ceil((nowMs - sinceMs) / MINUTE_MS) + CQL_SLACK_MINUTES,
  label,
});

export function resolveWindow(
  input: { readonly hours?: number; readonly since?: string },
  nowMs: number,
): WindowResult {
  const { hours, since } = input;
  if ((hours === undefined) === (since === undefined)) {
    return { ok: false, error: "Provide exactly one of hours or since." };
  }
  if (hours !== undefined) {
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, error: "hours must be a positive number." };
    }
    if (hours > MAX_WINDOW_HOURS) {
      return { ok: false, error: `hours must be at most ${MAX_WINDOW_HOURS} (30 days).` };
    }
    const sinceMs = nowMs - Math.round(hours * HOUR_MS);
    return { ok: true, window: windowFrom(sinceMs, nowMs, `${hours}h`) };
  }
  const text = since as string;
  const sinceMs = Date.parse(text);
  if (Number.isNaN(sinceMs)) {
    return { ok: false, error: "since is not a valid ISO 8601 date-time." };
  }
  if (!EXPLICIT_OFFSET_RE.test(text.trim())) {
    return {
      ok: false,
      error: "since needs an explicit UTC offset or Z (for example 2030-01-01T00:00:00Z).",
    };
  }
  if (sinceMs >= nowMs) {
    return { ok: false, error: "since is in the future." };
  }
  if (nowMs - sinceMs > MAX_WINDOW_HOURS * HOUR_MS) {
    return { ok: false, error: `since is more than ${MAX_WINDOW_HOURS} hours ago (30 days).` };
  }
  const elapsedHours = Math.round(((nowMs - sinceMs) / HOUR_MS) * 10) / 10;
  return { ok: true, window: windowFrom(sinceMs, nowMs, `${elapsedHours}h`) };
}

// ---------------------------------------------------------------------------
// Space scoping
// ---------------------------------------------------------------------------

const SPACE_KEY_RE = /^[A-Za-z0-9_~-]{1,255}$/;

type SpacesResult =
  | {
      readonly ok: true;
      readonly spaces: readonly string[] | undefined;
      readonly restrictedByProfile: boolean;
    }
  | { readonly ok: false; readonly error: string };

const dedupe = (keys: readonly string[]): readonly string[] => [...new Set(keys)];
const listKeys = (keys: readonly string[]): string => `[${keys.join(", ")}]`;
const fail = (error: string): SpacesResult => ({ ok: false, error });
const spacesOk = (
  spaces: readonly string[] | undefined,
  restrictedByProfile: boolean,
): SpacesResult => ({ ok: true, spaces, restrictedByProfile });

export function resolveEffectiveSpaces(input: {
  readonly readSpaces: readonly string[] | undefined;
  readonly enforced: boolean;
  readonly spaces: readonly string[] | undefined;
  readonly allSpaces: boolean;
}): SpacesResult {
  const { enforced, allSpaces } = input;
  if (input.spaces !== undefined) {
    if (input.spaces.length === 0) {
      return fail("spaces must not be empty; omit it to use the default scope.");
    }
    if (input.spaces.some((k) => !SPACE_KEY_RE.test(k))) {
      return fail("spaces contains an invalid space key.");
    }
  }
  const spaces = input.spaces === undefined ? undefined : dedupe(input.spaces);
  // An empty read_spaces list is a configured scope with no spaces in it, as
  // in search_pages: it blocks scoped reports and never widens to all spaces.
  const readSpaces = input.readSpaces === undefined ? undefined : dedupe(input.readSpaces);

  if (readSpaces === undefined) return spacesOk(spaces, false);
  if (readSpaces.length === 0 && !(allSpaces && !enforced)) {
    return fail(
      "This profile's read_spaces is empty, so no spaces are configured for reports." +
        (enforced ? "" : " Pass all_spaces: true to report every space."),
    );
  }

  if (enforced) {
    if (allSpaces) {
      return fail(
        `This profile restricts search to spaces ${listKeys(readSpaces)} (read_spaces_enforced); all_spaces is not permitted.`,
      );
    }
    if (spaces === undefined) return spacesOk(readSpaces, true);
    if (!spaces.every((k) => readSpaces.includes(k))) {
      return fail(`This profile restricts search to spaces ${listKeys(readSpaces)}.`);
    }
    return spacesOk(spaces, true);
  }

  if (allSpaces) return spacesOk(spaces, false);
  if (spaces === undefined) return spacesOk(readSpaces, true);
  const common = spaces.filter((k) => readSpaces.includes(k));
  if (common.length === 0) {
    return fail(
      `None of the requested spaces are in this profile's default scope ${listKeys(readSpaces)}; pass all_spaces: true to search them.`,
    );
  }
  return spacesOk(common, true);
}

// ---------------------------------------------------------------------------
// CQL
// ---------------------------------------------------------------------------

export function buildRecentChangesCql(
  w: Window,
  spaces: readonly string[] | undefined,
  includeBlogposts: boolean,
): string {
  if (spaces !== undefined && spaces.length === 0) {
    throw new Error("buildRecentChangesCql: spaces must not be an empty array");
  }
  const type = includeBlogposts ? "type in (page, blogpost)" : "type = page";
  const time = `lastmodified >= now("-${w.cqlMinutes}m")`;
  const space =
    spaces === undefined
      ? ""
      : ` AND space in (${spaces.map((k) => `"${escapeCqlString(k)}"`).join(",")})`;
  return `${type} AND ${time}${space} ORDER BY lastmodified DESC`;
}

// ---------------------------------------------------------------------------
// Hit times
// ---------------------------------------------------------------------------

export function hitModifiedMs(hit: SearchHit): number | undefined {
  const times = [hit.lastModified, hit.version?.when]
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  return times.length === 0 ? undefined : Math.max(...times);
}

/**
 * Apply the exact window cut. Only hits inside the CQL slack band (just
 * before `sinceMs`) are dropped: that band is why they were returned. A hit
 * CQL matched with an older time, or with no readable time, is kept and
 * counted, never silently dropped.
 */
export function filterToWindow(
  hits: readonly SearchHit[],
  sinceMs: number,
): { inWindow: SearchHit[]; undated: number; older: number } {
  const slackStart = sinceMs - CQL_SLACK_MINUTES * MINUTE_MS;
  const inWindow: SearchHit[] = [];
  let undated = 0;
  let older = 0;
  for (const hit of hits) {
    const ms = hitModifiedMs(hit);
    if (ms === undefined) {
      undated++;
      inWindow.push(hit);
    } else if (ms >= sinceMs) {
      inWindow.push(hit);
    } else if (ms < slackStart) {
      older++;
      inWindow.push(hit);
    }
  }
  return { inWindow, undated, older };
}

// ---------------------------------------------------------------------------
// Version summary
// ---------------------------------------------------------------------------

export type VersionSummary =
  | {
      readonly kind: "edits";
      readonly count: number;
      readonly atLeast: boolean;
      readonly editors: readonly string[];
      readonly moreEditors: number;
      readonly baseline: number | "created";
      readonly current: number;
    }
  | { readonly kind: "metadataOnly"; readonly current: number }
  | { readonly kind: "unavailable"; readonly reason: string };

export function summariseVersions(
  v: readonly VersionMetadata[],
  sinceMs: number,
  fetchLimit: number,
): VersionSummary {
  if (v.length === 0) return { kind: "unavailable", reason: "no versions returned" };
  const timed = v.map((x) => ({ x, ms: Date.parse(x.when) }));
  if (timed.some((t) => Number.isNaN(t.ms))) {
    return { kind: "unavailable", reason: "unreadable version times" };
  }
  const sorted = [...timed].sort((a, b) => b.x.number - a.x.number);
  const current = sorted[0].x.number;
  const inWindow = sorted.filter((t) => t.ms >= sinceMs);
  if (inWindow.length === 0) return { kind: "metadataOnly", current };

  const lowest = Math.min(...inWindow.map((t) => t.x.number));
  // Every fetched version is in the window and v1 was not among them: earlier
  // in-window edits may exist beyond what the endpoint returned, whatever
  // page size it actually honoured, so the count is a lower bound.
  void fetchLimit;
  const atLeast = inWindow.length === v.length && lowest > 1;
  const distinct = [
    ...new Set(inWindow.map((t) => t.x.by.displayName.trim() || "unknown user")),
  ];
  return {
    kind: "edits",
    count: inWindow.length,
    atLeast,
    editors: distinct.slice(0, MAX_EDITORS),
    moreEditors: Math.max(0, distinct.length - MAX_EDITORS),
    baseline: lowest === 1 ? "created" : lowest - 1,
    current,
  };
}

// ---------------------------------------------------------------------------
// Diff condensing
// ---------------------------------------------------------------------------

export function condenseDiff(r: ReturnType<typeof computeSummaryDiff>): string {
  if (r.sections.length === 0) {
    return r.summary === "No changes." ? "No body changes between these versions." : `Changed: ${r.summary}`;
  }
  const item = (s: (typeof r.sections)[number]): string =>
    s.type === "modified"
      ? `${s.section} (+${s.added} −${s.removed})`
      : `${s.section} (${s.type})`;
  const shown = r.sections.slice(0, MAX_DIFF_ITEMS).map(item).join(", ");
  const more = r.sections.length - MAX_DIFF_ITEMS;
  return `Changed: ${shown}${more > 0 ? ` +${more} more` : ""}`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type DiffOutcome =
  | { readonly kind: "changed"; readonly text: string }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ReportEntry {
  readonly hit: SearchHit;
  readonly modifiedMs: number | undefined;
  readonly versions?: VersionSummary;
  readonly diff?: DiffOutcome;
}

export interface ReportInput {
  readonly window: Window;
  readonly spaces: readonly string[] | undefined;
  readonly scopeNote?: string;
  readonly entries: readonly ReportEntry[];
  readonly more: boolean;
  readonly limit: number;
  readonly maxDiffs?: number;
  readonly diffsSkipped: number;
  readonly undated: number;
  /** Hits CQL matched whose time is before the window (metadata change?). */
  readonly older?: number;
  /** Search results that were pages or blog posts but could not be read. */
  readonly unreadable?: number;
  readonly tenantEcho: string;
}

export type Fence = (content: string, attrs: { pageId: string; field: "title" }) => string;

const SAFE_REASON_RE = /^[A-Za-z0-9 ._()-]{1,40}$/;
const UNKNOWN_SPACE = "(unknown space)";

const safeReason = (reason: string): string => (SAFE_REASON_RE.test(reason) ? reason : "error");

const isoOrUndefined = (ms: number | undefined): string | undefined => {
  if (ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
};

const versionsText = (v: VersionSummary): string => {
  switch (v.kind) {
    case "metadataOnly":
      return ", metadata change only (no new version)";
    case "unavailable":
      return `, versions unavailable (${safeReason(v.reason)})`;
    case "edits": {
      if (v.baseline === "created") {
        return `, new page${v.count > 1 ? `, ${v.count} edits (v1–v${v.current})` : ""}`;
      }
      const noun = v.count === 1 ? "edit" : "edits";
      const span = v.baseline + 1 === v.current ? `v${v.current}` : `v${v.baseline + 1}–v${v.current}`;
      return `, ${v.atLeast ? "≥" : ""}${v.count} ${noun} (${span})`;
    }
  }
};

const diffStatus = (d: DiffOutcome | undefined): string => {
  if (d === undefined) return "";
  if (d.kind === "tooLarge") return ", too large to diff";
  if (d.kind === "unavailable") return `, diff unavailable (${safeReason(d.reason)})`;
  return "";
};

const entryLine = (e: ReportEntry): string => {
  const { hit } = e;
  const parts = [`- ID: ${safeIdentifier(hit.id)}`];
  if (hit.type === "blogpost") parts.push(" [blog]");
  const n = hit.version?.number;
  if (n !== undefined && Number.isSafeInteger(n)) parts.push(`, v${n}`);
  parts.push(`, ${isoOrUndefined(e.modifiedMs) ?? "time unknown"}`);
  if (e.versions !== undefined) parts.push(versionsText(e.versions));
  parts.push(diffStatus(e.diff));
  return parts.join("");
};

const entryBlock = (e: ReportEntry, clean: (s: string) => string): string => {
  const lines = [`Title: ${clean(e.hit.title)}`];
  if (e.versions?.kind === "edits") {
    const names = e.versions.editors.map(clean).join(", ");
    const more = e.versions.moreEditors > 0 ? ` +${e.versions.moreEditors} more` : "";
    lines.push(`Editors: ${names}${more}`);
  }
  if (e.diff?.kind === "changed") lines.push(clean(e.diff.text));
  return lines.join("\n");
};

const compareEntries = (a: ReportEntry, b: ReportEntry): number => {
  if (a.modifiedMs !== b.modifiedMs) {
    if (a.modifiedMs === undefined) return 1;
    if (b.modifiedMs === undefined) return -1;
    return b.modifiedMs - a.modifiedMs;
  }
  return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
};

const compareGroups = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a === UNKNOWN_SPACE) return 1;
  if (b === UNKNOWN_SPACE) return -1;
  return a < b ? -1 : 1;
};

const groupKey = (e: ReportEntry): string =>
  e.hit.spaceKey === undefined ? UNKNOWN_SPACE : safeIdentifier(e.hit.spaceKey);

/** Report order: space key ascending (unknown last), newest first, ties by id. */
export function sortEntries(entries: readonly ReportEntry[]): ReportEntry[] {
  return [...entries].sort(
    (a, b) => compareGroups(groupKey(a), groupKey(b)) || compareEntries(a, b),
  );
}

const headerLine = (input: ReportInput): string => {
  const { entries, window } = input;
  const n = entries.length;
  const parts = [
    `Changes since ${new Date(window.sinceMs).toISOString()} (${window.label})`,
    `${n} item(s)`,
  ];
  if (input.more) {
    const raise = input.limit >= MAX_LIMIT ? "" : `raise limit ≤${MAX_LIMIT}, `;
    parts.push(`showing ${n}, more exist (${raise}narrow spaces, or shorten the window)`);
  } else {
    parts.push("complete");
  }
  const unavailable = entries.filter((e) => e.versions?.kind === "unavailable").length;
  if (unavailable > 0) parts.push(`${unavailable} with versions unavailable`);
  const diffFailed = entries.filter((e) => e.diff?.kind === "unavailable").length;
  if (diffFailed > 0) parts.push(`${diffFailed} with diff unavailable`);
  if (input.undated > 0) parts.push(`${input.undated} without a readable time`);
  if ((input.older ?? 0) > 0) {
    parts.push(`${input.older} matched with an earlier time (metadata change?)`);
  }
  if ((input.unreadable ?? 0) > 0) {
    parts.push(`${input.unreadable} unreadable search result(s) not listed`);
  }
  return parts.join(" · ");
};

export function formatReport(
  input: ReportInput,
  fence: Fence,
  clean: (s: string) => string,
): string {
  const lines: string[] = [headerLine(input)];
  lines.push(
    input.spaces === undefined
      ? "Spaces: all"
      : `Spaces: ${input.spaces.map(safeIdentifier).join(", ")}`,
  );
  if (input.scopeNote !== undefined) lines.push(input.scopeNote);
  lines.push("");

  if (input.entries.length === 0) {
    lines.push("No pages or blog posts changed in this window.");
  } else {
    let current: string | undefined;
    for (const e of sortEntries(input.entries)) {
      const key = groupKey(e);
      if (key !== current) {
        lines.push(key);
        current = key;
      }
      lines.push(entryLine(e));
      lines.push(fence(entryBlock(e, clean), { pageId: e.hit.id, field: "title" }));
    }
  }

  if (input.diffsSkipped > 0) {
    lines.push(
      `Diffs shown for the first ${input.maxDiffs ?? 0} page(s); ${input.diffsSkipped} more listed without a diff (raise max_diffs ≤25).`,
    );
  }
  return `${lines.join("\n")}\n${input.tenantEcho}`;
}
