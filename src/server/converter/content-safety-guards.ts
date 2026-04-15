/**
 * Content-safety guards for write operations.
 *
 * These guards run at the **handler level** (not inside planUpdate) so they
 * protect both the markdown and storage-format code paths. This is a deliberate
 * architectural decision — see doc/design/11-safety-guards.md Finding 1.
 *
 * Guards:
 *   1A. Shrinkage guard — rejects >50% body reduction unless confirmed.
 *   1B. Structural integrity — rejects >50% heading loss unless confirmed.
 *   1C. Empty-body rejection — hard guard, no opt-out.
 *   1D. Macro loss guard — rejects macro count drop unless confirmed.
 *   1E. Table loss guard — rejects table count drop unless confirmed.
 */

import {
  ConverterError,
  SHRINKAGE_NOT_CONFIRMED,
  STRUCTURE_LOSS_NOT_CONFIRMED,
  EMPTY_BODY_REJECTED,
} from "./types.js";

// --- Error codes for new guards ---

export const MACRO_LOSS_NOT_CONFIRMED = "MACRO_LOSS_NOT_CONFIRMED";
export const TABLE_LOSS_NOT_CONFIRMED = "TABLE_LOSS_NOT_CONFIRMED";

// --- Tuneable thresholds (exported for tests) ---

export const SHRINKAGE_GUARD_MIN_OLD_LEN = 200;
export const SHRINKAGE_GUARD_MAX_RATIO = 0.5;

export const STRUCTURE_GUARD_MIN_OLD_HEADINGS = 3;
export const STRUCTURE_GUARD_MAX_RATIO = 0.5;

export const EMPTY_BODY_MIN_OLD_LEN = 100;
export const EMPTY_BODY_MIN_TEXT_LEN = 3;

// --- Heading counter ---

const HEADING_RE = /<h[1-6][^>]*>/gi;

/**
 * Count headings in storage XML, excluding those inside CDATA sections,
 * code macro bodies, and HTML comments. This prevents false positives
 * from headings appearing in code examples (Finding 7).
 */
export function countHeadings(storage: string): number {
  const cleaned = storage
    .replace(/<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return (cleaned.match(HEADING_RE) || []).length;
}

// --- Macro counter ---

const STRUCTURED_MACRO_RE = /<ac:structured-macro[\s>]/gi;

/**
 * Count top-level `<ac:structured-macro>` elements in storage XML.
 * Excludes those inside code macro bodies and HTML comments.
 */
export function countMacros(storage: string): number {
  const cleaned = storage
    .replace(/<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return (cleaned.match(STRUCTURED_MACRO_RE) || []).length;
}

// --- Table counter ---

const TABLE_RE = /<table[\s>]/gi;

/**
 * Count `<table>` elements in storage XML.
 * Excludes those inside code macro bodies and HTML comments.
 */
export function countTables(storage: string): number {
  const cleaned = storage
    .replace(/<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return (cleaned.match(TABLE_RE) || []).length;
}

// --- Text extractor ---

/**
 * Extract visible text content from storage XML by stripping tags,
 * HTML comments, and HTML entities. This is more robust than a naive
 * tag-strip regex (Finding 3).
 */
export function extractTextContent(storage: string): string {
  return storage
    .replace(/<!--[\s\S]*?-->/g, "")        // strip HTML comments
    .replace(/<[^>]*>/g, "")                  // strip tags
    .replace(/&nbsp;/gi, " ")                 // decode &nbsp; to real space
    .replace(/&[a-zA-Z]+;/g, "_")            // normalize named HTML entities to single char placeholder
    .replace(/&#x?[0-9a-fA-F]+;/g, "_")      // normalize numeric entities to single char placeholder
    .trim();
}

// --- Guard options ---

export interface ContentSafetyInput {
  oldStorage: string;
  newStorage: string;
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
  /** When true, macro/table loss guards are also bypassed (the caller has
   *  already acknowledged deletions via the token-aware path). */
  confirmDeletions?: boolean;
}

// --- Guard runner ---

/**
 * Run all content-safety guards. Throws ConverterError if a guard
 * triggers and the caller has not provided the required confirmation.
 *
 * Call this from the update_page handler AFTER computing the final
 * storage body, regardless of whether the body came from the markdown
 * path or the storage-format path.
 */
export function enforceContentSafetyGuards(input: ContentSafetyInput): void {
  const { oldStorage, newStorage, confirmShrinkage, confirmStructureLoss, confirmDeletions } =
    input;

  const oldLen = oldStorage.length;
  const newLen = newStorage.length;

  // 1A: Content-shrinkage guard
  if (
    oldLen > SHRINKAGE_GUARD_MIN_OLD_LEN &&
    newLen < oldLen * SHRINKAGE_GUARD_MAX_RATIO &&
    !confirmShrinkage
  ) {
    const pct = Math.round((1 - newLen / oldLen) * 100);
    throw new ConverterError(
      `Body would shrink from ${oldLen} to ${newLen} characters ` +
        `(${pct}% reduction). ` +
        `This may indicate accidental content loss. ` +
        `Re-submit with confirm_shrinkage: true to proceed, ` +
        `or omit replace_body to use token-aware preservation.`,
      SHRINKAGE_NOT_CONFIRMED,
    );
  }

  // 1B: Structural integrity check
  const oldHeadings = countHeadings(oldStorage);
  const newHeadings = countHeadings(newStorage);
  if (
    oldHeadings >= STRUCTURE_GUARD_MIN_OLD_HEADINGS &&
    newHeadings < oldHeadings * STRUCTURE_GUARD_MAX_RATIO &&
    !confirmStructureLoss
  ) {
    throw new ConverterError(
      `Heading count would drop from ${oldHeadings} to ${newHeadings}. ` +
        `This may indicate accidental content loss. ` +
        `Re-submit with confirm_structure_loss: true to proceed.`,
      STRUCTURE_LOSS_NOT_CONFIRMED,
    );
  }

  // 1C: Empty-body rejection (no opt-out)
  const textContent = extractTextContent(newStorage);
  if (oldLen > EMPTY_BODY_MIN_OLD_LEN && textContent.length < EMPTY_BODY_MIN_TEXT_LEN) {
    throw new ConverterError(
      `New body contains only ${textContent.length} characters of text content ` +
        `(old body: ${oldLen} characters). This almost certainly indicates ` +
        `accidental content loss. To intentionally clear a page, use delete_page ` +
        `and re-create it.`,
      EMPTY_BODY_REJECTED,
    );
  }

  // 1D: Macro loss guard — detects when macros are silently stripped.
  // This catches cases the shrinkage guard misses, e.g. a page whose
  // body is entirely macros being rewritten to plain text of similar length.
  const oldMacros = countMacros(oldStorage);
  const newMacros = countMacros(newStorage);
  if (
    oldMacros > 0 &&
    newMacros === 0 &&
    !confirmShrinkage &&
    !confirmDeletions
  ) {
    throw new ConverterError(
      `All ${oldMacros} Confluence macro(s) would be removed from the page. ` +
        `This may indicate accidental content loss (e.g. a lossy markdown round-trip). ` +
        `Re-submit with confirm_shrinkage: true if this is intentional.`,
      MACRO_LOSS_NOT_CONFIRMED,
    );
  }

  // 1E: Table loss guard — detects when tables are silently stripped.
  const oldTables = countTables(oldStorage);
  const newTables = countTables(newStorage);
  if (
    oldTables > 0 &&
    newTables === 0 &&
    !confirmStructureLoss &&
    !confirmDeletions
  ) {
    throw new ConverterError(
      `All ${oldTables} table(s) would be removed from the page. ` +
        `This may indicate accidental content loss. ` +
        `Re-submit with confirm_structure_loss: true if this is intentional.`,
      TABLE_LOSS_NOT_CONFIRMED,
    );
  }
}
