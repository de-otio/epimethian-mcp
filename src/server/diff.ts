import { diffLines, createTwoFilesPatch } from "diff";
import {
  macroNamesPerLine,
  splitStorageBlocks,
  stripVolatileAttributes,
} from "./storage-normalise.js";

export const MAX_DIFF_SIZE = 500 * 1024; // 500KB

/**
 * Caps on the storage comparison, applied to the normalised input BEFORE any
 * diffing (a line diff is quadratic in the number of changed lines, so the
 * output cap alone does not bound the work). Block splitting adds a newline
 * per block tag, so the size cap is a multiple of the raw cap.
 */
export const MAX_STORAGE_DIFF_CHARS = 2 * MAX_DIFF_SIZE;
export const MAX_STORAGE_DIFF_LINES = 20_000;
/** Deterministic abort for the line diff (an edit count, not a clock). */
export const MAX_STORAGE_EDIT_LENGTH = 2_000;
/** Macro names listed in a summary; the rest are only counted. */
export const MAX_REPORTED_MACROS = 20;

export interface SectionChange {
  type: "added" | "removed" | "modified";
  section: string;
  added: number;
  removed: number;
}

export interface StorageChangeSummary {
  /** The normalised storage of the two versions differs. */
  changed: boolean;
  /** Changed regions; undefined when the pages were too different to itemise. */
  changes?: number;
  /** Macros the changed regions belong to (alphabet `[A-Za-z0-9_-]` only, at most MAX_REPORTED_MACROS). */
  macros: string[];
  /** Macros beyond the cap, counted but not named. */
  moreMacros: number;
}

export interface DiffSummaryResult {
  totalAdded: number;
  totalRemoved: number;
  sections: SectionChange[];
  summary: string;
  /** Present when storage was supplied and the text diff was empty. */
  storage?: StorageChangeSummary;
}

export interface DiffUnifiedResult {
  diff: string;
  truncated: boolean;
}

interface Section {
  /** Name shown to the caller: the heading text, plus the occurrence number from the 2nd on. */
  label: string;
  content: string;
}

/**
 * Split markdown text into sections by headings. Content before any heading is
 * the "(intro)" section.
 *
 * Sections are keyed by heading text AND occurrence (the 1st `# Notes`, the 2nd
 * `# Notes`, ...), so two sections with the same heading cannot overwrite each
 * other and hide a change in one of them. The intro has its own key, so a
 * heading that reads "(intro)" cannot collide with it.
 */
function splitBySections(text: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  const seen = new Map<string, number>();
  const lines = text.split("\n");
  let current: { key: string; label: string } = { key: "intro", label: "(intro)" };
  let currentLines: string[] = [];

  const flush = (): void => {
    sections.set(current.key, { label: current.label, content: currentLines.join("\n") });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0 || current.key !== "intro") flush();
      const heading = headingMatch[2].trim();
      const occurrence = (seen.get(heading) ?? 0) + 1;
      seen.set(heading, occurrence);
      current = {
        key: `heading:${occurrence}:${heading}`,
        label: occurrence === 1 ? heading : `${heading} (#${occurrence})`,
      };
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const content = currentLines.join("\n");
  if (content.trim().length > 0 || current.key !== "intro") flush();

  return sections;
}

/**
 * Compute a section-aware diff summary between two markdown texts.
 */
export function computeSummaryDiff(
  textA: string,
  textB: string,
  storage?: { a: string; b: string }
): DiffSummaryResult {
  const sectionsA = splitBySections(textA);
  const sectionsB = splitBySections(textB);

  const allKeys = new Set([...sectionsA.keys(), ...sectionsB.keys()]);
  const changes: SectionChange[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const key of allKeys) {
    const secA = sectionsA.get(key);
    const secB = sectionsB.get(key);
    const contentA = secA?.content;
    const contentB = secB?.content;
    const label = (secB ?? secA)!.label;

    if (contentA === undefined && contentB !== undefined) {
      const lines = contentB.split("\n").filter((l) => l.trim()).length;
      changes.push({ type: "added", section: label, added: lines, removed: 0 });
      totalAdded += lines;
    } else if (contentA !== undefined && contentB === undefined) {
      const lines = contentA.split("\n").filter((l) => l.trim()).length;
      changes.push({
        type: "removed",
        section: label,
        added: 0,
        removed: lines,
      });
      totalRemoved += lines;
    } else if (contentA !== undefined && contentB !== undefined) {
      if (contentA === contentB) continue;

      const diffs = diffLines(contentA, contentB);
      let added = 0;
      let removed = 0;
      for (const part of diffs) {
        const lines = part.value.split("\n").filter((l) => l.trim()).length;
        if (part.added) added += lines;
        if (part.removed) removed += lines;
      }
      if (added > 0 || removed > 0) {
        changes.push({ type: "modified", section: label, added, removed });
        totalAdded += added;
        totalRemoved += removed;
      }
    }
  }

  // Build human-readable summary
  let summary: string;
  let storageChanges: StorageChangeSummary | undefined;
  if (totalAdded === 0 && totalRemoved === 0) {
    // The markdown view hides macro internals and attributes, so an empty
    // text diff is not proof of "no changes". Compare the storage too.
    storageChanges = storage ? computeStorageChanges(storage.a, storage.b) : undefined;
    if (storageChanges?.changed) {
      summary = describeStorageOnlyChange(storageChanges);
    } else {
      summary = "No changes.";
      storageChanges = undefined;
    }
  } else {
    const parts: string[] = [];
    if (totalAdded > 0) parts.push(`${totalAdded} lines added`);
    if (totalRemoved > 0) parts.push(`${totalRemoved} lines removed`);
    summary = parts.join(", ");
    if (changes.length > 0) {
      // Section names are tenant-authored heading text. The summary is shown
      // outside any fence, so it carries counts only; the caller lists the
      // names inside a fence.
      summary += `; ${changes.length} section(s) changed (listed below)`;
    }
  }

  return {
    totalAdded,
    totalRemoved,
    sections: changes,
    summary,
    ...(storageChanges ? { storage: storageChanges } : {}),
  };
}

function describeStorageOnlyChange(sc: StorageChangeSummary): string {
  if (sc.changes === undefined) {
    return "No text changes; the page storage differs in more places than can be itemised.";
  }
  const n = sc.changes;
  const head = `No text changes; ${n} macro/attribute change${n === 1 ? "" : "s"}`;
  // The macro names themselves are added by the caller, inside a fence.
  return sc.macros.length > 0 ? `${head} in:` : `${head}.`;
}

// ---------------------------------------------------------------------------
// Storage comparison (S6)
// ---------------------------------------------------------------------------

/** Volatile attributes stripped, then split at block-tag boundaries for line diffing. */
function normaliseStorageForDiff(storage: string): string {
  return splitStorageBlocks(stripVolatileAttributes(storage));
}

function overStorageCaps(normalised: string): boolean {
  if (normalised.length > MAX_STORAGE_DIFF_CHARS) return true;
  let lines = 1;
  for (let i = normalised.indexOf("\n"); i !== -1; i = normalised.indexOf("\n", i + 1)) {
    if (++lines > MAX_STORAGE_DIFF_LINES) return true;
  }
  return false;
}

/**
 * Compare two storage bodies after dropping regenerated ids. Reports how many
 * regions changed and which macros they belong to. When the inputs are over
 * the caps, or too different for the capped line diff, it says only that they
 * differ.
 */
export function computeStorageChanges(storageA: string, storageB: string): StorageChangeSummary {
  const a = normaliseStorageForDiff(storageA);
  const b = normaliseStorageForDiff(storageB);
  if (a === b) return { changed: false, changes: 0, macros: [], moreMacros: 0 };
  if (overStorageCaps(a) || overStorageCaps(b)) {
    return { changed: true, macros: [], moreMacros: 0 };
  }

  const parts = diffLines(a, b, { maxEditLength: MAX_STORAGE_EDIT_LENGTH });
  if (parts === undefined) return { changed: true, macros: [], moreMacros: 0 };

  const namesA = macroNamesPerLine(a.split("\n"));
  const namesB = macroNamesPerLine(b.split("\n"));
  const macros = new Set<string>();
  let aIdx = 0;
  let bIdx = 0;
  let regions = 0;
  let inRegion = false;
  for (const part of parts) {
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      aIdx += count;
      bIdx += count;
      inRegion = false;
      continue;
    }
    if (!inRegion) regions++;
    inRegion = true;
    const names = part.removed ? namesA : namesB;
    const from = part.removed ? aIdx : bIdx;
    for (let i = from; i < from + count; i++) {
      for (const name of names[i] ?? []) macros.add(name);
    }
    if (part.removed) aIdx += count;
    else bIdx += count;
  }

  const all = [...macros];
  return {
    changed: true,
    changes: regions,
    macros: all.slice(0, MAX_REPORTED_MACROS),
    moreMacros: Math.max(0, all.length - MAX_REPORTED_MACROS),
  };
}

export interface StorageDiffResult extends DiffUnifiedResult {
  /** The normalised storage is identical (only regenerated ids differ, or nothing). */
  identical: boolean;
  /** Not diffed: over the caps, or too different for the capped line diff. */
  tooLarge: boolean;
}

/**
 * Unified diff of the normalised storage of two versions: regenerated ids
 * removed, one block per line. Inputs are capped before diffing.
 */
export function computeStorageDiff(
  storageA: string,
  storageB: string,
  maxLength?: number
): StorageDiffResult {
  const a = normaliseStorageForDiff(storageA);
  const b = normaliseStorageForDiff(storageB);
  if (a === b) return { diff: "", truncated: false, identical: true, tooLarge: false };

  const tooLarge = (): StorageDiffResult => ({
    diff:
      `[storage diff not computed: the versions differ too much or are too large ` +
      `(limits: ${MAX_STORAGE_DIFF_LINES} lines, ${MAX_STORAGE_EDIT_LENGTH} changed lines). ` +
      `Use get_page_version to read the versions individually.]`,
    truncated: false,
    identical: false,
    tooLarge: true,
  });
  if (overStorageCaps(a) || overStorageCaps(b)) return tooLarge();

  const patch = createTwoFilesPatch("version-a", "version-b", a, b, undefined, undefined, {
    context: 3,
    maxEditLength: MAX_STORAGE_EDIT_LENGTH,
  });
  if (patch === undefined) return tooLarge();

  if (maxLength !== undefined && patch.length > maxLength) {
    return {
      diff: patch.slice(0, maxLength) +
        `\n[truncated at ${maxLength} of ${patch.length} characters]`,
      truncated: true,
      identical: false,
      tooLarge: false,
    };
  }
  return { diff: patch, truncated: false, identical: false, tooLarge: false };
}

/**
 * Compute a unified diff between two texts, with optional truncation.
 */
export function computeUnifiedDiff(
  textA: string,
  textB: string,
  maxLength?: number
): DiffUnifiedResult {
  const patch = createTwoFilesPatch(
    "version-a",
    "version-b",
    textA,
    textB,
    undefined,
    undefined,
    { context: 3 }
  );

  if (maxLength !== undefined && patch.length > maxLength) {
    return {
      diff: patch.slice(0, maxLength) +
        `\n[truncated at ${maxLength} of ${patch.length} characters]`,
      truncated: true,
    };
  }

  return { diff: patch, truncated: false };
}
