import { z } from "zod";
import TurndownService from "turndown";
import { readFromKeychain, PROFILE_NAME_RE } from "../shared/keychain.js";
import { getProfileSettings } from "../shared/profiles.js";
import { testConnection, verifyTenantIdentity } from "../shared/test-connection.js";

declare const __PKG_VERSION__: string;
import { pageCache } from "./page-cache.js";

// --- Configuration ---

export interface Config {
  url: string;
  email: string;
  profile: string | null;
  readOnly: boolean;
  attribution: boolean;
  apiV2: string;
  apiV1: string;
  authHeader: string;
  jsonHeaders: Record<string, string>;
}

let _config: Config | null = null;

/**
 * Resolve credentials from environment / keychain without caching.
 * Exported for testability — callers should use getConfig() instead.
 *
 * Resolution order (no merging across sources):
 *   1. CONFLUENCE_PROFILE env var → read all fields from named keychain entry
 *   2. All 3 env vars set → use directly (CI/CD mode)
 *   3. Partial env vars (1 or 2 of 3) → hard error
 *   4. No env vars → read legacy keychain entry (backward compat, deprecation warning)
 */
export async function resolveCredentials(): Promise<{
  url: string;
  email: string;
  apiToken: string;
  profile: string | null;
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
      console.error(
        `No credentials found for profile "${profileEnv}". Run \`epimethian-mcp setup --profile ${profileEnv}\` to configure.`
      );
      process.exit(1);
    }
    return {
      url: creds.url.replace(/\/$/, ""),
      email: creds.email,
      apiToken: creds.apiToken,
      profile: profileEnv,
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

  const { url, email, apiToken, profile } = await resolveCredentials();

  // Resolve read-only flag: strict-mode OR — either source saying read-only wins.
  // CONFLUENCE_READ_ONLY=false does NOT override a registry-level read-only flag.
  const registrySettings = profile ? await getProfileSettings(profile) : undefined;
  const readOnly =
    (registrySettings?.readOnly === true) ||
    (process.env.CONFLUENCE_READ_ONLY === "true");

  // Resolve attribution flag: disabled if registry or env var says so.
  const attribution =
    (registrySettings?.attribution !== false) &&
    (process.env.CONFLUENCE_ATTRIBUTION !== "false");

  // Confluence exposes two API generations:
  //   - v2 (REST): /wiki/api/v2  — used for page CRUD, spaces, children
  //   - v1 (REST): /wiki/rest/api — used for CQL search and attachments (no v2 equivalent)
  const authHeader =
    "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  _config = Object.freeze({
    url,
    email,
    profile,
    readOnly,
    attribution,
    apiV2: `${url}/wiki/api/v2`,
    apiV1: `${url}/wiki/rest/api`,
    authHeader,
    jsonHeaders: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  });
  return _config;
}

/**
 * Validate credentials against the Confluence instance before accepting tool calls.
 * 1. Test authentication (GET spaces)
 * 2. Verify tenant identity (email matches)
 * 3. Log connection info to stderr
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

  // Step 3: Log connection info
  const profileLabel = profile ? `profile: ${profile}` : "env-var mode";
  const readOnlyLabel = config.readOnly ? ", READ-ONLY" : "";
  const attributionLabel = config.attribution ? "" : ", NO-ATTRIBUTION";
  console.error(
    `epimethian-mcp: connected to ${url} as ${email} (${profileLabel}${readOnlyLabel}${attributionLabel})`
  );
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
    throw new ConfluenceApiError(res.status, body);
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

export async function createPage(
  spaceId: string,
  title: string,
  body: string,
  parentId?: string
): Promise<PageData> {
  const cfg = await getConfig();
  const cleanBody = stripAttributionFooter(toStorageFormat(body));
  const pageBody = cfg.attribution
    ? cleanBody + "\n" + buildAttributionFooter("created")
    : cleanBody;
  const payload: Record<string, unknown> = {
    title,
    spaceId,
    status: "current",
    body: {
      representation: "storage",
      value: pageBody,
    },
    version: { message: `Created by Epimethian v${__PKG_VERSION__}` },
  };
  if (parentId) payload.parentId = parentId;
  const raw = await v2Post("/pages", payload);
  const page = PageSchema.parse(raw);

  // Cache the body we just sent (new pages start at version 1)
  pageCache.set(page.id, page.version?.number ?? 1, pageBody);

  try {
    await addLabels(page.id, [ATTRIBUTION_LABEL]);
  } catch {
    // Label addition is non-critical
  }

  return page;
}

export async function updatePage(
  pageId: string,
  opts: {
    title: string;
    body?: string;
    version: number;
    versionMessage?: string;
    previousBody?: string;
  }
): Promise<{ page: PageData; newVersion: number }> {
  const cfg = await getConfig();
  const newVersion = opts.version + 1;

  const versionMessage = opts.versionMessage
    ? `${opts.versionMessage} (via Epimethian v${__PKG_VERSION__})`
    : `Updated by Epimethian v${__PKG_VERSION__}`;

  const payload: Record<string, unknown> = {
    id: pageId,
    status: "current",
    title: opts.title,
    version: { number: newVersion, message: versionMessage },
  };
  if (opts.body) {
    const cleanBody = stripAttributionFooter(toStorageFormat(opts.body));
    const pageBody = cfg.attribution
      ? cleanBody + "\n" + buildAttributionFooter("updated")
      : cleanBody;
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

  // Cache the body we just sent
  if (opts.body) {
    const cleanBody = stripAttributionFooter(toStorageFormat(opts.body));
    const pageBody = cfg.attribution
      ? cleanBody + "\n" + buildAttributionFooter("updated")
      : cleanBody;
    pageCache.set(pageId, newVersion, pageBody);
  }

  try {
    await addLabels(page.id, [ATTRIBUTION_LABEL]);
  } catch {
    // Label addition is non-critical
  }

  return { page, newVersion };
}

export async function deletePage(pageId: string): Promise<void> {
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

const GITHUB_URL = "https://github.com/de-otio/epimethian-mcp";
const ATTRIBUTION_LABEL = "epimethian-managed";
const ATTRIBUTION_START = "<!-- epimethian-attribution-start -->";
const ATTRIBUTION_END = "<!-- epimethian-attribution-end -->";

function buildAttributionFooter(action: "created" | "updated"): string {
  return (
    ATTRIBUTION_START +
    '<p style="font-size:9px;color:#999;margin-top:2em;">' +
    `<em>This page was ${action} with ` +
    `<a href="${GITHUB_URL}">Epimethian</a> v${__PKG_VERSION__}.</em></p>` +
    ATTRIBUTION_END
  );
}

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
      /<p[^>]*>[\s\S]*?<a\s[^>]*href="https:\/\/github\.com\/de-otio\/epimethian-mcp"[^>]*>(?:<em>)?Epimethian(?:<\/em>)?<\/a>[\s\S]*?<\/p>/gi,
      ""
    )
    .trimEnd();
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
    // API returns contentState: null when no state is set
    if (!data || !data.name) return null;
    return ContentStateSchema.parse(data);
  } catch (err) {
    if (err instanceof ConfluenceApiError && err.status === 404) return null;
    throw err;
  }
}

export async function setContentState(
  pageId: string,
  name: string,
  color: string
): Promise<void> {
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}/state`);
  url.searchParams.set("status", "current");
  await confluenceRequest(url.toString(), {
    method: "PUT",
    body: JSON.stringify({ name, color }),
  });
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
  const sanitized = sanitizeCommentBody(toStorageFormat(body));
  const attributed = `<p><em>[AI-generated via Epimethian]</em></p>${sanitized}`;

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
  const sanitized = sanitizeCommentBody(toStorageFormat(body));
  const attributed = `<p><em>[AI-generated via Epimethian]</em></p>${sanitized}`;

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

const HTML_TAG_RE = /<[a-z][a-z0-9]*[\s>\/]/i;

export function toStorageFormat(body: string): string {
  return HTML_TAG_RE.test(body) ? body : `<p>${body}</p>`;
}

/**
 * Extract headings from Confluence storage format HTML.
 * Returns a numbered outline string, e.g.:
 *   1. Introduction
 *   1.1. Background
 *   1.2. Goals
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
    const number = counters.slice(0, level).filter(n => n > 0).join(".");
    // Strip HTML tags from heading text
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    lines.push(`${"  ".repeat(level - 1)}${number}. ${text}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no headings found)";
}

/**
 * Find a heading element anywhere in the DOM tree (including inside
 * ac:layout cells) whose text matches the target. Returns the heading
 * element and its sibling list within the parent container, or null.
 */
function findHeadingInTree(
  root: import("node-html-parser").HTMLElement,
  headingText: string
): { siblings: import("node-html-parser").Node[]; startIdx: number; headingLevel: number } | null {
  type HTMLElement = import("node-html-parser").HTMLElement;

  // Depth-first search for all heading elements
  const allHeadings = root.querySelectorAll("h1, h2, h3, h4, h5, h6") as HTMLElement[];

  for (const heading of allHeadings) {
    if (heading.text.trim().toLowerCase() !== headingText.toLowerCase()) continue;

    const tagMatch = heading.tagName.match(/^H([1-6])$/i);
    if (!tagMatch) continue;

    // Found it — get sibling list from the heading's parent
    const parent = heading.parentNode as HTMLElement;
    const siblings = parent.childNodes;
    const startIdx = siblings.indexOf(heading);
    if (startIdx === -1) continue;

    return { siblings, startIdx, headingLevel: parseInt(tagMatch[1], 10) };
  }
  return null;
}

/**
 * Extract the content under a specific heading from storage format HTML.
 * Returns the heading element + all sibling content until the next heading
 * of equal or higher level. Returns null if the heading is not found.
 *
 * Searches the entire DOM tree, including inside ac:layout cells.
 */
export function extractSection(storageHtml: string, headingText: string): string | null {
  const { parse } = require("node-html-parser") as typeof import("node-html-parser");
  const root = parse(storageHtml);

  const found = findHeadingInTree(root, headingText);
  if (!found) return null;

  const { siblings, startIdx, headingLevel } = found;

  // Collect content until next heading of equal or higher level
  let endIdx = siblings.length;
  for (let i = startIdx + 1; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.nodeType !== 1) continue;
    const el = node as import("node-html-parser").HTMLElement;
    const tagMatch = el.tagName?.match(/^H([1-6])$/i);
    if (tagMatch && parseInt(tagMatch[1], 10) <= headingLevel) {
      endIdx = i;
      break;
    }
  }

  const sectionNodes = siblings.slice(startIdx, endIdx);
  return sectionNodes.map(n => n.toString()).join("");
}

/**
 * Replace the content under a specific heading in storage format HTML.
 * The heading itself is preserved; content between it and the next heading
 * of equal or higher level is replaced with newContent.
 * Returns the full HTML with the section replaced, or null if heading not found.
 *
 * Searches the entire DOM tree, including inside ac:layout cells.
 */
export function replaceSection(
  storageHtml: string,
  headingText: string,
  newContent: string
): string | null {
  const { parse } = require("node-html-parser") as typeof import("node-html-parser");
  const root = parse(storageHtml);

  const found = findHeadingInTree(root, headingText);
  if (!found) return null;

  const { siblings, startIdx, headingLevel } = found;

  let endIdx = siblings.length;
  for (let i = startIdx + 1; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.nodeType !== 1) continue;
    const el = node as import("node-html-parser").HTMLElement;
    const tagMatch = el.tagName?.match(/^H([1-6])$/i);
    if (tagMatch && parseInt(tagMatch[1], 10) <= headingLevel) {
      endIdx = i;
      break;
    }
  }

  // Reconstruct: before + heading + newContent + after
  const before = siblings.slice(0, startIdx);
  const heading = siblings[startIdx];
  const after = siblings.slice(endIdx);

  // Replace within the parent container, then return the full document
  const parent = heading.parentNode as import("node-html-parser").HTMLElement;
  parent.innerHTML =
    before.map(n => n.toString()).join("") +
    heading.toString() +
    newContent +
    after.map(n => n.toString()).join("");

  return root.toString();
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
  // 1. Strong storage signals: Confluence-specific XML namespaces.
  if (/<ac:/i.test(body) || /<ri:/i.test(body)) {
    return false;
  }

  // 2. Strong markdown signals.
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
    /\[[^\]]+\]\([^)]+\)/,            // inline link [text](url)
    /\*\*[^*]+\*\*/,                   // inline bold **text**
  ];

  return STRONG_MARKDOWN_SIGNALS.some((re) => re.test(body));
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

  const lines = [
    `Title: ${page.title}`,
    `ID: ${page.id}`,
    `Space: ${spaceKey}`,
    `Version: ${version}`,
    `URL: ${url}`,
  ];

  if (headingsOnly) {
    const body = page.body?.storage?.value ?? page.body?.value ?? "";
    lines.push("", "Headings:", extractHeadings(body));
  } else if (includeBody) {
    const body = page.body?.storage?.value ?? page.body?.value ?? "";
    if (body) {
      lines.push("", `Content:`, body);
    }
  }

  return lines.join("\n");
}
