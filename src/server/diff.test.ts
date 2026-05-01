import { describe, it, expect } from "vitest";
import {
  MAX_DIFF_SIZE,
  computeSummaryDiff,
  computeUnifiedDiff,
} from "./diff.js";

describe("diff module", () => {
  // ---------------------------------------------------------------------------
  // computeSummaryDiff
  // ---------------------------------------------------------------------------
  describe("computeSummaryDiff", () => {
    it("identical texts produce 0 added, 0 removed, empty sections", () => {
      const text = "# Title\n\nSome content here.";
      const result = computeSummaryDiff(text, text);
      expect(result.totalAdded).toBe(0);
      expect(result.totalRemoved).toBe(0);
      expect(result.sections).toEqual([]);
      expect(result.summary).toBe("No changes.");
    });

    it("all new content (empty A) marks everything as added", () => {
      const result = computeSummaryDiff("", "# New\n\nNew content.");
      expect(result.totalAdded).toBeGreaterThan(0);
      expect(result.totalRemoved).toBe(0);
      expect(result.sections.every((s) => s.type === "added")).toBe(true);
    });

    it("all content removed (empty B) marks everything as removed", () => {
      const result = computeSummaryDiff("# Old\n\nOld content.", "");
      expect(result.totalRemoved).toBeGreaterThan(0);
      expect(result.totalAdded).toBe(0);
      expect(result.sections.every((s) => s.type === "removed")).toBe(true);
    });

    it("detects simple modification in one section", () => {
      const a = "# Pricing\n\n$10/month";
      const b = "# Pricing\n\n$20/month";
      const result = computeSummaryDiff(a, b);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].type).toBe("modified");
      expect(result.sections[0].section).toBe("Pricing");
    });

    it("handles multiple sections with mixed changes", () => {
      const a = "# A\n\nContent A\n\n# B\n\nContent B\n\n# C\n\nContent C";
      const b = "# A\n\nContent A changed\n\n# B\n\nContent B\n\n# D\n\nContent D";
      const result = computeSummaryDiff(a, b);

      const types = new Map(result.sections.map((s) => [s.section, s.type]));
      expect(types.get("A")).toBe("modified");
      expect(types.has("B")).toBe(false); // unchanged, not in sections
      expect(types.get("C")).toBe("removed");
      expect(types.get("D")).toBe("added");
    });

    it("puts content with no headings in (intro) section", () => {
      const a = "Hello world";
      const b = "Hello world changed";
      const result = computeSummaryDiff(a, b);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].section).toBe("(intro)");
      expect(result.sections[0].type).toBe("modified");
    });

    it("detects new section added in B", () => {
      const a = "# Existing\n\nContent";
      const b = "# Existing\n\nContent\n\n# New Section\n\nNew stuff";
      const result = computeSummaryDiff(a, b);
      const added = result.sections.find((s) => s.section === "New Section");
      expect(added).toBeDefined();
      expect(added!.type).toBe("added");
    });

    it("detects section removed in B", () => {
      const a = "# Keep\n\nContent\n\n# Remove Me\n\nGone";
      const b = "# Keep\n\nContent";
      const result = computeSummaryDiff(a, b);
      const removed = result.sections.find((s) => s.section === "Remove Me");
      expect(removed).toBeDefined();
      expect(removed!.type).toBe("removed");
    });

    it("both inputs empty produces no changes", () => {
      const result = computeSummaryDiff("", "");
      expect(result.totalAdded).toBe(0);
      expect(result.totalRemoved).toBe(0);
      expect(result.sections).toEqual([]);
      expect(result.summary).toBe("No changes.");
    });

    it("builds human-readable summary string with section names", () => {
      const a = "# A\n\nOld";
      const b = "# A\n\nNew";
      const result = computeSummaryDiff(a, b);
      expect(result.summary).toContain("lines added");
      expect(result.summary).toContain("Changes in sections: A");
    });
  });

  // ---------------------------------------------------------------------------
  // computeUnifiedDiff
  // ---------------------------------------------------------------------------
  describe("computeUnifiedDiff", () => {
    it("identical texts produce minimal diff (no hunks)", () => {
      const text = "Line 1\nLine 2\nLine 3";
      const result = computeUnifiedDiff(text, text);
      expect(result.truncated).toBe(false);
      // Unified diff of identical files has no @@ hunks
      expect(result.diff).not.toContain("@@");
    });

    it("simple change produces valid unified diff format", () => {
      const a = "Line 1\nLine 2\nLine 3";
      const b = "Line 1\nLine CHANGED\nLine 3";
      const result = computeUnifiedDiff(a, b);
      expect(result.diff).toContain("---");
      expect(result.diff).toContain("+++");
      expect(result.diff).toContain("-Line 2");
      expect(result.diff).toContain("+Line CHANGED");
      expect(result.truncated).toBe(false);
    });

    it("truncates when maxLength is exceeded and includes indicator", () => {
      const a = "A\n".repeat(100);
      const b = "B\n".repeat(100);
      const result = computeUnifiedDiff(a, b, 50);
      expect(result.truncated).toBe(true);
      expect(result.diff).toContain("[truncated at 50 of");
    });

    it("does not truncate when diff fits within maxLength", () => {
      const a = "Hello";
      const b = "World";
      const result = computeUnifiedDiff(a, b, 10000);
      expect(result.truncated).toBe(false);
      expect(result.diff).not.toContain("[truncated");
    });

    it("handles large diff truncation correctly", () => {
      const a = Array.from({ length: 500 }, (_, i) => `Line ${i}`).join("\n");
      const b = Array.from({ length: 500 }, (_, i) => `Changed ${i}`).join("\n");
      const result = computeUnifiedDiff(a, b, 200);
      expect(result.truncated).toBe(true);
      // The truncated output should be roughly maxLength + the indicator line
      expect(result.diff.length).toBeLessThan(300);
    });

    it("both inputs empty produces minimal diff", () => {
      const result = computeUnifiedDiff("", "");
      expect(result.truncated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // MAX_DIFF_SIZE constant
  // ---------------------------------------------------------------------------
  describe("MAX_DIFF_SIZE", () => {
    it("equals 512000 (500KB)", () => {
      expect(MAX_DIFF_SIZE).toBe(500 * 1024);
      expect(MAX_DIFF_SIZE).toBe(512000);
    });
  });

  // ---------------------------------------------------------------------------
  // Section splitting edge cases (tested via computeSummaryDiff)
  // ---------------------------------------------------------------------------
  describe("section splitting", () => {
    it("handles headings at multiple levels (h1-h6)", () => {
      const a = "# H1\n\nA\n\n## H2\n\nB\n\n### H3\n\nC\n\n#### H4\n\nD\n\n##### H5\n\nE\n\n###### H6\n\nF";
      const b = "# H1\n\nA changed\n\n## H2\n\nB\n\n### H3\n\nC\n\n#### H4\n\nD\n\n##### H5\n\nE\n\n###### H6\n\nF";
      const result = computeSummaryDiff(a, b);
      // Only H1 section should show as modified
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].section).toBe("H1");
      expect(result.sections[0].type).toBe("modified");
    });

    it("preserves multi-line section content correctly", () => {
      const a = "# Section\n\nLine 1\nLine 2\nLine 3";
      const b = "# Section\n\nLine 1\nLine 2 changed\nLine 3";
      const result = computeSummaryDiff(a, b);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].type).toBe("modified");
      expect(result.sections[0].added).toBeGreaterThan(0);
      expect(result.sections[0].removed).toBeGreaterThan(0);
    });
  });
});
