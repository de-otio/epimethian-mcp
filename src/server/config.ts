import { z } from "zod";
import type { ProfileSettings } from "../shared/profiles.js";

/**
 * Zod validation schema for the new fields introduced by designs #13 and #14.
 * This is a runtime validator for user-supplied settings — the TypeScript
 * type source-of-truth is still `ProfileSettings` in `../shared/profiles.ts`.
 */
export const ProfileSettingsValidator = z
  .object({
    readOnly: z.boolean().optional(),
    posture: z.enum(["read-only", "read-write", "detect"]).optional(),
    attribution: z.boolean().optional(),
    unverifiedStatus: z.boolean().optional(),
    unverifiedStatusLocale: z.string().optional(),
    unverifiedStatusName: z.string().max(20).optional(),
    unverifiedStatusColor: z
      .enum(["#FFC400", "#2684FF", "#57D9A3", "#FF7452", "#8777D9"])
      .optional(),
    allowed_tools: z.array(z.string()).optional(),
    denied_tools: z.array(z.string()).optional(),
    spaces: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Resolve the effective posture from profile settings and environment
 * variables, applying the legacy `readOnly` alias and precedence rules.
 *
 * Precedence (highest first):
 *   1. Explicit `posture` in profile settings
 *   2. Explicit `readOnly` in profile settings (legacy alias)
 *   3. `CONFLUENCE_READ_ONLY` env var
 *   4. Default: "detect"
 *
 * "detect" means the server has not yet been told what mode to run in;
 * the startup probe (Track O1) converts this into either "read-only" or
 * "read-write". Until O1 ships, callers that need a resolved boolean
 * (e.g. the existing read-only guard) should treat "detect" as
 * "read-write" to preserve current behavior.
 */
export function resolvePosture(
  settings: ProfileSettings | undefined
): "read-only" | "read-write" | "detect" {
  // 1. Explicit posture wins
  if (settings?.posture) return settings.posture;

  // 2. Legacy readOnly alias
  if (settings?.readOnly === true) return "read-only";
  if (settings?.readOnly === false) return "read-write";

  // 3. Env var
  const envVal = process.env.CONFLUENCE_READ_ONLY;
  if (envVal === "true") return "read-only";
  if (envVal === "false") return "read-write";

  // 4. Default
  return "detect";
}

/**
 * Resolve the unverified-status flag from profile settings and env var.
 * Profile setting wins; env var fills in when unset; default true.
 */
export function resolveUnverifiedStatusFlag(
  settings: ProfileSettings | undefined
): boolean {
  if (settings?.unverifiedStatus !== undefined) return settings.unverifiedStatus;
  if (process.env.CONFLUENCE_UNVERIFIED_STATUS === "false") return false;
  if (process.env.CONFLUENCE_UNVERIFIED_STATUS === "true") return true;
  return true; // default
}

/**
 * Resolve the effective read-only / read-write posture from the configured
 * tri-state and the result of the startup capability probe (Track O1).
 *
 * Resolution matrix (design doc #14, "Effective-mode resolution"):
 *
 * configured    | probed          | effective   | source    | warning?
 * --------------|-----------------|-------------|-----------|---------------------------
 * "read-only"   | any             | "read-only" | "profile" |
 * "read-write"  | "read-only"     | "read-write"| "profile" | mismatch warning
 * "read-write"  | other           | "read-write"| "profile" |
 * "detect"      | "write"         | "read-write"| "probe"   |
 * "detect"      | "read-only"     | "read-only" | "probe"   |
 * "detect"      | inconcl. / null | "read-write"| "default" | inconclusive warning
 */
export function resolveEffectivePosture(
  configured: "read-only" | "read-write" | "detect",
  probed: "write" | "read-only" | "inconclusive" | null
): { effective: "read-only" | "read-write"; source: "profile" | "probe" | "default"; warning?: string } {
  if (configured === "read-only") {
    return { effective: "read-only", source: "profile" };
  }

  if (configured === "read-write") {
    if (probed === "read-only") {
      return {
        effective: "read-write",
        source: "profile",
        warning: "configured read-write but probe indicates token is read-only; writes will likely fail",
      };
    }
    return { effective: "read-write", source: "profile" };
  }

  // configured === "detect"
  if (probed === "write") {
    return { effective: "read-write", source: "probe" };
  }
  if (probed === "read-only") {
    return { effective: "read-only", source: "probe" };
  }
  // inconclusive or null
  return {
    effective: "read-write",
    source: "default",
    warning: "capability probe was inconclusive — defaulting to read-write",
  };
}

/**
 * Resolve the unverified-status locale from profile settings and env var.
 * Profile setting wins; env var is used when unset; returns undefined if neither.
 * (The provenance module falls back to Intl then "en" when this is undefined.)
 */
export function resolveUnverifiedStatusLocale(
  settings: ProfileSettings | undefined
): string | undefined {
  if (settings?.unverifiedStatusLocale) return settings.unverifiedStatusLocale;
  if (process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE) {
    return process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
  }
  return undefined;
}
