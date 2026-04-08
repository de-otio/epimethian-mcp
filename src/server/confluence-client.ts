import { z } from "zod";
import { readFromKeychain, PROFILE_NAME_RE } from "../shared/keychain.js";
import { testConnection, verifyTenantIdentity } from "../shared/test-connection.js";

// --- Configuration ---

export interface Config {
  url: string;
  email: string;
  profile: string | null;
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

  // Confluence exposes two API generations:
  //   - v2 (REST): /wiki/api/v2  — used for page CRUD, spaces, children
  //   - v1 (REST): /wiki/rest/api — used for CQL search and attachments (no v2 equivalent)
  const authHeader =
    "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  _config = Object.freeze({
    url,
    email,
    profile,
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
  console.error(
    `epimethian-mcp: connected to ${url} as ${email} (${profileLabel})`
  );
}

// --- Zod response schemas (runtime validation) ---

export const PageSchema = z.object({
  id: z.string(),
  title: z.string(),
  spaceId: z.string().optional(),
  space: z.object({ key: z.string() }).optional(),
  version: z.object({ number: z.number() }).optional(),
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

// --- HTTP helpers ---

async function confluenceRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const cfg = await getConfig();
  const res = await fetch(url, { headers: cfg.jsonHeaders, ...options });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Confluence API error (${res.status}): ${body}`);
    throw new Error(
      `Confluence API error (${res.status}): ${sanitizeError(body)}`
    );
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
  const params: Record<string, string> = {};
  if (includeBody) params["body-format"] = "storage";
  const raw = await v2Get(`/pages/${pageId}`, params);
  return PageSchema.parse(raw);
}

export async function createPage(
  spaceId: string,
  title: string,
  body: string,
  parentId?: string
): Promise<PageData> {
  const cleanBody = stripAttributionFooter(toStorageFormat(body));
  const payload: Record<string, unknown> = {
    title,
    spaceId,
    status: "current",
    body: {
      representation: "storage",
      value: cleanBody + "\n" + buildAttributionFooter("created"),
    },
    version: { message: "Created by Epimethian" },
  };
  if (parentId) payload.parentId = parentId;
  const raw = await v2Post("/pages", payload);
  const page = PageSchema.parse(raw);

  try {
    await addLabel(page.id, ATTRIBUTION_LABEL);
  } catch {
    // Label addition is non-critical
  }

  return page;
}

export async function updatePage(
  pageId: string,
  opts: {
    title?: string;
    body?: string;
    versionMessage?: string;
  }
): Promise<{ page: PageData; newVersion: number }> {
  const current = await getPage(pageId, true);
  const newVersion = (current.version?.number ?? 0) + 1;
  const newTitle = opts.title ?? current.title;

  const versionMessage = opts.versionMessage
    ? `${opts.versionMessage} (via Epimethian)`
    : "Updated by Epimethian";

  const payload: Record<string, unknown> = {
    id: pageId,
    status: "current",
    title: newTitle,
    version: { number: newVersion, message: versionMessage },
  };
  if (opts.body) {
    const cleanBody = stripAttributionFooter(toStorageFormat(opts.body));
    payload.body = {
      representation: "storage",
      value: cleanBody + "\n" + buildAttributionFooter("updated"),
    };
  }

  const raw = await v2Put(`/pages/${pageId}`, payload);
  const page = PageSchema.parse(raw);

  try {
    await addLabel(page.id, ATTRIBUTION_LABEL);
  } catch {
    // Label addition is non-critical
  }

  return { page, newVersion };
}

export async function deletePage(pageId: string): Promise<void> {
  await v2Delete(`/pages/${pageId}`);
}

export async function searchPages(
  cql: string,
  limit: number
): Promise<PageData[]> {
  // CQL search only available via v1 REST API
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/search`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("limit", String(limit));
  const res = await confluenceRequest(url.toString());
  const raw = await res.json();
  return PagesResultSchema.parse(raw).results;
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
    console.error(`Confluence API error (${res.status}): ${body}`);
    throw new Error(
      `Confluence API error (${res.status}): ${sanitizeError(body)}`
    );
  }
  const data = UploadResultSchema.parse(await res.json());
  const att = data.results[0];
  if (!att) throw new Error("Attachment uploaded but no details returned.");
  return { title: att.title, id: att.id, fileSize: att.extensions?.fileSize };
}

// --- Attribution ---

const GITHUB_URL = "https://github.com/rmyers/epimethian-mcp";
const ATTRIBUTION_LABEL = "epimethian-managed";
const ATTRIBUTION_START = "<!-- epimethian-attribution-start -->";
const ATTRIBUTION_END = "<!-- epimethian-attribution-end -->";

function buildAttributionFooter(action: "created" | "updated"): string {
  return (
    ATTRIBUTION_START +
    '<p style="font-size:11px;color:#999;margin-top:2em;">' +
    `<em>This page was ${action} with ` +
    `<a href="${GITHUB_URL}">Epimethian</a>.</em></p>` +
    ATTRIBUTION_END
  );
}

function stripAttributionFooter(body: string): string {
  return body
    .replace(
      /<!-- epimethian-attribution-start -->[\s\S]*?<!-- epimethian-attribution-end -->/g,
      ""
    )
    .trimEnd();
}

async function addLabel(pageId: string, label: string): Promise<void> {
  const cfg = await getConfig();
  await confluenceRequest(`${cfg.apiV1}/content/${pageId}/label`, {
    method: "POST",
    body: JSON.stringify([{ prefix: "global", name: label }]),
  });
}

// --- Formatting helpers ---

const HTML_TAG_RE = /<[a-z][a-z0-9]*[\s>\/]/i;

export function toStorageFormat(body: string): string {
  return HTML_TAG_RE.test(body) ? body : `<p>${body}</p>`;
}

export async function formatPage(page: PageData, includeBody: boolean): Promise<string> {
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

  if (includeBody) {
    const body = page.body?.storage?.value ?? page.body?.value ?? "";
    if (body) {
      lines.push("", `Content:`, body);
    }
  }

  return lines.join("\n");
}
