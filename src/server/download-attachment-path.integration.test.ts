/**
 * download_attachment destination rules (7.0.0 S-H5), driven through the real
 * handler with the Confluence client mocked and a real temporary directory
 * standing in for the working directory.
 *
 * The attachment bytes are attacker-influenced, so the server refuses to put
 * them inside a dot-directory or a dot-file (where tools read configuration
 * and hooks) and never creates an executable file.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_MUTATION_LOG = "false";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      registerTool: mockRegisterTool,
      server: {
        getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
        getClientCapabilities: () => ({}),
      },
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

const posture = vi.hoisted(() => ({ readOnly: false as boolean }));

const mockGetAttachmentMetadata = vi.fn();
const mockDownloadBytes = vi.fn();

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    getAttachmentMetadata: (...args: unknown[]) => mockGetAttachmentMetadata(...args),
    downloadAttachmentBytes: (...args: unknown[]) => mockDownloadBytes(...args),
    getConfig: vi.fn(async () => ({
      url: "https://test.atlassian.net",
      email: "user@example.com",
      profile: "download-test",
      readOnly: posture.readOnly,
      effectivePosture: posture.readOnly ? "read-only" : "read-write",
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    })),
    validateStartup: vi.fn().mockResolvedValue(undefined),
  };
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

async function bootDownload(): Promise<Handler> {
  mockRegisterTool.mockClear();
  vi.resetModules();
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find(([name]) => name === "download_attachment");
  if (call === undefined) throw new Error("download_attachment was not registered");
  return call[2] as Handler;
}

let cwdDir: string;

beforeEach(async () => {
  posture.readOnly = false;
  cwdDir = await realpath(await mkdtemp(join(tmpdir(), "dl-attach-")));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
  mockGetAttachmentMetadata.mockReset();
  mockGetAttachmentMetadata.mockResolvedValue({
    id: "att1",
    title: "report.pdf",
    pageId: "42",
    fileSize: 4,
    mediaType: "application/pdf",
    downloadLink: "/download/att1",
  });
  mockDownloadBytes.mockReset();
  mockDownloadBytes.mockResolvedValue(Buffer.from("DATA"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cwdDir, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("download_attachment refuses dot-directories and dot-files", () => {
  it.each([
    [".git/hooks", ".git/hooks/pre-commit"],
    [".claude", ".claude/settings.json"],
    [".github", ".github/workflows/ci.yml"],
    [".vscode", ".vscode/tasks.json"],
    ["a nested dot-directory", "docs/.cache/payload.bin"],
  ])("refuses a destination under %s", async (_label, relative) => {
    const handler = await bootDownload();
    const target = join(cwdDir, relative);
    await mkdir(join(target, ".."), { recursive: true });

    const result = await handler({ attachment_id: "att1", output_path: target, overwrite: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("dot-directory");
    expect(await exists(target)).toBe(false);
    // Refused before a single payload byte was requested.
    expect(mockDownloadBytes).not.toHaveBeenCalled();
  });

  it.each([".env", ".npmrc", "out/.bashrc"])("refuses the dot-file %s", async (relative) => {
    const handler = await bootDownload();
    const target = join(cwdDir, relative);
    await mkdir(join(target, ".."), { recursive: true });

    const result = await handler({ attachment_id: "att1", output_path: target, overwrite: false });

    expect(result.isError).toBe(true);
    expect(await exists(target)).toBe(false);
    expect(mockDownloadBytes).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing file inside a dot-directory, leaving it intact", async () => {
    const handler = await bootDownload();
    const hook = join(cwdDir, ".git", "hooks", "pre-commit");
    await mkdir(join(hook, ".."), { recursive: true });
    await writeFile(hook, "ORIGINAL", { mode: 0o755 });

    const result = await handler({ attachment_id: "att1", output_path: hook, overwrite: true });

    expect(result.isError).toBe(true);
    expect(await readFile(hook, "utf-8")).toBe("ORIGINAL");
  });

  it("refuses a '..' traversal that lands in a dot-directory", async () => {
    const handler = await bootDownload();
    await mkdir(join(cwdDir, "out"), { recursive: true });
    await mkdir(join(cwdDir, ".git"), { recursive: true });
    const sneaky = `${cwdDir}/out/../.git/config`;

    const result = await handler({ attachment_id: "att1", output_path: sneaky, overwrite: true });

    expect(result.isError).toBe(true);
    expect(await exists(join(cwdDir, ".git", "config"))).toBe(false);
  });

  it("still refuses a leading-dot attachment title when no output_path is given", async () => {
    const handler = await bootDownload();
    mockGetAttachmentMetadata.mockResolvedValue({
      id: "att1",
      title: ".bashrc",
      pageId: "42",
      fileSize: 4,
      mediaType: "text/plain",
      downloadLink: "/download/att1",
    });

    const result = await handler({ attachment_id: "att1", overwrite: false });

    expect(result.isError).toBe(true);
    expect(await exists(join(cwdDir, ".bashrc"))).toBe(false);
    expect(mockDownloadBytes).not.toHaveBeenCalled();
  });
});

describe("download_attachment still works for ordinary destinations", () => {
  it("writes under the working directory with an owner-only, non-executable mode", async () => {
    const handler = await bootDownload();
    const target = join(cwdDir, "out", "report.pdf");
    await mkdir(join(target, ".."), { recursive: true });

    const result = await handler({ attachment_id: "att1", output_path: target, overwrite: false });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(`Saved to: ${target}`);
    expect(await readFile(target, "utf-8")).toBe("DATA");
    expect((await stat(target)).mode & 0o7177).toBe(0);
  });

  it("uses the attachment's own filename by default", async () => {
    const handler = await bootDownload();

    const result = await handler({ attachment_id: "att1", overwrite: false });

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(cwdDir, "report.pdf"), "utf-8")).toBe("DATA");
  });

  it("is not blocked by a working directory that itself lives under a dot-directory", async () => {
    const dotParent = await realpath(await mkdtemp(join(tmpdir(), "dl-dotparent-")));
    const dotCwd = join(dotParent, ".worktrees", "lane");
    await mkdir(dotCwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(dotCwd);
    try {
      const handler = await bootDownload();
      const target = join(dotCwd, "report.pdf");

      const result = await handler({ attachment_id: "att1", output_path: target, overwrite: false });

      expect(result.isError).not.toBe(true);
      expect(await readFile(target, "utf-8")).toBe("DATA");
    } finally {
      await rm(dotParent, { recursive: true, force: true });
    }
  });

  it("strips the executable bit when overwrite replaces an executable file", async () => {
    const handler = await bootDownload();
    const target = join(cwdDir, "tool.sh");
    await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
    await chmod(target, 0o755);

    const result = await handler({ attachment_id: "att1", output_path: target, overwrite: true });

    expect(result.isError).not.toBe(true);
    expect(await readFile(target, "utf-8")).toBe("DATA");
    expect((await stat(target)).mode & 0o7111).toBe(0);
  });

  it("remains available in a read-only profile (intentional)", async () => {
    posture.readOnly = true;
    const handler = await bootDownload();

    const result = await handler({ attachment_id: "att1", overwrite: false });

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(cwdDir, "report.pdf"), "utf-8")).toBe("DATA");
  });
});
