import { z } from "zod";
import { readFromKeychain } from "../shared/keychain.js";

// --- Configuration ---

// Credentials are resolved lazily: env vars take priority, then OS keychain.
interface Config {
  url: string;
  apiV2: string;
  apiV1: string;
  authHeader: string;
  jsonHeaders: Record<string, string>;
}

let _config: Config | null = null;

async function getConfig(): Promise<Config> {
  if (_config) return _config;

  let url = process.env.CONFLUENCE_URL?.replace(/\/$/, "") || "";
  let email = process.env.CONFLUENCE_EMAIL || "";
  let apiToken = process.env.CONFLUENCE_API_TOKEN || "";

  // Fall back to OS keychain if any credential is missing
  if (!url || !email || !apiToken) {
    const keychainCreds = await readFromKeychain();
    if (keychainCreds) {
      url = url || keychainCreds.url.replace(/\/$/, "");
      email = email || keychainCreds.email;
      apiToken = apiToken || keychainCreds.apiToken;
    }
  }

  if (!url || !email || !apiToken) {
    console.error(
      "Missing Confluence credentials. Set CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN environment variables, or save credentials via the VS Code extension."
    );
    process.exit(1);
  }

  // Confluence exposes two API generations:
  //   - v2 (REST): /wiki/api/v2  — used for page CRUD, spaces, children
  //   - v1 (REST): /wiki/rest/api — used for CQL search and attachments (no v2 equivalent)
  const authHeader =
    "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  _config = {
    url,
    apiV2: `${url}/wiki/api/v2`,
    apiV1: `${url}/wiki/rest/api`,
    authHeader,
    jsonHeaders: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  };
  return _config;
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

// --- HTTP helpers ---

async function confluenceRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const cfg = await getConfig();
  const res = await fetch(url, { headers: cfg.jsonHeaders, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Confluence API error (${res.status}): ${body}`);
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
  const payload: Record<string, unknown> = {
    title,
    spaceId,
    status: "current",
    body: { representation: "storage", value: toStorageFormat(body) },
  };
  if (parentId) payload.parentId = parentId;
  const raw = await v2Post("/pages", payload);
  return PageSchema.parse(raw);
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

  const payload: Record<string, unknown> = {
    id: pageId,
    status: "current",
    title: newTitle,
    version: { number: newVersion, message: opts.versionMessage },
  };
  if (opts.body) {
    payload.body = {
      representation: "storage",
      value: toStorageFormat(opts.body),
    };
  }

  const raw = await v2Put(`/pages/${pageId}`, payload);
  return { page: PageSchema.parse(raw), newVersion };
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
    throw new Error(`Confluence API error (${res.status}): ${body}`);
  }
  const data = UploadResultSchema.parse(await res.json());
  const att = data.results[0];
  if (!att) throw new Error("Attachment uploaded but no details returned.");
  return { title: att.title, id: att.id, fileSize: att.extensions?.fileSize };
}

// --- Formatting helpers ---

const HTML_TAG_RE = /<[a-z][\s>\/]/i;

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
