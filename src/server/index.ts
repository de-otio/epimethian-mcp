import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveSpaceId,
  getPage,
  createPage,
  updatePage,
  deletePage,
  searchPages,
  listPages,
  getPageChildren,
  getSpaces,
  getPageByTitle,
  getAttachments,
  uploadAttachment,
  formatPage,
} from "./confluence-client.js";

// --- Utilities ---

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- Error-safe tool helpers ---

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function toolResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// --- MCP Server ---

const server = new McpServer({
  name: "confluence",
  version: "1.0.0",
});

// create_page
server.registerTool(
  "create_page",
  {
    description: "Create a new page in Confluence",
    inputSchema: {
      title: z.string().describe("Page title"),
      space_key: z
        .string()
        .describe("Confluence space key, e.g. 'DEV' or 'TEAM'"),
      body: z
        .string()
        .describe(
          "Page content – plain text or Confluence storage format (HTML)"
        ),
      parent_id: z.string().optional().describe("Optional parent page ID"),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ title, space_key, body, parent_id }) => {
    try {
      const spaceId = await resolveSpaceId(space_key);
      const page = await createPage(spaceId, title, body, parent_id);
      return toolResult(await formatPage(page, false));
    } catch (err) {
      return toolError(err);
    }
  }
);

// get_page
server.registerTool(
  "get_page",
  {
    description: "Read a Confluence page by ID",
    inputSchema: {
      page_id: z.string().describe("The Confluence page ID"),
      include_body: z
        .boolean()
        .default(true)
        .describe("Whether to include the page body content"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ page_id, include_body }) => {
    try {
      const page = await getPage(page_id, include_body);
      return toolResult(await formatPage(page, include_body));
    } catch (err) {
      return toolError(err);
    }
  }
);

// update_page
server.registerTool(
  "update_page",
  {
    description:
      "Update an existing Confluence page. Auto-increments version number.",
    inputSchema: {
      page_id: z.string().describe("The Confluence page ID"),
      title: z
        .string()
        .optional()
        .describe("New title (omit to keep current)"),
      body: z
        .string()
        .optional()
        .describe("New body content in plain text or storage format"),
      version_message: z
        .string()
        .optional()
        .describe("Optional version comment"),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ page_id, title, body, version_message }) => {
    try {
      const { page, newVersion } = await updatePage(page_id, {
        title,
        body,
        versionMessage: version_message,
      });
      return toolResult(
        `Updated: ${page.title} (ID: ${page.id}, version: ${newVersion})`
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

// delete_page
server.registerTool(
  "delete_page",
  {
    description: "Delete a Confluence page by ID",
    inputSchema: {
      page_id: z.string().describe("The Confluence page ID to delete"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ page_id }) => {
    try {
      await deletePage(page_id);
      return toolResult(`Deleted page ${page_id}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

// search_pages
server.registerTool(
  "search_pages",
  {
    description:
      "Search Confluence pages using CQL (Confluence Query Language)",
    inputSchema: {
      cql: z
        .string()
        .describe(
          'CQL query string (e.g., \'space = "DEV" AND title ~ "architecture"\')'
        ),
      limit: z
        .number()
        .default(25)
        .describe("Maximum results to return (default: 25)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cql, limit }) => {
    try {
      const results = await searchPages(cql, limit);
      if (results.length === 0) {
        return toolResult("No pages found matching the query.");
      }
      const lines = [`Found ${results.length} page(s):`, ""];
      for (const p of results) {
        const spaceKey = p.spaceId ?? p.space?.key ?? "N/A";
        lines.push(`- ${p.title} (ID: ${p.id}, space: ${spaceKey})`);
      }
      return toolResult(lines.join("\n"));
    } catch (err) {
      return toolError(err);
    }
  }
);

// list_pages
server.registerTool(
  "list_pages",
  {
    description: "List pages in a Confluence space",
    inputSchema: {
      space_key: z
        .string()
        .describe("Confluence space key (e.g., 'DEV')"),
      limit: z
        .number()
        .default(25)
        .describe("Maximum results (default: 25)"),
      status: z
        .string()
        .default("current")
        .describe("Page status filter (default: 'current')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ space_key, limit, status }) => {
    try {
      const spaceId = await resolveSpaceId(space_key);
      const pages = await listPages(spaceId, limit, status);
      if (pages.length === 0) {
        return toolResult(`No pages found in space ${space_key}.`);
      }
      const lines = [`Pages in ${space_key} (${pages.length}):`, ""];
      for (const p of pages) {
        lines.push(`- ${p.title} (ID: ${p.id})`);
      }
      return toolResult(lines.join("\n"));
    } catch (err) {
      return toolError(err);
    }
  }
);

// get_page_children
server.registerTool(
  "get_page_children",
  {
    description: "Get child pages of a given Confluence page",
    inputSchema: {
      page_id: z.string().describe("Parent page ID"),
      limit: z
        .number()
        .default(25)
        .describe("Maximum results (default: 25)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ page_id, limit }) => {
    try {
      const children = await getPageChildren(page_id, limit);
      if (children.length === 0) {
        return toolResult(`No child pages found for page ${page_id}.`);
      }
      const lines = [`Child pages (${children.length}):`, ""];
      for (const p of children) {
        lines.push(`- ${p.title} (ID: ${p.id})`);
      }
      return toolResult(lines.join("\n"));
    } catch (err) {
      return toolError(err);
    }
  }
);

// get_spaces
server.registerTool(
  "get_spaces",
  {
    description: "List available Confluence spaces",
    inputSchema: {
      limit: z
        .number()
        .default(25)
        .describe("Maximum results (default: 25)"),
      type: z
        .string()
        .optional()
        .describe("Filter by space type (e.g., 'global', 'personal')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit, type }) => {
    try {
      const spaces = await getSpaces(limit, type);
      if (spaces.length === 0) {
        return toolResult("No spaces found.");
      }
      const lines = [`Found ${spaces.length} space(s):`, ""];
      for (const s of spaces) {
        lines.push(`- ${s.name} (key: ${s.key}, type: ${s.type})`);
      }
      return toolResult(lines.join("\n"));
    } catch (err) {
      return toolError(err);
    }
  }
);

// get_page_by_title
server.registerTool(
  "get_page_by_title",
  {
    description: "Look up a Confluence page by its title within a space",
    inputSchema: {
      title: z.string().describe("Page title to search for"),
      space_key: z
        .string()
        .describe("Confluence space key (e.g., 'DEV')"),
      include_body: z
        .boolean()
        .default(false)
        .describe("Whether to include the page body content"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ title, space_key, include_body }) => {
    try {
      const spaceId = await resolveSpaceId(space_key);
      const page = await getPageByTitle(spaceId, title, include_body);
      if (!page) {
        return toolResult(
          `No page found with title "${title}" in space ${space_key}.`
        );
      }
      return toolResult(await formatPage(page, include_body));
    } catch (err) {
      return toolError(err);
    }
  }
);

// add_attachment
server.registerTool(
  "add_attachment",
  {
    description:
      "Upload a file as an attachment to a Confluence page. The file_path must be an absolute path under the current working directory.",
    inputSchema: {
      page_id: z
        .string()
        .describe("The Confluence page ID to attach the file to"),
      file_path: z
        .string()
        .describe("Absolute path to the file on the local filesystem"),
      filename: z
        .string()
        .optional()
        .describe(
          "Filename to use in Confluence (defaults to the basename of file_path)"
        ),
      comment: z
        .string()
        .optional()
        .describe("Optional comment for the attachment"),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ page_id, file_path, filename, comment }) => {
    try {
      // Security: restrict file reads to the current working directory (resolve symlinks)
      const resolved = await realpath(resolve(file_path));
      const cwd = await realpath(process.cwd());
      if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
        return toolError(
          new Error(
            `File path must be under the working directory (${cwd}). Got: ${resolved}`
          )
        );
      }

      const fileData = await readFile(resolved);
      const name = filename ?? resolved.split("/").pop() ?? "attachment";
      const att = await uploadAttachment(page_id, fileData, name, comment);
      return toolResult(
        `Attached: ${att.title} (ID: ${att.id}, size: ${att.fileSize ?? "unknown"} bytes) to page ${page_id}`
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

// add_drawio_diagram
server.registerTool(
  "add_drawio_diagram",
  {
    description:
      "Add a draw.io diagram to a Confluence page. Uploads the diagram as an attachment and embeds it using the draw.io macro. Requires the draw.io app on the Confluence instance.",
    inputSchema: {
      page_id: z
        .string()
        .describe("The Confluence page ID to add the diagram to"),
      diagram_xml: z
        .string()
        .describe(
          "The draw.io diagram content in mxGraph XML format (the full XML starting with <mxfile>)"
        ),
      diagram_name: z
        .string()
        .regex(
          /^[a-zA-Z0-9_\-. ]+$/,
          "Diagram name may only contain letters, numbers, spaces, hyphens, underscores, and dots"
        )
        .describe(
          "Name for the diagram file (e.g., 'architecture.drawio'). Will have .drawio appended if not present."
        ),
      append: z
        .boolean()
        .default(true)
        .describe(
          "If true, appends the diagram to existing page content. If false, replaces the page body."
        ),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ page_id, diagram_xml, diagram_name, append }) => {
    try {
      const filename = diagram_name.endsWith(".drawio")
        ? diagram_name
        : `${diagram_name}.drawio`;

      // Write diagram XML to a temp file and upload as attachment
      const tmpDir = await mkdtemp(join(tmpdir(), "drawio-"));
      try {
        const tmpPath = join(tmpDir, filename);
        await writeFile(tmpPath, diagram_xml, "utf-8");
        const fileData = await readFile(tmpPath);
        await uploadAttachment(page_id, fileData, filename);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }

      // Build the draw.io macro
      const macro = [
        `<ac:structured-macro ac:name="drawio" ac:schema-version="1">`,
        `  <ac:parameter ac:name="diagramName">${escapeXml(filename)}</ac:parameter>`,
        `  <ac:parameter ac:name="attachment">${escapeXml(filename)}</ac:parameter>`,
        `</ac:structured-macro>`,
      ].join("\n");

      // Fetch current page to get version and existing body
      const current = await getPage(page_id, true);
      const newVersion = (current.version?.number ?? 0) + 1;
      const existingBody =
        current.body?.storage?.value ?? current.body?.value ?? "";

      const newBody = append ? `${existingBody}\n${macro}` : macro;

      const { page } = await updatePage(page_id, {
        body: newBody,
        versionMessage: `Added diagram: ${filename}`,
      });

      return toolResult(
        `Diagram "${filename}" added to page ${page.title} (ID: ${page.id}, version: ${newVersion})`
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

// get_attachments
server.registerTool(
  "get_attachments",
  {
    description: "List attachments on a Confluence page",
    inputSchema: {
      page_id: z.string().describe("The Confluence page ID"),
      limit: z
        .number()
        .default(25)
        .describe("Maximum results (default: 25)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ page_id, limit }) => {
    try {
      const attachments = await getAttachments(page_id, limit);
      if (attachments.length === 0) {
        return toolResult(`No attachments found on page ${page_id}.`);
      }
      const lines = [
        `Attachments on page ${page_id} (${attachments.length}):`,
        "",
      ];
      for (const a of attachments) {
        const size = a.extensions?.fileSize
          ? `${Math.round(a.extensions.fileSize / 1024)}KB`
          : "unknown size";
        const mediaType = a.extensions?.mediaType ?? "unknown type";
        lines.push(`- ${a.title} (ID: ${a.id}, ${mediaType}, ${size})`);
      }
      return toolResult(lines.join("\n"));
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Start ---

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
