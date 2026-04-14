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
 */

import {
  ConverterError,
  SHRINKAGE_NOT_CONFIRMED,
  STRUCTURE_LOSS_NOT_CONFIRMED,
  EMPTY_BODY_REJECTED,
} from "./types.js";

// --- Tuneable thresholds (exported for tests) ---

export const SHRINKAGE_GUARD_MIN_OLD_LEN = 500;
export const SHRINKAGE_GUARD_MAX_RATIO = 0.5;

export const STRUCTURE_GUARD_MIN_OLD_HEADINGS = 3;
export const STRUCTURE_GUARD_MAX_RATIO = 0.5;

export const EMPTY_BODY_MIN_OLD_LEN = 500;
export const EMPTY_BODY_MIN_TEXT_LEN = 100;

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
    .replace(/&[a-zA-Z]+;/g, " ")            // normalize HTML entities to single space
    .replace(/&#x?[0-9a-fA-F]+;/g, " ")      // normalize numeric entities
    .trim();
}

// --- Guard options ---

export interface ContentSafetyInput {
  oldStorage: string;
  newStorage: string;
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
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
  const { oldStorage, newStorage, confirmShrinkage, confirmStructureLoss } =
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
}
