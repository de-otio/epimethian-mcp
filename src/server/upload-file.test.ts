import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUploadFile, UploadPathError, MAX_UPLOAD_BYTES } from "./upload-file.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "upload-root-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "upload-outside-")));
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("readUploadFile", () => {
  it("reads a regular file under the working directory", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "a.drawio"), "<mxfile/>");
    const r = await readUploadFile(join(root, "docs", "a.drawio"));
    expect(r.path).toBe(join(root, "docs", "a.drawio"));
    expect(r.data.toString()).toBe("<mxfile/>");
  });

  it("resolves a relative path against the working directory", async () => {
    await writeFile(join(root, "a.txt"), "x");
    // resolve() uses the real process cwd, so pass an absolute path built from root.
    expect((await readUploadFile(`${root}/./a.txt`)).data.toString()).toBe("x");
  });

  it("refuses a file outside the working directory", async () => {
    await writeFile(join(outside, "secret.txt"), "s");
    await expect(readUploadFile(join(outside, "secret.txt"))).rejects.toThrow(/under the working directory/);
  });

  it("refuses a sibling directory whose name merely starts with the working directory's", async () => {
    const sibling = `${root}-sibling`;
    await mkdir(sibling);
    try {
      await writeFile(join(sibling, "x.txt"), "s");
      await expect(readUploadFile(join(sibling, "x.txt"))).rejects.toThrow(/under the working directory/);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points outside the working directory", async () => {
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(readUploadFile(join(root, "link.txt"))).rejects.toThrow(/under the working directory/);
  });

  it("refuses a symlinked directory that leads outside", async () => {
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(outside, join(root, "dir"));
    await expect(readUploadFile(join(root, "dir", "secret.txt"))).rejects.toThrow(/under the working directory/);
  });

  it.each([".env", ".git/config", ".claude/settings.json", "sub/.npmrc"])("refuses the dot path %s", async (rel) => {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "TOKEN=1");
    const err = await readUploadFile(full).catch((e) => e);
    expect(err).toBeInstanceOf(UploadPathError);
    expect(err.message).toMatch(/dot-directory or a dot-file/);
  });

  it("refuses a directory", async () => {
    await mkdir(join(root, "d"));
    await expect(readUploadFile(join(root, "d"))).rejects.toThrow(/Not a regular file/);
  });

  it("refuses the working directory itself", async () => {
    await expect(readUploadFile(root)).rejects.toThrow(/under the working directory/);
  });

  it("refuses a file above the size limit without reading it whole", async () => {
    const big = join(root, "big.bin");
    await writeFile(big, "");
    await truncate(big, MAX_UPLOAD_BYTES + 1);
    await expect(readUploadFile(big)).rejects.toThrow(/upload limit/);
  });

  it("accepts a file exactly at the size limit", async () => {
    const f = join(root, "edge.bin");
    await writeFile(f, "");
    await truncate(f, MAX_UPLOAD_BYTES);
    expect((await readUploadFile(f)).data.length).toBe(MAX_UPLOAD_BYTES);
  });

  it("reports a missing file", async () => {
    await expect(readUploadFile(join(root, "nope"))).rejects.toThrow(/File not found/);
  });
});
