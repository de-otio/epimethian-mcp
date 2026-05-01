import { diffLines, createTwoFilesPatch } from "diff";

export const MAX_DIFF_SIZE = 500 * 1024; // 500KB

export interface SectionChange {
  type: "added" | "removed" | "modified";
  section: string;
  added: number;
  removed: number;
}

export interface DiffSummaryResult {
  totalAdded: number;
  totalRemoved: number;
  sections: SectionChange[];
  summary: string;
}

export interface DiffUnifiedResult {
  diff: string;
  truncated: boolean;
}

/**
 * Split markdown text into named sections by headings.
 * Content before any heading is keyed as "(intro)".
 */
function splitBySections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split("\n");
  let currentKey = "(intro)";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0 || currentKey !== "(intro)") {
        sections.set(currentKey, currentLines.join("\n"));
      }
      currentKey = headingMatch[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const content = currentLines.join("\n");
  if (content.trim().length > 0 || currentKey !== "(intro)") {
    sections.set(currentKey, content);
  }

  return sections;
}

/**
 * Compute a section-aware diff summary between two markdown texts.
 */
export function computeSummaryDiff(
  textA: string,
  textB: string
): DiffSummaryResult {
  const sectionsA = splitBySections(textA);
  const sectionsB = splitBySections(textB);

  const allKeys = new Set([...sectionsA.keys(), ...sectionsB.keys()]);
  const changes: SectionChange[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const key of allKeys) {
    const contentA = sectionsA.get(key);
    const contentB = sectionsB.get(key);

    if (contentA === undefined && contentB !== undefined) {
      const lines = contentB.split("\n").filter((l) => l.trim()).length;
      changes.push({ type: "added", section: key, added: lines, removed: 0 });
      totalAdded += lines;
    } else if (contentA !== undefined && contentB === undefined) {
      const lines = contentA.split("\n").filter((l) => l.trim()).length;
      changes.push({
        type: "removed",
        section: key,
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
        changes.push({ type: "modified", section: key, added, removed });
        totalAdded += added;
        totalRemoved += removed;
      }
    }
  }

  // Build human-readable summary
  let summary: string;
  if (totalAdded === 0 && totalRemoved === 0) {
    summary = "No changes.";
  } else {
    const parts: string[] = [];
    if (totalAdded > 0) parts.push(`${totalAdded} lines added`);
    if (totalRemoved > 0) parts.push(`${totalRemoved} lines removed`);
    summary = parts.join(", ");
    if (changes.length > 0) {
      const sectionNames = changes.map((c) => c.section).join(", ");
      summary += `. Changes in sections: ${sectionNames}`;
    }
  }

  return { totalAdded, totalRemoved, sections: changes, summary };
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
