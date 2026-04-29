import { z } from "zod";
import TurndownService from "turndown";
import { readFromKeychain, saveToKeychain, PROFILE_NAME_RE } from "../shared/keychain.js";
import { getProfileSettings } from "../shared/profiles.js";
import {
  testConnection,
  verifyTenantIdentity,
  fetchTenantInfo,
} from "../shared/test-connection.js";
import { escapeXmlText } from "./converter/escape.js";
import { fenceUntrusted } from "./converter/untrusted-fence.js";

declare const __PKG_VERSION__: string;
import { pageCache } from "./page-cache.js";
import {
  resolvePosture,
  resolveEffectivePosture,
  resolveUnverifiedStatusFlag,
  resolveUnverifiedStatusLocale,
} from "./config.js";

// --- Client label (set once from index.ts after MCP initialize handshake) ---

// Character class for safe client-label output. Intentionally narrow: ANSI
// escape sequences, newlines, and other control chars are stripped so a
// malicious MCP client cannot inject log-line breaks or terminal escapes
// via its declared name. The set covers real-world labels like
// "Claude Code", "Cursor (1.2.3)", and "VS Code / Continue".
const CLIENT_LABEL_DISALLOWED_RE = /[^A-Za-z0-9 _./()\-]/g;

let _clientLabel: string | undefined;
export function setClientLabel(label: string | undefined): void {
  if (!label) {
    _clientLabel = undefined;
    return;
  }
  const sanitized = label.replace(CLIENT_LABEL_DISALLOWED_RE, "").slice(0, 80);
  _clientLabel = sanitized || undefined;
}

// --- Configuration ---

export interface Config {
  url: string;
  email: string;
  profile: string | null;
  /**
   * Legacy boolean read-only flag derived from `posture`. `true` iff
   * `posture === "read-only"`. Kept populated so existing `writeGuard`
   * call sites continue to work; prefer `posture` for new code.
   */
  readOnly: boolean;
  /**
   * Configured MCP access posture from design doc #14 (tri-state).
   * "detect" is resolved to a concrete "read-only" | "read-write" by the
   * startup probe in Track O1; until that ships, callers should treat
   * "detect" as "read-write" to preserve current behavior.
   *
   * Optional on the type so that pre-existing test fixtures that construct
   * Config literals continue to compile; the runtime value is always
   * populated by `getConfig()`.
   */
  posture?: "read-only" | "read-write" | "detect";
  attribution: boolean;
  /** Design doc #13 — default "AI-edited" status badge toggle. Optional for the same reason as posture. */
  unverifiedStatus?: boolean;
  /** Optional locale override for the badge label. */
  unverifiedStatusLocale?: string;
  /** Optional full-label override (bypasses locale table). */
  unverifiedStatusName?: string;
  /** Optional color override. */
  unverifiedStatusColor?: "#FFC400" | "#2684FF" | "#57D9A3" | "#FF7452" | "#8777D9";
  apiV2: string;
  apiV1: string;
  authHeader: string;
  jsonHeaders: Record<string, string>;
  /** Tenant seal: cloudId stored in the keychain entry for this profile (undefined for env-var mode or pre-seal profiles). */
  sealedCloudId?: string;
  /** Tenant seal: display name stored alongside the cloudId, used for human-readable error messages. */
  sealedDisplayName?: string;
  /**
   * Effective posture after resolving configured tri-state + probe result.
   * Populated by validateStartup() — always set at runtime after startup.
   * Optional on the type so pre-existing test fixtures that construct Config
   * literals continue to compile (same pattern as `posture?`).
   */
  effectivePosture?: "read-only" | "read-write";
  /**
   * Raw result from the write-capability probe. null when posture is not "detect"
   * (probe is skipped). Populated by validateStartup().
   * Optional for the same reason as effectivePosture.
   */
  probedCapability?: "write" | "read-only" | "inconclusive" | null;
  /**
   * How effectivePosture was determined: user config, probe result, or default.
   * Populated by validateStartup().
   * Optional for the same reason as effectivePosture.
   */
  postureSource?: "profile" | "probe" | "default";
}

let _config: Config | null = null;

/**
 * Thrown when CONFLUENCE_PROFILE names a profile that has no keychain entry.
 * Recoverable — the server starts in setup-needed mode rather than exiting.
 */
export class ProfileNotConfiguredError extends Error {
  readonly profile: string;
  constructor(profile: string) {
    super(`No credentials found for profile "${profile}"`);
    this.name = "ProfileNotConfiguredError";
    this.profile = profile;
  }
}

/**
 * Resolve credentials from environment / keychain without caching.
 * Exported for testability — callers should use getConfig() instead.
 *
 * Resolution order (no merging across sources):
 *   1. CONFLUENCE_PROFILE env var → read all fields from named keychain entry
 *   2. All 3 env vars set → use directly (CI/CD mode)
 *   3. Anything else (partial env vars, or none) → hard error
 *
 * Throws ProfileNotConfiguredError if a valid profile is named but has no
 * keychain entry — the server can recover by entering setup-needed mode.
 * All other credential errors still call process.exit(1).
 */
export async function resolveCredentials(): Promise<{
  url: string;
  email: string;
  apiToken: string;
  profile: string | null;
  sealedCloudId?: string;
  sealedDisplayName?: string;
}> {
  const profileEnv = process.env.CONFLUENCE_PROFILE || "";
  const urlEnv = process.env.CONFLUENCE_URL?.replace(/\/$/, "") || "";
  const emailEnv = process.env.CONFLUENCE_EMAIL || "";
  const tokenEnv = process.env.CONFLUENCE_API_TOKEN || "";

  // Step 1: Named profile
  if (profileEnv) {
    if (!PROFILE_NAME_RE.test(profileEnv)) {
      console.error(
        `Invalid CONFLUENCE_PROFILE: "${profileEnv}". Use lowercase alphanumeric and hyphens only (1-63 chars).`
      );
      process.exit(1);
    }
    const creds = await readFromKeychain(profileEnv);
    if (!creds) {
      throw new ProfileNotConfiguredError(profileEnv);
    }
    return {
      url: creds.url.replace(/\/$/, ""),
      email: creds.email,
      apiToken: creds.apiToken,
      profile: profileEnv,
      sealedCloudId: creds.cloudId,
      sealedDisplayName: creds.tenantDisplayName,
    };
  }

  // Step 2: All three env vars set (CI/CD mode)
  if (urlEnv && emailEnv && tokenEnv) {
    // Clear token from process env to reduce exposure window
    delete process.env.CONFLUENCE_API_TOKEN;
    return { url: urlEnv, email: emailEnv, apiToken: tokenEnv, profile: null };
  }

  // Step 3: Anything else — hard error
  // No partial env vars, no legacy keychain fallback.
  const setVars = [
    urlEnv && "CONFLUENCE_URL",
    emailEnv && "CONFLUENCE_EMAIL",
    tokenEnv && "CONFLUENCE_API_TOKEN",
  ].filter(Boolean);

  if (setVars.length > 0) {
    console.error(
      `Error: Partial credentials detected (${setVars.join(", ")} set, but not all three).\n` +
        "Either set CONFLUENCE_PROFILE or provide all three environment variables " +
        "(CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN).\n" +
        "Run `epimethian-mcp setup --profile <name>` for guided setup."
    );
    process.exit(1);
  }

  console.error(
    "Missing Confluence credentials. Set CONFLUENCE_PROFILE environment variable, " +
      "or run `epimethian-mcp setup --profile <name>` to configure."
  );
  process.exit(1);
}

export async function getConfig(): Promise<Config> {
  if (_config) return _config;

  const { url, email, apiToken, profile, sealedCloudId, sealedDisplayName } =
    await resolveCredentials();

  // Resolve configuration from profile registry and environment.
  const registrySettings = profile ? await getProfileSettings(profile) : undefined;

  // Posture (design doc #14): tri-state with legacy readOnly alias.
  // Until Track O1's startup probe ships, "detect" is treated as "read-write"
  // to preserve existing behavior. The legacy readOnly boolean is derived.
  const posture = resolvePosture(registrySettings);
  const readOnly = posture === "read-only";

  // Attribution flag: disabled if registry or env var says so.
  const attribution =
    (registrySettings?.attribution !== false) &&
    (process.env.CONFLUENCE_ATTRIBUTION !== "false");

  // Unverified-status badge (design doc #13).
  const unverifiedStatus = resolveUnverifiedStatusFlag(registrySettings);
  const unverifiedStatusLocale = resolveUnverifiedStatusLocale(registrySettings);
  const unverifiedStatusName = registrySettings?.unverifiedStatusName;
  const unverifiedStatusColor = registrySettings?.unverifiedStatusColor;

  // Confluence exposes two API generations:
  //   - v2 (REST): /wiki/api/v2  — used for page CRUD, spaces, children
  //   - v1 (REST): /wiki/rest/api — used for CQL search and attachments (no v2 equivalent)
  const authHeader =
    "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  // Deep-freeze: jsonHeaders must be frozen separately because Object.freeze
  // is shallow. Without this, callers could mutate config.jsonHeaders.Authorization
  // at runtime, breaking the immutability contract getConfig advertises.
  const jsonHeaders = Object.freeze({
    Authorization: authHeader,
    "Content-Type": "application/json",
  });

  _config = Object.freeze({
    url,
    email,
    profile,
    readOnly,
    posture,
    attribution,
    unverifiedStatus,
    unverifiedStatusLocale,
    unverifiedStatusName,
    unverifiedStatusColor,
    apiV2: `${url}/wiki/api/v2`,
    apiV1: `${url}/wiki/rest/api`,
    authHeader,
    jsonHeaders,
    sealedCloudId,
    sealedDisplayName,
    // Placeholders — overwritten by validateStartup() once the probe runs.
    // Until then, treat as read-write to preserve existing behavior.
    effectivePosture: (posture === "read-only" ? "read-only" : "read-write") as "read-only" | "read-write",
    probedCapability: null as "write" | "read-only" | "inconclusive" | null,
    postureSource: "default" as "profile" | "probe" | "default",
  });
  return _config;
}

/**
 * Probe whether the current credentials have write capability.
 *
 * Strategy:
 *  1. Primary: GET /wiki/rest/api/user/current/permission/space/{spaceKey}
 *     against the first accessible space. A `create` operation on `page`
 *     content type in the response indicates write capability.
 *  2. Fallback (when primary returns 404 or no spaces are available):
 *     PUT /wiki/api/v2/pages/999999999999 with a trivially bad body.
 *     - 403 → "read-only" (permission denied)
 *     - 404 / 400 → "write" (token can write; hit a non-existent page or bad body)
 *     - 401 → rethrown (auth failure, not a capability question)
 * 3. Any other unexpected error → "inconclusive" (logs a warning).
 *
 * Returns one of: "write" | "read-only" | "inconclusive"
 */
export async function probeWriteCapability(): Promise<"write" | "read-only" | "inconclusive"> {
  const cfg = await getConfig();

  // --- Primary strategy: permission endpoint against first accessible space ---
  try {
    const spaces = await getSpaces(1);
    if (spaces.length > 0) {
      const spaceKey = spaces[0].key;
      const permUrl = new URL(
        `${cfg.apiV1}/user/current/permission/space/${encodeURIComponent(spaceKey)}`
      );
      permUrl.searchParams.set("operationKey", "create");
      permUrl.searchParams.set("targetType", "page");

      try {
        const res = await confluenceRequest(permUrl.toString());
        const raw = (await res.json()) as unknown;
        // The response is typically { operation: { operation: "create", targetType: "page" }, havePermission: boolean }
        // When operationKey+targetType are specified, Confluence returns a single permission object.
        if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          if (obj.havePermission === true) return "write";
          if (obj.havePermission === false) return "read-only";
          // Older Cloud returns an array of permitted operations — look for "create" on "page"
          if (Array.isArray(obj.permissions)) {
            const perms = obj.permissions as Array<Record<string, unknown>>;
            const hasCreate = perms.some((p) => {
              const op = p.operation as Record<string, unknown> | undefined;
              return op?.operation === "create" && op?.targetType === "page";
            });
            return hasCreate ? "write" : "read-only";
          }
        }
        // Unexpected shape — fall through to dry-run
      } catch (permErr) {
        if (permErr instanceof ConfluenceAuthError) throw permErr;
        if (permErr instanceof ConfluenceNotFoundError) {
          // Endpoint not available — fall through to dry-run
        } else if (permErr instanceof ConfluencePermissionError) {
          return "read-only";
        }
        // Any other error from permission endpoint — try dry-run
      }
    }
  } catch (spacesErr) {
    if (spacesErr instanceof ConfluenceAuthError) throw spacesErr;
    // Cannot list spaces — fall through to dry-run
  }

  // --- Fallback strategy: dry-run PUT against a non-existent page ---
  try {
    await confluenceRequest(`${cfg.apiV2}/pages/999999999999`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    // 2xx would be very surprising, but if it happens the token can write
    return "write";
  } catch (err) {
    if (err instanceof ConfluenceAuthError) throw err;
    if (err instanceof ConfluencePermissionError) return "read-only";
    // 404 (page not found) or any 400-class body-validation error = token can write
    if (err instanceof ConfluenceNotFoundError) return "write";
    if (err instanceof ConfluenceApiError && err.status >= 400 && err.status < 500) {
      // 400 Bad Request = body rejected by schema, but token had permission to attempt the write
      return "write";
    }
    // Unexpected / network error
    console.error(
      `epimethian-mcp: warning — write-capability probe failed with unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return "inconclusive";
  }
}

/**
 * Validate credentials against the Confluence instance before accepting tool calls.
 * 1. Test authentication (GET spaces)
 * 2. Verify tenant identity (email matches)
 * 3. Tenant seal: verify cloudId matches the one sealed at setup time.
 *    Opportunistically seal pre-5.5 profiles on first startup after upgrade.
 * 4. Capability probe (when posture === "detect") + effective-posture resolution
 * 5. Log connection info to stderr
 */
export async function validateStartup(config: Config): Promise<void> {
  const { url, email, profile } = config;
  // Extract apiToken from authHeader (it's baked into the Basic auth)
  // We need raw credentials for testConnection/verifyTenantIdentity
  const decoded = Buffer.from(
    config.authHeader.replace("Basic ", ""),
    "base64"
  ).toString();
  const colonIndex = decoded.indexOf(":");
  const apiToken = decoded.slice(colonIndex + 1);

  // Step 1: Authentication check
  const connResult = await testConnection(url, email, apiToken);
  if (!connResult.ok) {
    const profileHint = profile
      ? `Run \`epimethian-mcp setup --profile ${profile}\` to update credentials.`
      : "Check your CONFLUENCE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.";
    console.error(
      `Error: Confluence credentials rejected by ${url}\n${connResult.message}\n${profileHint}`
    );
    process.exit(1);
  }

  // Step 2: Tenant identity verification
  const identityResult = await verifyTenantIdentity(url, email, apiToken);
  if (!identityResult.ok) {
    const profileHint = profile
      ? `Run \`epimethian-mcp setup --profile ${profile}\` to reconfigure.`
      : "Check your credential configuration.";
    console.error(
      `Error: Tenant identity mismatch for ${profile ? `profile "${profile}"` : "configured credentials"}.\n` +
        `Expected user: ${email}\n` +
        (identityResult.authenticatedEmail
          ? `Authenticated as: ${identityResult.authenticatedEmail}\n`
          : "") +
        `This may indicate a DNS or configuration issue. ${profileHint}`
    );
    process.exit(1);
  }

  // Step 3: Tenant seal verification (skipped for env-var mode — no keychain entry to seal).
  if (profile) {
    await verifyOrSealTenant(config, apiToken);
  }

  // Step 4: Capability probe + effective-posture resolution
  const configuredPosture = config.posture ?? "detect";
  let probedCapability: "write" | "read-only" | "inconclusive" | null = null;

  if (configuredPosture === "detect") {
    try {
      probedCapability = await probeWriteCapability();
    } catch (err) {
      // ConfluenceAuthError from the probe means auth already failed in step 1;
      // shouldn't normally reach here, but treat as inconclusive to avoid masking the auth error.
      console.error(
        `epimethian-mcp: warning — write-capability probe threw unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      probedCapability = "inconclusive";
    }
  }

  const resolved = resolveEffectivePosture(configuredPosture, probedCapability);

  // Replace the frozen _config with a new frozen object that includes the resolved fields.
  // This is safe because validateStartup() runs once during startup, before tools are registered.
  _config = Object.freeze({
    ..._config!,
    effectivePosture: resolved.effective,
    probedCapability,
    postureSource: resolved.source,
  });

  // Step 5: Log connection info + posture banner
  const profileLabel = profile ? `profile: ${profile}` : "env-var mode";
  const readOnlyLabel = config.readOnly ? ", READ-ONLY" : "";
  const attributionLabel = config.attribution ? "" : ", NO-ATTRIBUTION";
  console.error(
    `epimethian-mcp: connected to ${url} as ${email} (${profileLabel}${readOnlyLabel}${attributionLabel})`
  );

  const modeLabel = resolved.effective === "read-only" ? "read-only" : "read-write";
  console.error(
    `[epimethian-mcp] Profile "${profile ?? "env-var"}" — mode: ${modeLabel} (source: ${resolved.source}).`
  );
  if (resolved.warning) {
    console.error(`[epimethian-mcp] Warning: ${resolved.warning}`);
  }
}

/**
 * Verify the live tenant's cloudId against the one sealed at setup time.
 *
 * Failure modes:
 *   - Seal mismatch (stored cloudId ≠ live cloudId): hard-exit. Core guard.
 *   - Sealed profile + tenant_info endpoint unreachable: hard-exit. A
 *     selective block on the endpoint would otherwise let an attacker with
 *     a mis-pointed URL bypass the seal.
 *   - Pre-5.5 profile (no stored cloudId) + tenant_info unreachable:
 *     graceful degrade — log a warning and continue; seal will be
 *     attempted again on next startup.
 *   - Pre-5.5 profile + tenant_info reachable: opportunistic seal.
 *     Fetch the cloudId and write it back to the keychain entry.
 *
 * Callers must ensure `config.profile` is non-null.
 */
async function verifyOrSealTenant(config: Config, apiToken: string): Promise<void> {
  const { url, email, profile, sealedCloudId, sealedDisplayName } = config;
  if (!profile) return;

  const live = await fetchTenantInfo(url, email, apiToken);
  if (!live.ok) {
    if (sealedCloudId) {
      // Sealed profile: we cannot verify the live tenant, so we must refuse.
      // Distinct from a mismatch — an attacker who can selectively block
      // `/_edge/tenant_info` (network MITM, DNS, egress filter) would
      // otherwise bypass the seal entirely. Fail closed.
      console.error(
        `Error: Tenant seal cannot be verified for profile "${profile}".\n` +
          `  Expected tenant : ${sealedDisplayName ?? "(unknown)"} (cloudId ${sealedCloudId})\n` +
          `  URL             : ${url}\n` +
          `  Reason          : tenant_info endpoint unreachable (${live.message})\n` +
          `\n` +
          `This is distinct from a tenant mismatch — the seal check did not run because ` +
          `the verification endpoint was unavailable. Refusing to connect to prevent ` +
          `cross-tenant writes in the face of a selective network block. Check network ` +
          `connectivity to ${url}, or run \`epimethian-mcp setup --profile ${profile}\` ` +
          `if the tenant has legitimately moved.`
      );
      process.exit(1);
    }

    // Pre-5.5 profile with no stored seal — graceful degrade. Nothing to
    // verify against, and blocking here would break upgrade paths for users
    // whose tenants legitimately lack this endpoint.
    console.error(
      `epimethian-mcp: warning — tenant_info unavailable for profile "${profile}" (${live.message}). ` +
        `Skipping tenant seal check (will retry on next startup).`
    );
    return;
  }

  const liveCloudId = live.info.cloudId;
  const liveDisplayName = live.info.displayName;

  if (sealedCloudId) {
    if (sealedCloudId !== liveCloudId) {
      console.error(
        `Error: Tenant seal mismatch for profile "${profile}".\n` +
          `  Expected tenant : ${sealedDisplayName ?? "(unknown)"} (cloudId ${sealedCloudId})\n` +
          `  Live tenant     : ${liveDisplayName} (cloudId ${liveCloudId})\n` +
          `  URL             : ${url}\n` +
          `\n` +
          `This indicates the profile's stored URL/credentials now point at a different ` +
          `Atlassian tenant than when the profile was created. Refusing to connect to ` +
          `prevent cross-tenant writes. Run \`epimethian-mcp setup --profile ${profile}\` ` +
          `to reconfigure if this change was intentional.`
      );
      process.exit(1);
    }
    return;
  }

  // Opportunistic seal: profile has no cloudId yet (pre-5.5 setup). Write it
  // back to the keychain so future startups are protected. Read the current
  // entry first so we preserve url/email/apiToken exactly as stored.
  const stored = await readFromKeychain(profile);
  if (!stored) {
    // Shouldn't happen — we just resolved from this profile. Skip silently.
    return;
  }
  try {
    await saveToKeychain(
      {
        ...stored,
        cloudId: liveCloudId,
        tenantDisplayName: liveDisplayName,
      },
      profile
    );
    console.error(
      `epimethian-mcp: sealed profile "${profile}" to tenant "${liveDisplayName}" ` +
        `(cloudId ${liveCloudId}). Future startups will verify this seal.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `epimethian-mcp: warning — could not write tenant seal for profile "${profile}" (${message}). ` +
        `Continuing without seal; will retry on next startup.`
    );
  }
}

// --- Zod response schemas (runtime validation) ---

export const PageSchema = z.object({
  id: z.string(),
  title: z.string(),
  spaceId: z.string().optional(),
  space: z.object({ key: z.string() }).optional(),
  version: z.object({ number: z.number() }).optional(),
  excerpt: z.string().optional(),
  body: z
    .object({
      storage: z.object({ value: z.string() }).optional(),
      value: z.string().optional(),
    })
    .optional(),
  _links: z
    .object({
      base: z.string().optional(),
      webui: z.string().optional(),
    })
    .optional(),
});

export type PageData = z.infer<typeof PageSchema>;

const PagesResultSchema = z.object({
  results: z.array(PageSchema).default([]),
});

const SpaceSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
});

const SpacesResultSchema = z.object({
  results: z.array(SpaceSchema).default([]),
});

export type SpaceData = z.infer<typeof SpaceSchema>;

const AttachmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  extensions: z
    .object({
      fileSize: z.number().optional(),
      mediaType: z.string().optional(),
    })
    .optional(),
  _links: z.object({ download: z.string().optional() }).optional(),
});

const AttachmentsResultSchema = z.object({
  results: z.array(AttachmentSchema).default([]),
});

export type AttachmentData = z.infer<typeof AttachmentSchema>;

export const LabelSchema = z.object({
  id: z.string(),
  prefix: z.enum(["global", "my", "team", "system"]),
  name: z.string(),
});

export type LabelData = z.infer<typeof LabelSchema>;

const LabelsResultSchema = z.object({
  results: z.array(LabelSchema).default([]),
});

// Content state (page status badge) — v1 only
export const ContentStateSchema = z.object({
  name: z.string(),
  color: z.string(),
}).strict();

export type ContentStateData = z.infer<typeof ContentStateSchema>;

export const CommentSchema = z.object({
  id: z.string().regex(/^\d+$/),
  status: z.string().optional(),
  pageId: z.string().optional(),
  parentCommentId: z.string().nullable().optional(),
  version: z.object({
    number: z.number(),
    createdAt: z.string().optional(),
    authorId: z.string().optional(),
  }).optional(),
  body: z.object({
    storage: z.object({ value: z.string() }).optional(),
  }).optional(),
  resolutionStatus: z.string().optional(),
  _links: z.object({ webui: z.string().optional() }).optional(),
});

export type CommentData = z.infer<typeof CommentSchema>;

const CommentsResultSchema = z.object({
  results: z.array(CommentSchema).default([]),
});

const UploadResultSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        id: z.string(),
        extensions: z.object({ fileSize: z.number().optional() }).optional(),
      })
    )
    .default([]),
});

// --- Version history schemas ---

const VersionMetadataSchema = z.object({
  number: z.number(),
  by: z.object({
    displayName: z.string(),
    accountId: z.string(),
  }),
  when: z.string(),
  message: z.string().default(""),
  minorEdit: z.boolean(),
});

export type VersionMetadata = z.infer<typeof VersionMetadataSchema>;

const VersionsResultSchema = z.object({
  results: z.array(VersionMetadataSchema).default([]),
});

const V1PageVersionSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.object({ number: z.number() }),
  body: z.object({
    storage: z.object({ value: z.string() }),
  }),
});

// --- Error sanitization ---

/**
 * Sanitize error messages before they reach the MCP client.
 * Truncates to 500 chars and strips anything resembling credentials.
 * Full error details should be logged to stderr separately.
 */
export function sanitizeError(message: string): string {
  let safe = message.slice(0, 500);
  // Strip Basic auth tokens (base64-encoded credentials)
  safe = safe.replace(/Basic [A-Za-z0-9+/=]{20,}/g, "Basic [REDACTED]");
  // Strip Authorization headers
  safe = safe.replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]");
  // Strip Bearer tokens
  safe = safe.replace(/Bearer [A-Za-z0-9._-]{20,}/g, "Bearer [REDACTED]");
  return safe;
}

// --- Error classes ---

export class ConfluenceApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Confluence API error (${status}): ${sanitizeError(body)}`);
    this.name = "ConfluenceApiError";
    this.status = status;
  }
}

export class ConfluenceAuthError extends ConfluenceApiError {}        // 401

export class ConfluencePermissionError extends ConfluenceApiError {}  // 403

export class ConfluenceNotFoundError extends ConfluenceApiError {}    // 404

export class ConfluenceConflictError extends Error {
  constructor(pageId: string) {
    super(
      `Version conflict: page ${pageId} has been modified since you last read it. ` +
      `Call get_page to fetch the latest version, then retry your update with the new version number.`
    );
    this.name = "ConfluenceConflictError";
  }
}

// --- HTTP helpers ---

async function confluenceRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const cfg = await getConfig();
  const res = await fetch(url, { headers: cfg.jsonHeaders, ...options });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Confluence API error (${res.status}): ${sanitizeError(body)}`);

    if (res.status === 401) {
      throw new ConfluenceAuthError(res.status, body);
    } else if (res.status === 403) {
      throw new ConfluencePermissionError(res.status, body);
    } else if (res.status === 404) {
      throw new ConfluenceNotFoundError(res.status, body);
    } else {
      throw new ConfluenceApiError(res.status, body);
    }
  }
  return res;
}

async function v2Get(
  path: string,
  params?: Record<string, string | number>
): Promise<unknown> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV2}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await confluenceRequest(url.toString());
  return res.json();
}

async function v2Post(path: string, body: unknown): Promise<unknown> {
  const cfg = await getConfig();
  const res = await confluenceRequest(`${cfg.apiV2}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

async function v2Put(path: string, body: unknown): Promise<unknown> {
  const cfg = await getConfig();
  const res = await confluenceRequest(`${cfg.apiV2}${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return res.json();
}

async function v2Delete(path: string): Promise<void> {
  const cfg = await getConfig();
  await confluenceRequest(`${cfg.apiV2}${path}`, { method: "DELETE" });
}

// --- Public API ---

export async function resolveSpaceId(spaceKey: string): Promise<string> {
  const raw = await v2Get("/spaces", { keys: spaceKey, limit: 1 });
  const data = SpacesResultSchema.parse(raw);
  const space = data.results[0];
  if (!space) throw new Error(`Space '${spaceKey}' not found`);
  return space.id;
}

export async function getPage(
  pageId: string,
  includeBody: boolean
): Promise<PageData> {
  if (!includeBody) {
    const raw = await v2Get(`/pages/${pageId}`, {});
    return PageSchema.parse(raw);
  }

  // Check if this page is in the cache
  const cached = pageCache.has(pageId);
  if (cached) {
    // Fetch metadata only (no body) to check version
    const raw = await v2Get(`/pages/${pageId}`, {});
    const page = PageSchema.parse(raw);
    const version = page.version?.number ?? 0;
    const body = pageCache.get(pageId, version);
    if (body !== undefined) {
      // Cache hit — inject the cached body into the page data
      return { ...page, body: { storage: { value: body } } };
    }
  }

  // Cache miss or never seen — full fetch
  const raw = await v2Get(`/pages/${pageId}`, { "body-format": "storage" });
  const page = PageSchema.parse(raw);
  const body = page.body?.storage?.value ?? page.body?.value;
  if (body !== undefined) {
    pageCache.set(pageId, page.version?.number ?? 0, body);
  }
  return page;
}

export async function _rawCreatePage(
  spaceId: string,
  title: string,
  body: string,
  parentId?: string,
  clientLabel?: string
): Promise<PageData> {
  const cfg = await getConfig();
  const pageBody = normalizeBodyForSubmit(body);

  const epimethianTag = `Epimethian v${__PKG_VERSION__}`;
  const versionMsg = cfg.attribution && clientLabel
    ? `Created by ${clientLabel} (via ${epimethianTag})`
    : `Created by ${epimethianTag}`;
  const payload: Record<string, unknown> = {
    title,
    spaceId,
    status: "current",
    body: {
      representation: "storage",
      value: pageBody,
    },
    version: { message: versionMsg },
  };
  if (parentId) payload.parentId = parentId;
  const raw = await v2Post("/pages", payload);
  const page = PageSchema.parse(raw);

  // Cache the body we just sent (new pages start at version 1)
  pageCache.set(page.id, page.version?.number ?? 1, pageBody);

  // ensureAttributionLabel is now called by the handler via safeSubmitPage's
  // caller chain so warnings can be surfaced. No call here.

  return page;
}

export async function _rawUpdatePage(
  pageId: string,
  opts: {
    title: string;
    body?: string;
    version: number;
    versionMessage?: string;
    previousBody?: string;
    clientLabel?: string;
    /**
     * Track C3: when non-empty, a `[destructive: ...]` suffix is appended
     * to the Confluence version message so the Confluence UI's own history
     * view shows which destructive flags were in effect — no dependency on
     * the local mutation log.
     */
    destructiveFlags?: string[];
  }
): Promise<{ page: PageData; newVersion: number }> {
  const cfg = await getConfig();
  const newVersion = opts.version + 1;

  const epimethianTag = `Epimethian v${__PKG_VERSION__}`;
  const effectiveClient = cfg.attribution ? opts.clientLabel : undefined;

  let versionMessage: string;
  if (opts.versionMessage && effectiveClient)
    versionMessage = `${opts.versionMessage} (${effectiveClient} via ${epimethianTag})`;
  else if (opts.versionMessage)
    versionMessage = `${opts.versionMessage} (via ${epimethianTag})`;
  else if (effectiveClient)
    versionMessage = `Updated by ${effectiveClient} (via ${epimethianTag})`;
  else
    versionMessage = `Updated by ${epimethianTag}`;

  // C3: append destructive-flag metadata so Confluence's version history
  // records it too. Cap the combined length so we never exceed Confluence's
  // 500-char version-message limit.
  if (opts.destructiveFlags && opts.destructiveFlags.length > 0) {
    const suffix = ` [destructive: ${opts.destructiveFlags.join(", ")}]`;
    const combined = versionMessage + suffix;
    versionMessage = combined.length > 500 ? combined.slice(0, 500) : combined;
  }

  // Compute the cleaned body ONCE — avoids double-execution of
  // stripAttributionFooter which could diverge if regex state drifts.
  const pageBody = opts.body
    ? normalizeBodyForSubmit(opts.body)
    : undefined;

  const payload: Record<string, unknown> = {
    id: pageId,
    status: "current",
    title: opts.title,
    version: { number: newVersion, message: versionMessage },
  };
  if (pageBody !== undefined) {
    payload.body = {
      representation: "storage",
      value: pageBody,
    };
  }

  // Pre-write snapshot for recovery
  if (opts.previousBody !== undefined) {
    pageCache.setSnapshot(pageId, opts.version, opts.previousBody);
  }

  let raw: unknown;
  try {
    raw = await v2Put(`/pages/${pageId}`, payload);
  } catch (err) {
    if (err instanceof ConfluenceApiError && err.status === 409) {
      throw new ConfluenceConflictError(pageId);
    }
    throw err;
  }
  const page = PageSchema.parse(raw);

  // Cache the body we just sent (reuse pre-computed pageBody)
  if (pageBody !== undefined) {
    pageCache.set(pageId, newVersion, pageBody);
  }

  // ensureAttributionLabel is now called by the handler via safeSubmitPage's
  // caller chain so warnings can be surfaced. No call here.

  return { page, newVersion };
}

/**
 * Delete a Confluence page.
 *
 * If `expectedVersion` is provided (Track B1), the current page version is
 * fetched first and compared — mismatch throws ConfluenceConflictError so
 * stale-context agent loops cannot delete pages that were edited since
 * their last read.
 *
 * When `expectedVersion` is omitted, the legacy path (no version check) is
 * taken; handler-level opt-out gates this via
 * EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION.
 */
export async function deletePage(
  pageId: string,
  expectedVersion?: number,
): Promise<void> {
  if (expectedVersion !== undefined) {
    const page = await v2Get(`/pages/${pageId}`, {});
    const parsed = PageSchema.parse(page);
    const actualVersion = parsed.version?.number;
    if (actualVersion !== undefined && actualVersion !== expectedVersion) {
      throw new ConfluenceConflictError(pageId);
    }
  }
  await v2Delete(`/pages/${pageId}`);
  pageCache.delete(pageId);
}

export async function searchPages(
  cql: string,
  limit: number
): Promise<PageData[]> {
  // Use /rest/api/search (not /content/search) to get excerpts
  const cfg = await getConfig();
  const url = new URL(`${cfg.url}/wiki/rest/api/search`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("limit", String(limit));
  const res = await confluenceRequest(url.toString());
  const raw = await res.json() as any;
  // /rest/api/search nests page data under `content` with excerpt at result level
  // Flatten into PageSchema-compatible shape
  const results: PageData[] = [];
  for (const r of raw.results ?? []) {
    const page = r.content ?? r;
    if (r.excerpt) page.excerpt = r.excerpt;
    try {
      results.push(PageSchema.parse(page));
    } catch {
      // Skip unparseable results (e.g., attachments, comments)
    }
  }
  return results;
}

export async function listPages(
  spaceId: string,
  limit: number,
  status: string
): Promise<PageData[]> {
  const raw = await v2Get("/pages", {
    "space-id": spaceId,
    limit,
    status,
  });
  return PagesResultSchema.parse(raw).results;
}

export async function getPageChildren(
  pageId: string,
  limit: number
): Promise<PageData[]> {
  const raw = await v2Get(`/pages/${pageId}/children`, { limit });
  return PagesResultSchema.parse(raw).results;
}

export async function getSpaces(
  limit: number,
  type?: string
): Promise<SpaceData[]> {
  const params: Record<string, string | number> = { limit };
  if (type) params.type = type;
  const raw = await v2Get("/spaces", params);
  return SpacesResultSchema.parse(raw).results;
}

export async function getPageByTitle(
  spaceId: string,
  title: string,
  includeBody: boolean
): Promise<PageData | undefined> {
  const params: Record<string, string | number> = {
    "space-id": spaceId,
    title,
    limit: 1,
  };
  if (includeBody) params["body-format"] = "storage";
  const raw = await v2Get("/pages", params);
  return PagesResultSchema.parse(raw).results[0];
}

// --- User search ---

export interface UserResult {
  accountId: string;
  displayName: string;
  email: string;
}

const UserSchema = z.object({
  user: z.object({
    accountId: z.string(),
    displayName: z.string(),
    email: z.string().optional().default(""),
  }),
});

const UserSearchResultSchema = z.object({
  results: z.array(UserSchema).default([]),
});

/**
 * Search for Confluence/Atlassian users by name, display name, or email substring.
 * Uses the v1 CQL user search endpoint. Returns at most `limit` matches.
 */
export async function searchUsers(
  query: string,
  limit = 10
): Promise<UserResult[]> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/search/user`);
  url.searchParams.set("cql", `user.fullname~"${query.replace(/"/g, '\\"')}"`);
  url.searchParams.set("limit", String(Math.min(limit, 10)));
  const res = await confluenceRequest(url.toString());
  const raw = await res.json();
  const data = UserSearchResultSchema.parse(raw);
  return data.results.map((r) => ({
    accountId: r.user.accountId,
    displayName: r.user.displayName,
    email: r.user.email,
  }));
}

// --- Page search by title and space key ---

export interface PageLinkResult {
  contentId: string;
  url: string;
  spaceKey: string;
  title: string;
}

/**
 * Search for a Confluence page by exact title within a space (identified by key).
 * Uses CQL via the v1 search endpoint. Returns all matches (caller decides ambiguity policy).
 */
export async function searchPagesByTitle(
  title: string,
  spaceKey: string
): Promise<PageLinkResult[]> {
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedSpace = spaceKey.replace(/"/g, '\\"');
  const cql = `title="${escapedTitle}" AND space.key="${escapedSpace}" AND type=page`;
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/search`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("limit", "10");
  url.searchParams.set("expand", "space");
  const res = await confluenceRequest(url.toString());
  const raw = (await res.json()) as any;

  const results: PageLinkResult[] = [];
  for (const r of raw.results ?? []) {
    const content = r.content ?? r;
    const id = content.id as string | undefined;
    const pageTitle = (content.title ?? r.title) as string | undefined;
    const spaceObj = content.space ?? r.space;
    const key = (spaceObj?.key ?? spaceKey) as string;
    const links = content._links ?? r._links ?? {};
    const base: string = links.base ?? cfg.url + "/wiki";
    const webui: string = links.webui ?? "";
    if (!id || !pageTitle) continue;
    results.push({
      contentId: id,
      url: webui ? `${base}${webui}` : `${cfg.url}/wiki/spaces/${key}/pages/${id}`,
      spaceKey: key,
      title: pageTitle,
    });
  }
  return results;
}

export async function getAttachments(
  pageId: string,
  limit: number
): Promise<AttachmentData[]> {
  // Attachments only available via v1 REST API
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/child/attachment`);
  url.searchParams.set("limit", String(limit));
  const res = await confluenceRequest(url.toString());
  const raw = await res.json();
  return AttachmentsResultSchema.parse(raw).results;
}

// --- Version history ---

export async function getPageVersions(
  pageId: string,
  limit: number
): Promise<VersionMetadata[]> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/version`);
  url.searchParams.set("limit", String(limit));
  const res = await confluenceRequest(url.toString());
  const raw = await res.json();
  const data = VersionsResultSchema.parse(raw);
  // Truncate messages (untrusted user content)
  return data.results.map((v) => ({
    ...v,
    message: v.message.slice(0, 500),
  }));
}

export async function getPageVersionBody(
  pageId: string,
  version: number
): Promise<{ title: string; rawBody: string; version: number }> {
  // Check versioned cache first
  const cached = pageCache.getVersioned(pageId, version);
  if (cached !== undefined) {
    // Body is cached — lightweight metadata fetch for title
    const raw = await v2Get(`/pages/${pageId}`, {});
    const page = PageSchema.parse(raw);
    return { title: page.title, rawBody: cached, version };
  }

  // Cache miss — full v1 fetch with body
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}`);
  url.searchParams.set("version", String(version));
  url.searchParams.set("expand", "body.storage,version");
  const res = await confluenceRequest(url.toString());
  const raw = await res.json();
  const data = V1PageVersionSchema.parse(raw);
  const rawBody = data.body.storage.value;

  // Cache the raw body for reuse by diff
  pageCache.setVersioned(pageId, version, rawBody);

  return { title: data.title, rawBody, version: data.version.number };
}

export async function uploadAttachment(
  pageId: string,
  fileData: Buffer | Uint8Array,
  filename: string,
  comment?: string
): Promise<{ title: string; id: string; fileSize?: number }> {
  // Attachments only available via v1 REST API
  const cfg = await getConfig();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fileData)]), filename);
  if (comment) form.append("comment", comment);

  const attachUrl = `${cfg.apiV1}/content/${pageId}/child/attachment`;
  const res = await fetch(attachUrl, {
    method: "POST",
    headers: {
      Authorization: cfg.authHeader,
      "X-Atlassian-Token": "nocheck",
    },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Confluence API error (${res.status}): ${sanitizeError(body)}`);
    throw new ConfluenceApiError(res.status, body);
  }
  const data = UploadResultSchema.parse(await res.json());
  const att = data.results[0];
  if (!att) throw new Error("Attachment uploaded but no details returned.");
  return { title: att.title, id: att.id, fileSize: att.extensions?.fileSize };
}

// --- Attribution ---

const ATTRIBUTION_LABEL = "epimethian-edited";
const LEGACY_ATTRIBUTION_LABEL = "epimethian-managed";

/**
 * Ensure the page carries the current attribution label and not the legacy one.
 *
 * Returns `{}` on success, `{ warning }` when the token lacks permission to
 * manage labels (403 / ConfluencePermissionError), and re-throws on any other
 * error (e.g. 500 – a genuine infrastructure failure should not be masked).
 *
 * Track G: callers collect the warning and surface it through appendWarnings.
 */
export async function ensureAttributionLabel(
  pageId: string
): Promise<{ warning?: string }> {
  try {
    await addLabels(pageId, [ATTRIBUTION_LABEL]);
    const labels = await getLabels(pageId);
    if (labels.some((l) => l.name === LEGACY_ATTRIBUTION_LABEL)) {
      await removeLabel(pageId, LEGACY_ATTRIBUTION_LABEL);
    }
    return {};
  } catch (err) {
    if (err instanceof ConfluencePermissionError) {
      return {
        warning:
          `Could not apply 'epimethian-edited' label (permission denied). ` +
          `Provenance label is missing for page ${pageId}.`,
      };
    }
    throw err;
  }
}

/**
 * Strip legacy attribution footers from page bodies.
 * Retained for cleanup of pages written by older versions that appended
 * a visible footer. New versions no longer add a footer — attribution
 * lives in Confluence version messages instead.
 */
function stripAttributionFooter(body: string): string {
  return body
    .replace(
      /<!--\s*epimethian-attribution-start\s*-->[\s\S]*?<!--\s*epimethian-attribution-end\s*-->/g,
      ""
    )
    .replace(
      // Also strip bare (unmarked) attribution paragraphs — these appear
      // when an agent copies page content from get_page and passes it
      // back to update_page without removing the footer.
      // Use (?:(?!<\/p>)[\s\S])*? instead of [\s\S]*? to prevent crossing
      // </p> boundaries — without this, the match spans from the first <p>
      // in the document to the attribution link, wiping the entire body.
      /<p[^>]*>(?:(?!<\/p>)[\s\S])*?<a\s[^>]*href="https:\/\/github\.com\/de-otio\/epimethian-mcp"[^>]*>(?:<em>)?Epimethian(?:<\/em>)?<\/a>(?:(?!<\/p>)[\s\S])*?<\/p>/gi,
      ""
    )
    .trimEnd();
}

/**
 * Shared body normalization used by both `_rawCreatePage`/`_rawUpdatePage`
 * (before submitting) and `safeSubmitPage` (for the byte-identical
 * short-circuit). The two call sites MUST normalise via the same function
 * so the comparison is meaningful — if they diverge, the short-circuit
 * could incorrectly short-circuit (false negative) or falsely PUT a
 * no-op (false positive).
 */
export function normalizeBodyForSubmit(body: string): string {
  return stripAttributionFooter(toStorageFormat(body));
}

export async function getLabels(pageId: string): Promise<LabelData[]> {
  const cfg = await getConfig();
  const res = await confluenceRequest(
    `${cfg.apiV1}/content/${pageId}/label`
  );
  const data = LabelsResultSchema.parse(await res.json());
  return data.results;
}

export async function addLabels(
  pageId: string,
  labels: string[]
): Promise<void> {
  const cfg = await getConfig();
  await confluenceRequest(`${cfg.apiV1}/content/${pageId}/label`, {
    method: "POST",
    body: JSON.stringify(labels.map((name) => ({ prefix: "global", name }))),
  });
}

export async function removeLabel(
  pageId: string,
  label: string
): Promise<void> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/label`);
  url.searchParams.set("name", label);
  await confluenceRequest(url.toString(), { method: "DELETE" });
}

// --- Site settings (default locale) ---

/**
 * Cache of site default-locale probes keyed by tenant base URL.
 * Stores the in-flight Promise so concurrent callers share one request.
 * Value resolves to a lowercase language subtag (e.g. "de") or undefined
 * if the probe failed or returned nothing usable.
 */
const _siteLocaleCache = new Map<string, Promise<string | undefined>>();

/** Test hook: clear the site-locale cache. */
export function _resetSiteLocaleCacheForTests(): void {
  _siteLocaleCache.clear();
}

/**
 * Probes Confluence's site-wide default language via
 * `GET /wiki/rest/api/settings/systemInfo` and returns the language subtag
 * (e.g. `"de_DE"` → `"de"`). Cached per tenant URL for the process lifetime.
 *
 * Never throws: returns `undefined` on any failure (auth, network, missing
 * scope, malformed payload). The caller (`pickLocale`) falls back to `"en"`.
 */
export async function getSiteDefaultLocale(cfg: Config): Promise<string | undefined> {
  const key = cfg.url;
  const cached = _siteLocaleCache.get(key);
  if (cached !== undefined) return cached;

  const promise = (async () => {
    try {
      const res = await confluenceRequest(`${cfg.apiV1}/settings/systemInfo`);
      const data = (await res.json()) as { defaultLocale?: unknown };
      const raw = typeof data?.defaultLocale === "string" ? data.defaultLocale : undefined;
      if (!raw) return undefined;
      // Confluence returns "en_GB"/"de_DE"; normalize to "en"/"de".
      return raw.split(/[_-]/)[0].toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  })();

  _siteLocaleCache.set(key, promise);
  return promise;
}

// --- Content State (page status badge) ---

export async function getContentState(
  pageId: string
): Promise<ContentStateData | null> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/state`);
  url.searchParams.set("status", "current");
  try {
    const res = await confluenceRequest(url.toString());
    const data = await res.json();
    // Confluence Cloud returns the state wrapped:
    //   { "contentState": { "id": …, "name": …, "color": … }, "lastUpdated": … }
    // When no state is set: { "contentState": null } (or an older shape with
    // just name/color at the top level on some DC variants).
    const state =
      data && typeof data === "object" && "contentState" in data
        ? (data as { contentState: unknown }).contentState
        : data;
    if (!state || typeof state !== "object") return null;
    const s = state as { name?: unknown; color?: unknown };
    if (typeof s.name !== "string" || typeof s.color !== "string") return null;
    return ContentStateSchema.parse({ name: s.name, color: s.color });
  } catch (err) {
    if (err instanceof ConfluenceApiError && err.status === 404) return null;
    throw err;
  }
}

export async function setContentState(
  pageId: string,
  name: string,
  color: string,
  attempt = 0
): Promise<void> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/state`);
  url.searchParams.set("status", "current");
  try {
    await confluenceRequest(url.toString(), {
      method: "PUT",
      body: JSON.stringify({ name, color }),
    });
  } catch (err) {
    if (err instanceof ConfluenceApiError && err.status === 409 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return setContentState(pageId, name, color, attempt + 1);
    }
    throw err;
  }
}

export async function removeContentState(pageId: string): Promise<void> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/state`);
  url.searchParams.set("status", "current");
  try {
    await confluenceRequest(url.toString(), { method: "DELETE" });
  } catch (err) {
    // Idempotent — removing a status that doesn't exist is not an error
    if (err instanceof ConfluenceApiError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
}

export async function getFooterComments(
  pageId: string,
  limit = 250
): Promise<CommentData[]> {
  const raw = await v2Get(`/pages/${pageId}/footer-comments`, {
    "body-format": "storage",
    limit,
  });
  return CommentsResultSchema.parse(raw).results;
}

export async function getInlineComments(
  pageId: string,
  resolutionStatus: "open" | "resolved" | "all",
  limit = 250
): Promise<CommentData[]> {
  const params: Record<string, string | number> = {
    "body-format": "storage",
    limit,
  };
  if (resolutionStatus !== "all") {
    params["resolution-status"] = resolutionStatus;
  }
  const raw = await v2Get(`/pages/${pageId}/inline-comments`, params);
  return CommentsResultSchema.parse(raw).results;
}

export async function getCommentReplies(
  commentId: string,
  type: "footer" | "inline"
): Promise<CommentData[]> {
  const path =
    type === "footer"
      ? `/footer-comments/${commentId}/children`
      : `/inline-comments/${commentId}/children`;
  const raw = await v2Get(path, { "body-format": "storage", limit: 250 });
  return CommentsResultSchema.parse(raw).results;
}

export async function createFooterComment(
  pageId: string,
  body: string,
  parentCommentId?: string
): Promise<CommentData> {
  const cfg = await getConfig();
  const sanitized = sanitizeCommentBody(toStorageFormat(body));
  const label = cfg.attribution ? _clientLabel : undefined;
  const attributed = label
    ? `<p><em>[AI-generated by ${escapeXmlText(label)} via Epimethian]</em></p>${sanitized}`
    : `<p><em>[AI-generated via Epimethian]</em></p>${sanitized}`;

  const payload: Record<string, unknown> = parentCommentId
    ? {
        parentCommentId,
        body: { representation: "storage", value: attributed },
      }
    : {
        pageId,
        body: { representation: "storage", value: attributed },
      };

  const raw = await v2Post("/footer-comments", payload);
  return CommentSchema.parse(raw);
}

export async function createInlineComment(
  pageId: string,
  body: string,
  textSelection: string,
  textSelectionMatchIndex = 0,
  parentCommentId?: string
): Promise<CommentData> {
  const cfg = await getConfig();
  const sanitized = sanitizeCommentBody(toStorageFormat(body));
  const label = cfg.attribution ? _clientLabel : undefined;
  const attributed = label
    ? `<p><em>[AI-generated by ${escapeXmlText(label)} via Epimethian]</em></p>${sanitized}`
    : `<p><em>[AI-generated via Epimethian]</em></p>${sanitized}`;

  if (parentCommentId) {
    const raw = await v2Post("/inline-comments", {
      parentCommentId,
      body: { representation: "storage", value: attributed },
    });
    return CommentSchema.parse(raw);
  }

  const page = await getPage(pageId, true);
  const pageBody = page.body?.storage?.value ?? page.body?.value ?? "";

  let count = 0;
  let idx = pageBody.indexOf(textSelection);
  while (idx !== -1) {
    count++;
    idx = pageBody.indexOf(textSelection, idx + 1);
  }

  if (count === 0) {
    throw new Error(
      `Text selection "${textSelection}" not found in page body. ` +
        `Verify the exact text to highlight (case-sensitive, whitespace-sensitive).`
    );
  }
  if (textSelectionMatchIndex >= count) {
    throw new Error(
      `textSelectionMatchIndex ${textSelectionMatchIndex} is out of range — ` +
        `found ${count} occurrence(s) of the selected text. Use index 0–${count - 1}.`
    );
  }

  const raw = await v2Post("/inline-comments", {
    pageId,
    body: { representation: "storage", value: attributed },
    inlineCommentProperties: {
      textSelection,
      textSelectionMatchCount: count,
      textSelectionMatchIndex,
    },
  });
  return CommentSchema.parse(raw);
}

export async function resolveComment(
  commentId: string,
  resolved: boolean,
  attempt = 0
): Promise<CommentData> {
  const raw = await v2Get(`/inline-comments/${commentId}`, {
    "body-format": "storage",
  });
  const comment = CommentSchema.parse(raw);

  if (comment.resolutionStatus === "dangling") {
    throw new Error(
      `Comment ${commentId} is dangling — its highlighted text has been edited away. ` +
        `Dangling comments cannot be resolved or reopened.`
    );
  }

  const currentVersion = comment.version?.number ?? 1;

  const putPayload: Record<string, unknown> = {
    version: { number: currentVersion + 1 },
    resolved,
  };

  let result: unknown;
  try {
    result = await v2Put(`/inline-comments/${commentId}`, putPayload);
  } catch (err) {
    if (err instanceof ConfluenceApiError && err.status === 409 && attempt < 2) {
      return resolveComment(commentId, resolved, attempt + 1);
    }
    throw err;
  }

  return CommentSchema.parse(result);
}

export async function deleteFooterComment(commentId: string): Promise<void> {
  await v2Delete(`/footer-comments/${commentId}`);
}

export async function deleteInlineComment(commentId: string): Promise<void> {
  await v2Delete(`/inline-comments/${commentId}`);
}

// --- Formatting helpers ---

const DANGEROUS_TAG_RE =
  /<(ac:structured-macro|script|iframe|embed|object)[\s\S]*?<\/\1>|<(ac:structured-macro|script|iframe|embed|object)[^>]*\/>/gi;

export function sanitizeCommentBody(body: string): string {
  const stripped = body.replace(DANGEROUS_TAG_RE, "");
  if (stripped !== body) {
    console.error(
      "epimethian-mcp: sanitizeCommentBody stripped dangerous tags from comment body"
    );
  }
  return stripped;
}

const HTML_TAG_RE = /<\/?[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)?[\s>\/]/i;
const HTML_ENTITY_RE = /&(?:[a-zA-Z]+|#x?[0-9a-fA-F]+);/;

export function toStorageFormat(body: string): string {
  if (HTML_TAG_RE.test(body) || HTML_ENTITY_RE.test(body)) return body;
  return `<p>${body}</p>`;
}

/** Decode HTML entities in a string (no external dep). */
function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    // XML basics
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    // Whitespace
    nbsp: " ",
    // German
    uuml: "ü", auml: "ä", ouml: "ö", szlig: "ß",
    Uuml: "Ü", Auml: "Ä", Ouml: "Ö",
    // French
    eacute: "é", egrave: "è", agrave: "à", ecirc: "ê",
    ccedil: "ç", ocirc: "ô", icirc: "î", ucirc: "û",
    // Common typographic
    mdash: "—", ndash: "–", laquo: "«", raquo: "»",
    hellip: "…", ldquo: "“", rdquo: "”",
    lsquo: "‘", rsquo: "’",
    // Currency / misc
    euro: "€", copy: "©", reg: "®", trade: "™",
  };
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_full, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      return String.fromCodePoint(parseInt(ref.slice(2), 16));
    }
    if (ref.startsWith("#")) {
      return String.fromCodePoint(parseInt(ref.slice(1), 10));
    }
    return named[ref] ?? _full;
  });
}

/** Numeric-prefix pattern, e.g. "1." or "1.2." or "1.2.3." with optional trailing space. */
const OUTLINE_PREFIX_RE = /^\d+(?:\.\d+)*\.\s*/;

/**
 * Extract headings from Confluence storage format HTML.
 * Returns a numbered outline string, e.g.:
 *   1. Introduction
 *   1.1. Background
 *   1.2. Lesereihenfolge        ← stored as "1.2. Lesereihenfolge"; prefix not doubled
 *   2. Architecture
 */
export function extractHeadings(storageHtml: string): string {
  const headingRe = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
  const counters = [0, 0, 0, 0, 0, 0]; // h1–h6
  const lines: string[] = [];
  let match;

  while ((match = headingRe.exec(storageHtml)) !== null) {
    const level = parseInt(match[1], 10);
    // Reset all deeper counters
    for (let i = level; i < 6; i++) counters[i] = 0;
    counters[level - 1]++;
    const syntheticNumber = counters.slice(0, level).filter(n => n > 0).join(".");
    // Strip HTML tags, then decode entities
    const raw = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    // If the stored text already begins with the same numeric prefix we would
    // generate (e.g. "1.2. Lesereihenfolge" vs synthetic "1.2."), use the
    // raw text as-is to avoid duplication ("1.2. 1.2. Lesereihenfolge").
    // OUTLINE_PREFIX_RE matches "1.2." with optional trailing space;
    // syntheticNumber is "1.2" (no dot), so we compare against syntheticNumber+".".
    const headingPrefixMatch = raw.match(OUTLINE_PREFIX_RE);
    const syntheticPrefix = syntheticNumber + ". ";
    const text =
      headingPrefixMatch !== null &&
      headingPrefixMatch[0].trimEnd() === syntheticNumber + "."
        ? raw                    // already has this number — use as-is
        : `${syntheticPrefix}${raw}`;
    lines.push(`${"  ".repeat(level - 1)}${text}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no headings found)";
}

/**
 * Replace every `<![CDATA[...]]>` block in storage with a same-length run of
 * spaces so node-html-parser can parse the surrounding structure without
 * being derailed by the CDATA payload.
 *
 * Why: node-html-parser has no notion of CDATA. When it encounters `<![CDATA[`
 * it just keeps reading as HTML, so content like `` `<resource>.<access_mode>` ``
 * inside a `<ac:plain-text-body><![CDATA[...]]></ac:plain-text-body>` gets
 * parsed as nested `<resource>`/`<access_mode>` tags, the inner text is lost,
 * and the enclosing `</ac:plain-text-body>` and `</ac:structured-macro>` close
 * tags get attached to the wrong subtree — so sibling scans don't find the
 * next heading, `toString()` re-serialisation drops the CDATA, and an
 * `innerHTML = ...` round-trip destroys the code macro.
 *
 * Masking with same-length whitespace preserves every byte offset in the
 * string, so we can parse the masked copy to discover structure, then slice
 * the ORIGINAL string by the reported `.range` offsets to preserve CDATA
 * byte-for-byte. This affects only read-side DOM traversal; the output is
 * always built from the unmasked source.
 */
function maskCdataForParse(storage: string): string {
  return storage.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));
}

/**
 * Find a heading element anywhere in the DOM tree (including inside
 * ac:layout cells) whose text matches the target. Returns the heading
 * element and its sibling list within the parent container, or null.
 *
 * Matching strategy (strict → tolerant):
 *  1. Exact case-insensitive match on decoded heading text.
 *  2. If zero exact matches, retry stripping a leading numeric outline
 *     prefix (e.g. "1.2. ") from BOTH the stored heading text and the
 *     search term before comparing.  This lets a caller supply either
 *     "Lesereihenfolge" or "1.2. Lesereihenfolge" and resolve the same
 *     heading regardless of how it is stored.
 *  3. Ambiguity guard: if the stripped fallback yields >1 hit, prefer
 *     whichever also has an exact-text match; if still >1, throw rather
 *     than silently picking the wrong one.
 */
function findHeadingInTree(
  root: import("node-html-parser").HTMLElement,
  headingText: string
): { siblings: import("node-html-parser").Node[]; startIdx: number; headingLevel: number } | null {
  type HTMLElement = import("node-html-parser").HTMLElement;

  /** Build the return value for a matched heading element, or null if the
   *  heading has no valid parent-child relationship. */
  function resultFor(heading: HTMLElement): { siblings: import("node-html-parser").Node[]; startIdx: number; headingLevel: number } | null {
    const tagMatch = heading.tagName.match(/^H([1-6])$/i);
    if (!tagMatch) return null;
    const parent = heading.parentNode as HTMLElement;
    const siblings = parent.childNodes;
    const startIdx = siblings.indexOf(heading);
    if (startIdx === -1) return null;
    return { siblings, startIdx, headingLevel: parseInt(tagMatch[1], 10) };
  }

  // Depth-first search for all heading elements
  const allHeadings = root.querySelectorAll("h1, h2, h3, h4, h5, h6") as HTMLElement[];

  // Pass 1 — exact (case-insensitive, entity-decoded) match
  const needle = headingText.toLowerCase();
  const exactMatches: HTMLElement[] = [];
  for (const heading of allHeadings) {
    const storedText = decodeHtmlEntities(heading.text.trim()).toLowerCase();
    if (storedText === needle) exactMatches.push(heading);
  }
  if (exactMatches.length > 0) {
    // Use first exact match (exact equality means no ambiguity risk)
    for (const h of exactMatches) {
      const r = resultFor(h);
      if (r) return r;
    }
  }

  // Pass 2 — tolerant stripped match (only when exact yielded zero hits)
  const strippedNeedle = needle.replace(OUTLINE_PREFIX_RE, "");
  const strippedMatches: HTMLElement[] = [];
  for (const heading of allHeadings) {
    const storedText = decodeHtmlEntities(heading.text.trim()).toLowerCase();
    const strippedStored = storedText.replace(OUTLINE_PREFIX_RE, "");
    if (strippedStored === strippedNeedle) strippedMatches.push(heading);
  }

  if (strippedMatches.length === 0) return null;

  if (strippedMatches.length === 1) {
    return resultFor(strippedMatches[0]);
  }

  // More than one stripped match — check if exactly one also has an exact
  // text match (different from the needle, but matching each other, e.g.
  // caller supplied bare "Notes" and two headings both strip to "notes"
  // but one was stored as "1.2. Notes" and the other as "2.1. Notes").
  // In that ambiguous case we cannot pick safely → throw.
  const strippedTexts = strippedMatches
    .map(h => decodeHtmlEntities(h.text.trim()))
    .join(", ");
  throw new Error(
    `Section '${headingText}' is ambiguous; matched ${strippedMatches.length} headings: ${strippedTexts}`
  );
}

/**
 * Compute the byte range of the section under a heading in `storageHtml`.
 *
 * Returns `[sectionStart, sectionEnd)` where:
 *   - sectionStart = heading element's start offset
 *   - sectionEnd   = start of the next equal-or-higher-level heading among
 *                    the heading's direct siblings, or the end of the last
 *                    sibling in that list when no such heading exists.
 *
 * Works correctly in the presence of CDATA blocks via `maskCdataForParse`.
 */
function findSectionRange(
  storageHtml: string,
  headingText: string,
): { headingStart: number; headingEnd: number; sectionEnd: number } | null {
  const { parse } = require("node-html-parser") as typeof import("node-html-parser");
  // Parse a CDATA-masked copy so the DOM structure reflects the real
  // page layout; use the ORIGINAL string for the returned offsets.
  const root = parse(maskCdataForParse(storageHtml));

  const found = findHeadingInTree(root, headingText);
  if (!found) return null;

  const { siblings, startIdx, headingLevel } = found;
  const heading = siblings[startIdx] as import("node-html-parser").HTMLElement;

  let sectionEnd: number | undefined;
  for (let i = startIdx + 1; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.nodeType !== 1) continue;
    const el = node as import("node-html-parser").HTMLElement;
    const tagMatch = el.tagName?.match(/^H([1-6])$/i);
    if (tagMatch && parseInt(tagMatch[1], 10) <= headingLevel) {
      sectionEnd = el.range[0];
      break;
    }
  }
  if (sectionEnd === undefined) {
    sectionEnd =
      startIdx + 1 < siblings.length
        ? siblings[siblings.length - 1].range[1]
        : heading.range[1];
  }

  return {
    headingStart: heading.range[0],
    headingEnd: heading.range[1],
    sectionEnd,
  };
}

/**
 * Extract the content under a specific heading from storage format HTML.
 * Returns the heading element + all sibling content until the next heading
 * of equal or higher level. Returns null if the heading is not found.
 *
 * Searches the entire DOM tree, including inside ac:layout cells. CDATA
 * sections in the source are preserved byte-for-byte (see maskCdataForParse).
 */
export function extractSection(storageHtml: string, headingText: string): string | null {
  const r = findSectionRange(storageHtml, headingText);
  if (r === null) return null;
  return storageHtml.slice(r.headingStart, r.sectionEnd);
}

/**
 * Extract only the body content under a heading (excluding the heading itself).
 * Used by update_page_section to feed the current section body to the
 * token-aware write path so that <ac:emoticon> and other Confluence elements
 * within the section are preserved when the caller submits markdown.
 *
 * CDATA sections are preserved byte-for-byte (see maskCdataForParse).
 */
export function extractSectionBody(storageHtml: string, headingText: string): string | null {
  const r = findSectionRange(storageHtml, headingText);
  if (r === null) return null;
  return storageHtml.slice(r.headingEnd, r.sectionEnd);
}

/**
 * Replace the content under a specific heading in storage format HTML.
 * The heading itself is preserved; content between it and the next heading
 * of equal or higher level is replaced with newContent.
 * Returns the full HTML with the section replaced, or null if heading not found.
 *
 * Searches the entire DOM tree, including inside ac:layout cells. The splice
 * is performed at byte offsets on the ORIGINAL storage string — the DOM is
 * used only to locate section bounds — so CDATA sections in the preserved
 * regions, and any CDATA the caller supplies in newContent, survive intact.
 */
export function replaceSection(
  storageHtml: string,
  headingText: string,
  newContent: string
): string | null {
  const r = findSectionRange(storageHtml, headingText);
  if (r === null) return null;
  return (
    storageHtml.slice(0, r.headingEnd) +
    newContent +
    storageHtml.slice(r.sectionEnd)
  );
}

/**
 * Truncate storage format HTML at the nearest element boundary.
 * Appends a truncation marker showing how much was cut.
 */
export function truncateStorageFormat(storageHtml: string, maxLength: number): string {
  if (storageHtml.length <= maxLength) return storageHtml;

  // Find the last complete element boundary (closing tag) before maxLength
  let cutoff = maxLength;
  // Look backward for the end of a complete tag
  const closingTagRe = /<\/[a-z][a-z0-9]*>/gi;
  let lastClose = 0;
  let match;
  while ((match = closingTagRe.exec(storageHtml)) !== null) {
    const tagEnd = match.index + match[0].length;
    if (tagEnd <= maxLength) {
      lastClose = tagEnd;
    } else {
      break;
    }
  }

  // Use the last complete element boundary, or maxLength if no tags found
  cutoff = lastClose > 0 ? lastClose : maxLength;
  const truncated = storageHtml.slice(0, cutoff);
  return `${truncated}\n\n[truncated at ${cutoff} of ${storageHtml.length} characters]`;
}

/** Parameters that are safe to show in macro placeholders. */
const SAFE_MACRO_PARAMS = new Set([
  "language", "title", "linenumbers", "theme", "collapse",
  "appearance", "color", "type", "name", "width", "height",
]);

/**
 * Convert Confluence storage format HTML to a read-only markdown rendering.
 * Confluence-specific elements (macros, layouts, images) are replaced with
 * human-readable placeholders. This is a one-way, lossy conversion — the
 * output must never be written back to Confluence.
 */
export function toMarkdownView(storageHtml: string): string {
  let confluenceElementCount = 0;
  let processed = storageHtml;

  // Replace <ac:structured-macro> blocks with placeholders
  processed = processed.replace(
    /<ac:structured-macro[^>]*ac:name="([^"]*)"[^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
    (_match, name) => {
      confluenceElementCount++;
      // Extract safe parameters from the match
      const paramRe = /<ac:parameter ac:name="([^"]*)"[^>]*>([^<]*)<\/ac:parameter>/gi;
      const params: string[] = [];
      let pm;
      while ((pm = paramRe.exec(_match)) !== null) {
        if (SAFE_MACRO_PARAMS.has(pm[1])) {
          params.push(`${pm[1]}=${pm[2]}`);
        }
      }
      const paramStr = params.length > 0 ? ` (${params.join(", ")})` : "";
      return `\n\n[macro: ${name}${paramStr}]\n\n`;
    }
  );

  // Replace <ac:layout> blocks with column count placeholders
  processed = processed.replace(
    /<ac:layout>[\s\S]*?<\/ac:layout>/gi,
    (match) => {
      confluenceElementCount++;
      const cellCount = (match.match(/<ac:layout-cell/gi) || []).length;
      return `\n\n[layout: ${cellCount}-column]\n\n`;
    }
  );

  // Replace <ac:image> and <ri:attachment> references
  processed = processed.replace(
    /<ac:image[^>]*>[\s\S]*?<\/ac:image>/gi,
    (match) => {
      confluenceElementCount++;
      const filenameMatch = match.match(/ri:filename="([^"]*)"/);
      const name = filenameMatch ? filenameMatch[1] : "unknown";
      return `[image: ${name}]`;
    }
  );

  // Replace standalone <ri:attachment> refs outside of ac:image
  processed = processed.replace(
    /<ri:attachment ri:filename="([^"]*)"[^>]*\/>/gi,
    (_match, filename) => {
      confluenceElementCount++;
      return `[attachment: ${filename}]`;
    }
  );

  // Replace <ac:emoticon> with placeholder
  processed = processed.replace(
    /<ac:emoticon[^>]*ac:name="([^"]*)"[^>]*\/>/gi,
    (_match, name) => {
      confluenceElementCount++;
      return `[emoticon: ${name}]`;
    }
  );

  // Convert remaining HTML to markdown
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  let markdown = turndown.turndown(processed);

  // Unescape brackets in our placeholders that turndown escaped
  markdown = markdown.replace(/\\\[([^\]]*)\\\]/g, "[$1]");

  // Append element count footer
  if (confluenceElementCount > 0) {
    markdown += `\n\n---\n[Page contains ${confluenceElementCount} Confluence element${confluenceElementCount === 1 ? "" : "s"} not shown in this view. Use format: storage to see full content.]`;
  }

  return markdown;
}

/**
 * Detect if a body string is likely markdown rather than Confluence storage
 * format (storage XHTML).
 *
 * Decision logic:
 *  1. Strong storage signals → return false immediately (body is storage).
 *     - Any `<ac:` or `<ri:` tag: these are Confluence-only storage elements
 *       and never appear in markdown bodies.
 *  2. Strong markdown signals → return true if at least one matches.
 *     - GFM table separator line (`| --- |`)
 *     - Fenced code block (``` at line start)
 *     - ATX heading (`# Heading`)
 *     - GitHub alert (`> [!NOTE]`)
 *     - Pandoc container fence (`::: panel`)
 *     - Setext heading underline (`---` or `===` alone on a line)
 *     - Unordered list marker (`- ` or `* ` at line start)
 *     - Ordered list marker (`1. ` at line start)
 *     - Numbered reference (`[1]:` at line start)
 *  3. Weak/neutral signals are ignored in isolation — a markdown body may
 *     legitimately contain `<br/>`, `<hr/>`, `<details>`, etc.
 *  4. Fallback: no strong storage signal AND no strong markdown signal → treat
 *     as storage (conservative, matches prior behaviour).
 */
export function looksLikeMarkdown(body: string): boolean {
  // Strip fenced code blocks before checking for storage signals.
  // Markdown documenting Confluence may contain <ac:*> inside code
  // fences — those should NOT trigger the storage-format path.
  const withoutCodeBlocks = body.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");

  // 1. Strong storage signals: Confluence-specific XML namespaces
  //    (checked OUTSIDE code blocks only).
  if (/<ac:/i.test(withoutCodeBlocks) || /<ri:/i.test(withoutCodeBlocks)) {
    return false;
  }

  // 2. Strong markdown signals.
  //
  // All line-anchored; Track A5 tightened this set by removing the inline
  // patterns `/\*\*…\*\*/` (inline bold) and `/\[…\]\(…\)/` (inline link).
  // Those inline signals were too forgiving — pure Confluence storage XHTML
  // containing `<a href="...">example</a>` was classified as markdown and
  // re-converted, corrupting legitimate content. See
  // `doc/design/investigations/investigate-agent-loop-and-mass-damage/08-format-misdetection.md`
  // for the analysis.
  //
  // Trade-off: a caller who submits plain prose like "this is **bold** text"
  // with NO structural markdown signals now gets storage-format interpretation
  // and a literal `**bold**` rendered in Confluence. Callers who want inline
  // markdown must include at least one line-anchored structural signal
  // (a heading, a list, a code fence, etc.) for the body to be detected as
  // markdown.
  const STRONG_MARKDOWN_SIGNALS: RegExp[] = [
    /^\|[\s\-:|]+\|\s*$/m,           // GFM table separator
    /^```/m,                           // fenced code block
    /^#{1,6}\s+/m,                     // ATX heading
    /^>\s*\[!(INFO|NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]/im, // GitHub alert
    /^:::[ \t]/m,                      // Pandoc container fence
    /^[-=]{2,}\s*$/m,                  // setext heading underline
    /^[-*]\s+/m,                       // unordered list
    /^\d+\.\s+/m,                      // ordered list
    /^\[\d+\]:/m,                      // numbered reference
  ];

  if (STRONG_MARKDOWN_SIGNALS.some((re) => re.test(body))) {
    return true;
  }

  // 3. No strong signals either way. If body starts with an HTML/XML tag,
  //    it's more likely storage format. Otherwise, treat as markdown —
  //    plain paragraph text is valid markdown and should be converted.
  const trimmed = body.trimStart();
  return !/^<[a-zA-Z]/i.test(trimmed);
}

export type FormatPageOptions = {
  includeBody?: boolean;
  headingsOnly?: boolean;
};

export async function formatPage(page: PageData, includeBody: boolean): Promise<string>;
export async function formatPage(page: PageData, options: FormatPageOptions): Promise<string>;
export async function formatPage(
  page: PageData,
  optionsOrIncludeBody: boolean | FormatPageOptions
): Promise<string> {
  const options: FormatPageOptions =
    typeof optionsOrIncludeBody === "boolean"
      ? { includeBody: optionsOrIncludeBody }
      : optionsOrIncludeBody;

  const { includeBody = false, headingsOnly = false } = options;

  const cfg = await getConfig();
  const spaceKey = page.spaceId ?? page.space?.key ?? "N/A";
  const version = page.version?.number ?? 0;
  const webui = page._links?.webui ?? "";
  const base = page._links?.base ?? `${cfg.url}/wiki`;
  const url = webui
    ? `${base}${webui}`
    : `${cfg.url}/wiki/pages/${page.id}`;

  // Titles are tenant-authored free text; wrap them in a per-title fence.
  // Spec §4c (untrusted-content-fence-spec.md).
  const titleFenced = fenceUntrusted(page.title, {
    pageId: page.id,
    field: "title",
  });

  const lines = [
    "Title:",
    titleFenced,
    `ID: ${page.id}`,
    `Space: ${spaceKey}`,
    `Version: ${version}`,
    `URL: ${url}`,
  ];

  if (headingsOnly) {
    const body = page.body?.storage?.value ?? page.body?.value ?? "";
    const outline = extractHeadings(body);
    lines.push(
      "",
      "Headings:",
      fenceUntrusted(outline, { pageId: page.id, field: "headings" })
    );
  } else if (includeBody) {
    const body = page.body?.storage?.value ?? page.body?.value ?? "";
    if (body) {
      lines.push(
        "",
        "Content:",
        fenceUntrusted(body, { pageId: page.id, field: "body" })
      );
    }
  }

  return lines.join("\n");
}
