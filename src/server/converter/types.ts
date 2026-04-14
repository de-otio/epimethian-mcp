/**
 * Shared types for the markdown↔storage converter.
 *
 * See doc/design/investigations/investigate-confluence-specific-elements/
 * for the design and contracts these types support.
 */

/** Opaque token identifier of the form "T0001", "T0002", etc. */
export type TokenId = string;

/**
 * Map from token ID to the verbatim outer XML of the storage element it
 * replaces. Built during tokenisation; consumed during restore.
 */
export type TokenSidecar = Record<TokenId, string>;

/**
 * Reference to a Confluence page parsed from a URL.
 */
export interface ConfluencePageRef {
  contentId: string;
  spaceKey?: string;
  anchor?: string;
}

/**
 * Options accepted by the markdown→storage converter.
 */
export interface ConverterOptions {
  /**
   * Allow raw HTML in markdown bodies. Default false. Enabling this
   * opens an XSS / macro-injection surface — only for trusted callers.
   */
  allowRawHtml?: boolean;
  /**
   * Configured Confluence base URL (e.g. https://example.atlassian.net).
   * Used by the link rewriter to detect internal links.
   */
  confluenceBaseUrl?: string;
}

/**
 * Result of diffing the caller's markdown against the canonical pre-edit
 * markdown for a tokenised page.
 */
export interface TokenDiff {
  /** Tokens present in both — restored byte-for-byte from the sidecar. */
  preserved: TokenId[];
  /** Tokens in the canonical pre-edit markdown but absent from the caller's markdown — explicit deletions. */
  deleted: TokenId[];
  /** Tokens whose order changed (preserved, just moved). */
  reordered: TokenId[];
  /** Tokens in the caller's markdown that aren't in the sidecar — caller forgery, must error. */
  invented: TokenId[];
}

/**
 * Error thrown by any converter component for unrecoverable, caller-actionable problems.
 * Always carries a message that explains what went wrong and how to fix it.
 */
export class ConverterError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ConverterError";
  }
}

// --- Safety guard error codes ---

export const SHRINKAGE_NOT_CONFIRMED = "SHRINKAGE_NOT_CONFIRMED";
export const STRUCTURE_LOSS_NOT_CONFIRMED = "STRUCTURE_LOSS_NOT_CONFIRMED";
export const EMPTY_BODY_REJECTED = "EMPTY_BODY_REJECTED";
