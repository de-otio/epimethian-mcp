import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, symlink, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeOpenRead,
  safeOpenAppend,
  safeWriteFile,
  verifyDirChain,
  findDotSegment,
  SAFE_FS_HAS_O_NOFOLLOW,
} from "./safe-fs.js";

/**
 * Integration tests for the E2 helpers. Uses real files under a tempdir so
 * the `O_NOFOLLOW` semantics are exercised against a real kernel (the unit
 * tests mock safe-fs out entirely).
 *
 * Skipped on Windows: the symlink attacks these tests probe require elevated
 * privileges to create, and our helpers degrade gracefully there anyway.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("safeOpenRead (E2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-read-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a regular file with 0600 perms", async () => {
    const path = join(dir, "ok.json");
    await writeFile(path, `{"hello":"world"}`, { mode: 0o600 });
    const content = await safeOpenRead(path);
    expect(content).toBe(`{"hello":"world"}`);
  });

  it("rejects a symlinked target with ELOOP", async () => {
    if (!SAFE_FS_HAS_O_NOFOLLOW) return;
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    await writeFile(real, "secret", { mode: 0o600 });
    await symlink(real, link);

    await expect(safeOpenRead(link)).rejects.toThrow();
    // Specifically the ELOOP errno from open(O_NOFOLLOW).
    await safeOpenRead(link).catch((err: NodeJS.ErrnoException) => {
      expect(err.code).toBe("ELOOP");
    });
  });

  it("rejects a group-writable file with 'unsafe-permissions'", async () => {
    const path = join(dir, "bad-perms.txt");
    await writeFile(path, "content", { mode: 0o660 });
    // chmod explicitly in case umask trimmed the mode.
    await chmod(path, 0o660);
    await expect(safeOpenRead(path)).rejects.toThrow("unsafe-permissions");
  });

  it("rejects a world-writable file with 'unsafe-permissions'", async () => {
    const path = join(dir, "ww.txt");
    await writeFile(path, "content");
    await chmod(path, 0o606);
    await expect(safeOpenRead(path)).rejects.toThrow("unsafe-permissions");
  });

  it("propagates ENOENT for a missing file", async () => {
    const path = join(dir, "missing.txt");
    await safeOpenRead(path).catch((err: NodeJS.ErrnoException) => {
      expect(err.code).toBe("ENOENT");
    });
  });
});

posixOnly("safeOpenAppend (E2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-append-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new file with 0600 perms and appends data", async () => {
    const path = join(dir, "log.txt");
    await safeOpenAppend(path, "line1\n");
    await safeOpenAppend(path, "line2\n");

    const { readFile, stat } = await import("node:fs/promises");
    const contents = await readFile(path, "utf-8");
    expect(contents).toBe("line1\nline2\n");

    const st = await stat(path);
    // Mode may include file-type bits; compare the permission bits only.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked target", async () => {
    if (!SAFE_FS_HAS_O_NOFOLLOW) return;
    const real = join(dir, "real.log");
    const link = join(dir, "evil.log");
    await writeFile(real, "", { mode: 0o600 });
    await symlink(real, link);

    await expect(safeOpenAppend(link, "entry\n")).rejects.toThrow();
  });
});

posixOnly("verifyDirChain (E2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-chain-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a freshly-created owner-only tempdir chain", async () => {
    // Pass `dir` as the stopAt boundary so we don't walk into the system
    // tempdir (which on macOS lives under root-owned `/var/folders/...`).
    await chmod(dir, 0o700);
    await verifyDirChain(dir, dir);
  });

  it("rejects a group-writable parent", async () => {
    const child = join(dir, "child");
    await mkdir(child, { mode: 0o700 });
    await chmod(dir, 0o770);

    await expect(verifyDirChain(child, dir)).rejects.toThrow(
      /group- or world-writable/,
    );
  });

  it("rejects a symlinked ancestor", async () => {
    if (!SAFE_FS_HAS_O_NOFOLLOW) return;
    const realParent = join(dir, "real");
    const linkedParent = join(dir, "linked");
    const child = join(linkedParent, "leaf");
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);
    // Create the leaf through the real path so the child exists.
    await mkdir(join(realParent, "leaf"), { mode: 0o700 });

    await expect(verifyDirChain(child, dir)).rejects.toThrow(/symlink/);
  });
});

posixOnly("safeWriteFile (download_attachment write path)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new file with 0600 perms and the exact bytes", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const path = join(dir, "new.bin");
    const data = new Uint8Array([0x00, 0xff, 0x41, 0x0a]);

    await safeWriteFile(path, data);

    expect(new Uint8Array(await readFile(path))).toEqual(data);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rejects an existing file with EEXIST when overwrite is not set", async () => {
    const path = join(dir, "exists.bin");
    await writeFile(path, "ORIGINAL", { mode: 0o600 });

    await expect(
      safeWriteFile(path, new TextEncoder().encode("replacement")),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf-8")).toBe("ORIGINAL");
  });

  it("truncates and replaces when overwrite is true", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const path = join(dir, "replace.bin");
    // Longer than the replacement, so a missing O_TRUNC would leave a tail.
    await writeFile(path, "X".repeat(64), { mode: 0o600 });

    await safeWriteFile(path, new TextEncoder().encode("hi"), {
      overwrite: true,
    });

    expect(await readFile(path, "utf-8")).toBe("hi");
    expect((await stat(path)).size).toBe(2);
  });

  it("rejects a symlinked destination with ELOOP and leaves the target intact", async () => {
    if (!SAFE_FS_HAS_O_NOFOLLOW) return;
    const { readFile } = await import("node:fs/promises");
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    await writeFile(real, "TARGET", { mode: 0o600 });
    await symlink(real, link);

    // overwrite: true is the case that reaches O_TRUNC, so O_NOFOLLOW is the
    // only guard left.
    await expect(
      safeWriteFile(link, new TextEncoder().encode("attacker"), {
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "ELOOP" });

    expect(await readFile(real, "utf-8")).toBe("TARGET");
  });

  it("rejects a symlinked destination with EEXIST when overwrite is not set", async () => {
    if (!SAFE_FS_HAS_O_NOFOLLOW) return;
    const { readFile } = await import("node:fs/promises");
    const real = join(dir, "real2.txt");
    const link = join(dir, "link2.txt");
    await writeFile(real, "TARGET", { mode: 0o600 });
    await symlink(real, link);

    await expect(
      safeWriteFile(link, new TextEncoder().encode("attacker")),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(real, "utf-8")).toBe("TARGET");
  });

  it("writes an empty payload without error", async () => {
    const { stat } = await import("node:fs/promises");
    const path = join(dir, "empty.bin");
    await safeWriteFile(path, new Uint8Array(0));
    expect((await stat(path)).size).toBe(0);
  });
});

describe("findDotSegment (download_attachment dot-directory rule, H5)", () => {
  const root = "/work/project";

  it.each([
    [".git", "/work/project/.git/hooks/pre-commit", ".git"],
    [".claude", "/work/project/.claude/settings.json", ".claude"],
    [".github", "/work/project/.github/workflows/ci.yml", ".github"],
    [".vscode", "/work/project/.vscode/tasks.json", ".vscode"],
    ["any other dot-directory", "/work/project/docs/.cache/x.bin", ".cache"],
    ["a dot-file in the root", "/work/project/.env", ".env"],
    ["a dot-file in a subdirectory", "/work/project/out/.npmrc", ".npmrc"],
    ["a deeply nested dot-directory", "/work/project/a/b/c/.hidden/d/e.bin", ".hidden"],
    ["a dot-directory with a trailing dot name", "/work/project/..data/x", "..data"],
  ])("refuses %s", (_label, path, segment) => {
    expect(findDotSegment(path, root)).toBe(segment);
  });

  it("reports the FIRST dot segment when there are several", () => {
    expect(findDotSegment("/work/project/.git/.hooks/x", root)).toBe(".git");
  });

  it.each([
    "/work/project/report.pdf",
    "/work/project/out/report.v2.pdf",
    "/work/project/docs/a.b/c.txt",
    "/work/project/out/file.",
  ])("allows %s", (path) => {
    expect(findDotSegment(path, root)).toBeUndefined();
  });

  it("allows the root itself", () => {
    expect(findDotSegment(root, root)).toBeUndefined();
  });

  it("measures segments below the root, so a root inside a dot-directory is not refused for it", () => {
    const dotRoot = "/home/user/.claude/worktrees/lane";
    expect(findDotSegment(`${dotRoot}/out/file.bin`, dotRoot)).toBeUndefined();
    expect(findDotSegment(`${dotRoot}/.git/config`, dotRoot)).toBe(".git");
  });

  it("normalises '..' and '.' before judging, so traversal cannot hide a segment", () => {
    expect(findDotSegment("/work/project/out/../.git/config", root)).toBe(".git");
    expect(findDotSegment("/work/project/./out/./file.bin", root)).toBeUndefined();
  });

  it("fails closed for a path outside the root", () => {
    expect(findDotSegment("/elsewhere/file.bin", root)).toBe("..");
    expect(findDotSegment("/work/other/file.bin", root)).toBe("..");
  });
});

posixOnly("safeWriteFile never produces executable files (H5)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-exec-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates new files with no execute bit even under a permissive umask", async () => {
    const { stat } = await import("node:fs/promises");
    const previous = process.umask(0);
    try {
      const path = join(dir, "new.sh");
      await safeWriteFile(path, new TextEncoder().encode("#!/bin/sh\necho hi\n"));
      expect((await stat(path)).mode & 0o7111).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("clears execute bits when overwrite replaces an executable file", async () => {
    const { stat, readFile } = await import("node:fs/promises");
    const path = join(dir, "tool.sh");
    await writeFile(path, "#!/bin/sh\n", { mode: 0o755 });
    await chmod(path, 0o755);
    expect((await stat(path)).mode & 0o111).not.toBe(0);

    await safeWriteFile(path, new TextEncoder().encode("replaced"), { overwrite: true });

    const after = await stat(path);
    expect(after.mode & 0o7111).toBe(0);
    // Read/write bits the file already had are kept.
    expect(after.mode & 0o644).toBe(0o644);
    expect(await readFile(path, "utf-8")).toBe("replaced");
  });

  it("clears setuid and setgid bits as well when overwriting", async () => {
    const { stat } = await import("node:fs/promises");
    const path = join(dir, "suid.bin");
    await writeFile(path, "x", { mode: 0o600 });
    await chmod(path, 0o6755);

    await safeWriteFile(path, new TextEncoder().encode("y"), { overwrite: true });

    expect((await stat(path)).mode & 0o7111).toBe(0);
  });

  it("leaves a non-executable file's mode alone when overwriting", async () => {
    const { stat } = await import("node:fs/promises");
    const path = join(dir, "plain.txt");
    await writeFile(path, "x", { mode: 0o640 });
    await chmod(path, 0o640);

    await safeWriteFile(path, new TextEncoder().encode("y"), { overwrite: true });

    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });
});
