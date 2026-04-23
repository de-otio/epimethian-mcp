/**
 * Provenance / unverified-status badge helper (design doc #13).
 *
 * Provides locale-aware resolution of the "AI-edited" content-state badge and
 * the idempotent write helper `markPageUnverified`.  This module NEVER throws
 * from `markPageUnverified` — badge failures must not abort parent edits.
 */

import {
  type Config,
  ConfluencePermissionError,
  getContentState,
  setContentState,
} from "./confluence-client.js";

// ---------------------------------------------------------------------------
// Label table
// ---------------------------------------------------------------------------

export const UNVERIFIED_COLOR = "#FFC400";

export const UNVERIFIED_LABELS: Record<string, string> = {
  en: "AI-edited",
  fr: "Modifié par IA",
  de: "KI-bearbeitet",
  es: "Editado por IA",
  pt: "Editado por IA",
  it: "Modificato da IA",
  nl: "AI-bewerkt",
  ja: "AI編集済み",
  zh: "AI已编辑",
  ko: "AI 편집됨",
};

// Module-load assertion: every label must be ≤20 code points.
// Using [...str].length correctly counts Unicode code points (not UTF-16 code
// units), which matches Confluence's maxLength: 20 rule.
for (const [locale, label] of Object.entries(UNVERIFIED_LABELS)) {
  const codePoints = [...label].length;
  if (codePoints > 20) {
    throw new Error(
      `UNVERIFIED_LABELS["${locale}"] = "${label}" has ${codePoints} code points, exceeding the 20-code-point Confluence limit.`
    );
  }
}

// Fast membership set for idempotency checks.
const KNOWN_LABELS = new Set(Object.values(UNVERIFIED_LABELS));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `name` is any known locale-table unverified label, or
 * matches the caller-supplied custom override name.
 */
export function isKnownUnverifiedLabel(name: string, customOverride?: string): boolean {
  if (customOverride !== undefined && name === customOverride) return true;
  return KNOWN_LABELS.has(name);
}

/**
 * Resolves the locale key to use for the badge label.
 *
 * Resolution order:
 *   1. cfg.unverifiedStatusLocale (profile-level explicit override)
 *   2. process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE
 *   3. Intl.DateTimeFormat().resolvedOptions().locale (system locale)
 *   4. "en" (fallback)
 *
 * The locale string is split on "-" and lowercased so that e.g. "fr-FR" → "fr".
 */
export function pickLocale(cfg: Config): string {
  const raw =
    cfg.unverifiedStatusLocale ||
    process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    "en";
  return raw.split("-")[0].toLowerCase();
}

/**
 * Returns the { name, color } pair to use for the unverified badge.
 *
 * If cfg.unverifiedStatusName is set, it fully overrides the locale table.
 * Otherwise the name is looked up via pickLocale() with "en" as the final
 * fallback.  Color always defaults to UNVERIFIED_COLOR if not overridden.
 */
export function resolveUnverifiedStatus(cfg: Config): { name: string; color: string } {
  const color = cfg.unverifiedStatusColor ?? UNVERIFIED_COLOR;

  if (cfg.unverifiedStatusName) {
    return { name: cfg.unverifiedStatusName, color };
  }

  const locale = pickLocale(cfg);
  const name = UNVERIFIED_LABELS[locale] ?? UNVERIFIED_LABELS["en"];
  return { name, color };
}

// ---------------------------------------------------------------------------
// Core badge-apply function
// ---------------------------------------------------------------------------

/**
 * Idempotently applies the "AI-edited" content-state badge to a Confluence
 * page after a body-modifying tool call.
 *
 * CONTRACT: This function MUST NEVER THROW.  Callers (create_page,
 * update_page, …) must succeed regardless of badge failures.  All errors are
 * converted to a `{ warning }` return value.
 *
 * Returns `{}` on success or when no action was taken (idempotent skip).
 * Returns `{ warning: string }` when the badge could not be applied.
 */
export async function markPageUnverified(
  pageId: string,
  cfg: Config
): Promise<{ warning?: string }> {
  // Feature disabled — bail out immediately without any API calls.
  if (cfg.unverifiedStatus === false) {
    return {};
  }

  const target = resolveUnverifiedStatus(cfg);

  // --- Idempotency check via getContentState ---
  let skipSet = false;
  try {
    const current = await getContentState(pageId);
    if (
      current != null &&
      current.color === target.color &&
      isKnownUnverifiedLabel(current.name, cfg.unverifiedStatusName)
    ) {
      // Already marked with an equivalent unverified badge — skip to avoid a
      // gratuitous version bump.
      return {};
    }
    // current is null or a different/non-unverified state → fall through to set.
  } catch (err) {
    if (err instanceof ConfluencePermissionError) {
      // Permission error on GET: per spec, fall through and attempt set.
      // (Do NOT return warning here — test 19 expects setContentState is called.)
    }
    // Any other getContentState error: fail-open — attempt to apply the badge
    // anyway (redundant version bump is better than a missing badge).
  }

  if (skipSet) return {};

  // --- Apply the badge ---
  try {
    await setContentState(pageId, target.name, target.color);
    return {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ConfluencePermissionError) {
      return {
        warning: `Could not apply 'AI-edited' status badge (permission denied). Provenance badge is missing for page ${pageId}.`,
      };
    }
    return {
      warning: `Could not apply 'AI-edited' status badge: ${message}. Provenance badge is missing for page ${pageId}.`,
    };
  }
}
