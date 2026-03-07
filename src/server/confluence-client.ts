import { z } from "zod";

// --- Configuration ---

const CONFLUENCE_URL = process.env.CONFLUENCE_URL?.replace(/\/$/, "");
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL;
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN;

if (!CONFLUENCE_URL || !CONFLUENCE_EMAIL || !CONFLUENCE_API_TOKEN) {
  console.error(
    "Missing required environment variables: CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN"
  );
  process.exit(1);
}

// Confluence exposes two API generations:
//   - v2 (REST): /wiki/api/v2  — used for page CRUD, spaces, children
//   - v1 (REST): /wiki/rest/api — used for CQL search and attachments (no v2 equivalent)
const API_V2 = `${CONFLUENCE_URL}/wiki/api/v2`;
const API_V1 = `${CONFLUENCE_URL}/wiki/rest/api`;

const AUTH_HEADER =
  "Basic " +
  Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64");

const JSON_HEADERS = {
  Authorization: AUTH_HEADER,
  "Content-Type": "application/json",
};

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
  const res = await fetch(url, { headers: JSON_HEADERS, ...options });
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
  const url = new URL(`${API_V2}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await confluenceRequest(url.toString());
  return res.json();
}

async function v2Post(path: string, body: unknown): Promise<unknown> {
  const res = await confluenceRequest(`${API_V2}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

async function v2Put(path: string, body: unknown): Promise<unknown> {
  const res = await confluenceRequest(`${API_V2}${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return res.json();
}

async function v2Delete(path: string): Promise<void> {
  await confluenceRequest(`${API_V2}${path}`, { method: "DELETE" });
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
  const url = new URL(`${API_V1}/content/search`);
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
  const url = new URL(`${API_V1}/content/${pageId}/child/attachment`);
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
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fileData)]), filename);
  if (comment) form.append("comment", comment);

  const attachUrl = `${API_V1}/content/${pageId}/child/attachment`;
  const res = await fetch(attachUrl, {
    method: "POST",
    headers: {
      Authorization: AUTH_HEADER,
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

export function formatPage(page: PageData, includeBody: boolean): string {
  const spaceKey = page.spaceId ?? page.space?.key ?? "N/A";
  const version = page.version?.number ?? 0;
  const webui = page._links?.webui ?? "";
  const base = page._links?.base ?? `${CONFLUENCE_URL}/wiki`;
  const url = webui
    ? `${base}${webui}`
    : `${CONFLUENCE_URL}/wiki/pages/${page.id}`;

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
