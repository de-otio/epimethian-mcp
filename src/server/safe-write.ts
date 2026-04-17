/**
 * Centralised write-safety pipeline for Confluence page mutations.
 *
 * PRINCIPLE: the only way to write to Confluence is through this pipeline;
 * handlers opt out of guards explicitly, never opt in. Every guard fires by
 * default; each opt-out flag is visible at the call site and reviewable.
 * Adding a new guard automatically enforces it everywhere.
 *
 * Two functions compose the pipeline:
 *   - safePrepareBody: pure; caller input (markdown or storage) →
 *     submit-ready storage. No API calls.
 *   - safeSubmitPage: the only authorised caller of the raw HTTP wrappers.
 *     Owns duplicate-title check (creates), post-transform body guard, and
 *     both success- and failure-path mutation logging.
 *
 * Rationale: see plans/centralized-write-safety.md.
 */

import type { PageData } from "./confluence-client.js";

/**
 * Scope of the body being prepared. Controls which guards fire and at what
 * threshold.
 *
 * - "full" (default): complete replacement page body; page-scale guards.
 * - "section": a section that will be spliced into a larger body by the
 *   handler. Guards thresholded for section-scale changes; the full-body
 *   post-transform guard still runs in safeSubmitPage after splicing.
 * - "additive": prepared output will be concatenated onto currentBody
 *   unchanged (prepend/append). Token diff and deletion checks are skipped
 *   (nothing is being transformed); content guards still run post-concat
 *   inside safeSubmitPage.
 */
export type SafePrepareScope = "full" | "section" | "additive";

/**
 * A preserved token (macro) removed between currentBody and the prepared
 * output. Surfaced in the SafeSubmitPageOutput so the handler can echo the
 * removals into the tool response.
 */
export interface DeletedToken {
  /** Stable token ID from planUpdate (e.g. "T0003"). */
  id: string;
  /** Storage-format tag name (e.g. "ac:structured-macro", "ac:emoticon"). */
  tag: string;
  /**
   * Short human-readable fingerprint for disambiguation in tool output
   * (e.g. "drawio[architecture.drawio]", "structured-macro[panel]").
   */
  fingerprint: string;
}

/**
 * Input to safePrepareBody. Pure transformation; no API calls.
 */
export interface SafePrepareBodyInput {
  /**
   * Caller's input body — markdown or Confluence storage format. The
   * pipeline detects markdown via looksLikeMarkdown; storage is pass-through.
   * Markdown is converted via planUpdate when currentBody has preserved
   * tokens, via markdownToStorage otherwise.
   */
  body: string;

  /**
   * The page's current storage-format body. Required for token-aware
   * conversion and structural-guard comparisons.
   *
   * - updates: the full page body at the current version.
   * - creates: undefined.
   * - sections (scope: "section"): the current section body.
   *
   * Note: in section flows this is the SECTION body, but
   * SafeSubmitPageInput.previousBody must be the FULL page body — the two
   * fields serve different purposes.
   */
  currentBody: string | undefined;

  /** Scope of the body. Defaults to "full". See SafePrepareScope. */
  scope?: SafePrepareScope;

  /**
   * Acknowledge deletion of preserved tokens between currentBody and the
   * prepared output.
   *
   * - `string[]`: itemised token IDs the caller acknowledges (e.g.
   *   ["T0003", "T0007"]). If the actual deletion set differs, the pipeline
   *   errors with the correct list. Preferred, reviewable shape.
   * - `true`: deprecated blanket ack. Accepted in **v5.5** with a warning
   *   that enumerates the specific token IDs (so the caller can paste them
   *   back itemised on the next call). **Removed in v5.7.**
   * - `undefined` (default): pipeline errors DELETIONS_NOT_CONFIRMED if any
   *   preserved tokens are missing.
   *
   * Distinct from `replaceBody`: confirmDeletions acknowledges specific
   * deletions against a diff; replaceBody skips the diff entirely.
   */
  confirmDeletions?: string[] | true;

  /** Acknowledge body shrinkage over the guard's threshold (>40%). */
  confirmShrinkage?: boolean;

  /** Acknowledge heading/macro structure reduction. */
  confirmStructureLoss?: boolean;

  /**
   * Intent to overwrite the whole body (e.g. revert_page). Bypasses
   * **token deletion** and **structure-loss** checks — diffing tokens is
   * not meaningful when the caller is replacing everything.
   *
   * **Does not bypass** shrinkage, empty-body, or macro/table-loss guards —
   * those catch accidental catastrophic overwrites even when replacement is
   * intentional.
   *
   * Distinct from `confirmDeletions: true`:
   *   - replaceBody: "I'm replacing everything; don't diff tokens at all."
   *   - confirmDeletions: true: "I've reviewed the specific deletions."
   */
  replaceBody?: boolean;

  /**
   * Permit raw HTML in the input that the looksLikeMarkdown / raw-HTML
   * tripwire would otherwise reject. Opt-in because raw HTML in a markdown
   * context is a common source of malformed storage.
   */
  allowRawHtml?: boolean;

  /**
   * Configured Confluence base URL. When set, enables the link rewriter so
   * that markdown links matching this host are rewritten appropriately.
   * When unset, link rewriting is skipped (not an error). Pass-through from
   * the handler; the module does not resolve credentials internally.
   */
  confluenceBaseUrl?: string;
}

/**
 * Output of safePrepareBody. Feeds directly into safeSubmitPage.
 */
export interface SafePrepareBodyOutput {
  /**
   * Submit-ready Confluence storage. For "full"/"section" this is the
   * transformed body; for "additive" this is the prepared-but-unconcatenated
   * addition that the handler must splice onto currentBody before passing
   * to safeSubmitPage.
   */
  finalStorage: string;

  /**
   * Suggested version message — surfaces deletion metadata and other
   * pipeline observations. Handler forwards this unchanged to
   * safeSubmitPage, which combines it with attribution.
   */
  versionMessage: string;

  /**
   * Preserved tokens removed by this preparation; empty when nothing was
   * removed. Threaded through safeSubmitPage to the final tool response.
   */
  deletedTokens: DeletedToken[];
}

/**
 * Input to safeSubmitPage. The sole authorised caller of the raw
 * _rawUpdatePage / _rawCreatePage wrappers.
 *
 * Create vs. update branching:
 *   - `pageId: undefined` → **create**. `spaceId` is required; `previousBody`
 *     and `version` must be omitted. `parentId` is optional.
 *   - `pageId: string` → **update**. `previousBody` and `version` are
 *     required; `spaceId` / `parentId` are not used.
 *
 * One submit function (rather than separate create/update) is intentional:
 * the shared post-transform guard and mutation-log shape are the whole
 * point of the centralisation.
 */
export interface SafeSubmitPageInput {
  /** `undefined` → create; string → update. */
  pageId: string | undefined;

  /** Required for create; ignored on update. */
  spaceId?: string;

  /** Optional on create; ignored on update. */
  parentId?: string;

  /** Page title. Required for both create and update. */
  title: string;

  /**
   * Submit-ready storage from safePrepareBody (or a handler-spliced full
   * body, for scope "section"). The post-transform body guard runs on this
   * value inside safeSubmitPage — so handler-side splicing damage is caught
   * before the HTTP call.
   */
  finalStorage: string;

  /**
   * The full page body at the current version. Required for updates; must
   * be omitted for creates.
   *
   * IMPORTANT: even in section flows where SafePrepareBodyInput.currentBody
   * was only the section, previousBody here MUST be the full page body. It
   * is used for diff/attribution logging and the post-transform comparison.
   */
  previousBody?: string;

  /**
   * Current page version (the write will be version+1). Required for
   * updates; must be omitted for creates.
   */
  version?: number;

  /**
   * Version message from safePrepareBody. safeSubmitPage combines this with
   * attribution and client-label formatting.
   */
  versionMessage: string;

  /**
   * Tokens removed during preparation, from safePrepareBody.deletedTokens.
   * Echoed into SafeSubmitPageOutput verbatim so the handler has one
   * consolidated object to format for the tool response.
   */
  deletedTokens: DeletedToken[];

  /**
   * Client label (e.g. "claude-code@3.2.1") for attribution and
   * mutation-log entries. Pass-through from the handler — resolved via
   * getClientLabel(server) at the call site.
   */
  clientLabel: string | undefined;
}

/**
 * Output of safeSubmitPage. The handler shapes this into the tool response.
 *
 * `newVersion` is the version just written (1 for creates). `oldLen` is 0
 * for creates. `deletedTokens` is echoed from the input and never modified
 * inside safeSubmitPage.
 */
export interface SafeSubmitPageOutput {
  /** The page returned by the Confluence API. */
  page: PageData;
  /** New version number after the write (1 for creates). */
  newVersion: number;
  /** Length of previousBody for updates; 0 for creates. */
  oldLen: number;
  /** Length of finalStorage (the body just written). */
  newLen: number;
  /** Tokens removed during preparation (echoed from the input). */
  deletedTokens: DeletedToken[];
}

/**
 * Prepare a body for submission. Pure; no API calls.
 *
 * Implementation lives in task A2; this stub exists so types can be wired
 * against a stable surface.
 */
export async function safePrepareBody(
  input: SafePrepareBodyInput
): Promise<SafePrepareBodyOutput> {
  void input;
  throw new Error("not implemented: A2");
}

/**
 * Submit a prepared body to Confluence via the raw HTTP wrappers. Owns the
 * duplicate-title check (creates), the post-transform body guard, and both
 * success- and failure-path mutation logging.
 *
 * Implementation lives in task A2; this stub exists so types can be wired
 * against a stable surface.
 */
export async function safeSubmitPage(
  input: SafeSubmitPageInput
): Promise<SafeSubmitPageOutput> {
  void input;
  throw new Error("not implemented: A2");
}
