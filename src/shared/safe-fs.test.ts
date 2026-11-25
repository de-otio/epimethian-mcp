import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  safeOpenReadWithStat,
  safeAtomicWrite,
  UnsafePathError,
  _setSafeFsHooksForTests,
  _resetForTests,
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

// ---------------------------------------------------------------------------
// Policy gate step 0: safeOpenReadWithStat and safeAtomicWrite (0-D1, 0-D2,
// the safe-fs half of 0-T11).
// ---------------------------------------------------------------------------

/** FileHandle.prototype, reached through a real handle (the class is not exported). */
async function fileHandleProto(dir: string): Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> {
  const { open } = await import("node:fs/promises");
  const probe = join(dir, ".probe");
  await writeFile(probe, "", { mode: 0o600 });
  const fh = await open(probe, "r");
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  await rm(probe);
  return proto;
}

posixOnly("safeOpenReadWithStat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-readstat-"));
    await chmod(dir, 0o700);
    // The directory chain is checked up to HOME; the tempdir is HOME here.
    vi.stubEnv("HOME", dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the text and the bigint fstat of the fd it read", async () => {
    const { stat } = await import("node:fs/promises");
    const path = join(dir, "ok.json");
    await writeFile(path, `{"a":1}`, { mode: 0o600 });
    const { raw, stat: st } = await safeOpenReadWithStat(path);
    expect(raw).toBe(`{"a":1}`);
    expect(typeof st.ino).toBe("bigint");
    expect(typeof st.mtimeNs).toBe("bigint");
    expect(st.ino).toBe((await stat(path, { bigint: true })).ino);
    expect(st.size).toBe(7n);
  });

  it("rejects group- and world-writable modes with 'unsafe-permissions'", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{}", { mode: 0o600 });
    for (const mode of [0o620, 0o602, 0o666]) {
      await chmod(path, mode);
      await expect(safeOpenReadWithStat(path)).rejects.toThrow("unsafe-permissions");
    }
    await chmod(path, 0o644);
    await expect(safeOpenReadWithStat(path)).resolves.toMatchObject({ raw: "{}" });
  });

  it("rejects a file owned by another uid with 'unsafe-owner'", async () => {
    const path = join(dir, "owned.json");
    await writeFile(path, "{}", { mode: 0o600 });
    const proto = await fileHandleProto(dir);
    const original = proto.stat;
    vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const st = (await original.apply(this, args)) as { uid: bigint };
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1n });
    });
    await expect(safeOpenReadWithStat(path)).rejects.toThrow("unsafe-owner");
  });

  it("rejects an unsafe directory chain with UnsafePathError before opening", async () => {
    const sub = join(dir, "cfg");
    await mkdir(sub, { mode: 0o700 });
    const path = join(sub, "p.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await chmod(sub, 0o770);
    const err = await safeOpenReadWithStat(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafePathError);
    expect((err as UnsafePathError).problem).toBe("mode");
    expect((err as Error).message).toMatch(/^unsafe-path/);
  });

  it("rejects a symlink with ELOOP and a directory or FIFO with 'not-regular-file'", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}", { mode: 0o600 });
    const link = join(dir, "link.json");
    await symlink(real, link);
    await expect(safeOpenReadWithStat(link)).rejects.toMatchObject({ code: "ELOOP" });

    const sub = join(dir, "adir");
    await mkdir(sub, { mode: 0o700 });
    await expect(safeOpenReadWithStat(sub)).rejects.toThrow("not-regular-file");

    const { execFileSync } = await import("node:child_process");
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    // Without O_NONBLOCK this open would block forever (no writer).
    await expect(safeOpenReadWithStat(fifo)).rejects.toThrow("not-regular-file");
  });

  it("rejects bytes that are not UTF-8 with 'invalid-utf8' and keeps a BOM", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), { mode: 0o600 });
    await expect(safeOpenReadWithStat(bad)).rejects.toThrow("invalid-utf8");
    const bom = join(dir, "bom.json");
    await writeFile(bom, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), { mode: 0o600 });
    expect((await safeOpenReadWithStat(bom)).raw).toBe("﻿{}");
  });

  it("propagates ENOENT", async () => {
    await expect(safeOpenReadWithStat(join(dir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

posixOnly("safeAtomicWrite (0-T11, safe-fs half)", () => {
  let dir: string;
  let warnings: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-fs-atomic-"));
    warnings = [];
    _setSafeFsHooksForTests({ warn: (m) => warnings.push(m) });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetForTests();
    await rm(dir, { recursive: true, force: true });
  });

  async function entries(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(dir)).sort();
  }

  it("creates the file 0600 with the exact bytes and leaves no temp", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const path = join(dir, "state.json");
    await safeAtomicWrite(path, "hello\n");
    expect(await readFile(path, "utf-8")).toBe("hello\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await entries()).toEqual(["state.json"]);
    expect(warnings).toEqual([]);
  });

  it("replaces an existing file with a new inode (rename, not truncate)", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const path = join(dir, "state.json");
    await writeFile(path, "OLD-LONGER-CONTENT", { mode: 0o600 });
    const before = (await stat(path)).ino;
    await safeAtomicWrite(path, new TextEncoder().encode("new"));
    expect(await readFile(path, "utf-8")).toBe("new");
    expect((await stat(path)).ino).not.toBe(before);
  });

  it("a failed rename leaves the old file intact and removes the temp", async () => {
    const { readFile } = await import("node:fs/promises");
    const fs = await import("node:fs");
    const path = join(dir, "state.json");
    await writeFile(path, "OLD", { mode: 0o600 });
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("injected"), { code: "EIO" }),
    );
    await expect(safeAtomicWrite(path, "NEW")).rejects.toThrow("injected");
    expect(await readFile(path, "utf-8")).toBe("OLD");
    expect(await entries()).toEqual(["state.json"]);
  });

  it("a beforeRename that throws aborts: old file intact, temp removed", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = join(dir, "state.json");
    await writeFile(path, "OLD", { mode: 0o600 });
    let tempSeen: string[] = [];
    await expect(
      safeAtomicWrite(path, "NEW", {
        beforeRename: async () => {
          tempSeen = (await entries()).filter((n) => n.endsWith(".tmp"));
          throw new Error("changed underneath");
        },
      }),
    ).rejects.toThrow("changed underneath");
    expect(tempSeen).toHaveLength(1);
    expect(tempSeen[0]).toMatch(/^\.state\.json\.[0-9a-f]{16}\.tmp$/);
    expect(await readFile(path, "utf-8")).toBe("OLD");
    expect(await entries()).toEqual(["state.json"]);
  });

  it("never follows or reuses a pre-existing temp name (O_EXCL)", async () => {
    const { readFile, lstat } = await import("node:fs/promises");
    const names = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"];
    _setSafeFsHooksForTests({ randomHex: () => names.shift() ?? "cccccccccccccccc" });
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "VICTIM", { mode: 0o600 });
    const planted = join(dir, ".state.json.aaaaaaaaaaaaaaaa.tmp");
    await symlink(victim, planted);
    const path = join(dir, "state.json");

    await safeAtomicWrite(path, "NEW");

    expect(await readFile(path, "utf-8")).toBe("NEW");
    expect(await readFile(victim, "utf-8")).toBe("VICTIM");
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
  });

  it("gives up after three taken temp names without writing anything", async () => {
    const { readFile } = await import("node:fs/promises");
    _setSafeFsHooksForTests({ randomHex: () => "dddddddddddddddd" });
    await writeFile(join(dir, ".state.json.dddddddddddddddd.tmp"), "PLANTED", { mode: 0o600 });
    const path = join(dir, "state.json");
    await writeFile(path, "OLD", { mode: 0o600 });
    await expect(safeAtomicWrite(path, "NEW")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf-8")).toBe("OLD");
    expect(await readFile(join(dir, ".state.json.dddddddddddddddd.tmp"), "utf-8")).toBe("PLANTED");
  });

  it("replaces a symlink at the target instead of writing through it", async () => {
    const { readFile, lstat } = await import("node:fs/promises");
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "VICTIM", { mode: 0o600 });
    const path = join(dir, "state.json");
    await symlink(victim, path);
    await safeAtomicWrite(path, "NEW");
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, "utf-8")).toBe("NEW");
    expect(await readFile(victim, "utf-8")).toBe("VICTIM");
  });

  it("fsyncs the temp before the rename and the directory after it, in that order", async () => {
    const fs = await import("node:fs");
    const proto = await fileHandleProto(dir);
    const fdPaths = new Map<number, string>();
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const fh = await realOpen(...args);
      fdPaths.set(fh.fd, String(args[0]));
      return fh;
    });
    const order: string[] = [];
    const realSync = proto.sync;
    vi.spyOn(proto, "sync").mockImplementation(async function (this: { fd: number }) {
      const p = fdPaths.get(this.fd) ?? "?";
      order.push(p === dir ? "sync:dir" : p.endsWith(".tmp") ? "sync:temp" : `sync:${p}`);
      return realSync.call(this);
    });
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (a, b) => {
      order.push("rename");
      return realRename(a, b);
    });

    await safeAtomicWrite(join(dir, "state.json"), "x");

    expect(order).toEqual(["sync:temp", "rename", "sync:dir"]);
  });

  it("a directory fsync failure after the rename is a stderr warning; the write resolves", async () => {
    const { readFile } = await import("node:fs/promises");
    const fs = await import("node:fs");
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      if (String(args[0]) === dir) throw Object.assign(new Error("no dir fsync"), { code: "EINVAL" });
      return realOpen(...args);
    });
    const path = join(dir, "state.json");
    await expect(safeAtomicWrite(path, "NEW")).resolves.toBeUndefined();
    expect(await readFile(path, "utf-8")).toBe("NEW");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EINVAL");
    expect(warnings[0]).toContain(path);
  });

  it("on win32 the directory fsync is not attempted", async () => {
    const fs = await import("node:fs");
    const realOpen = fs.promises.open;
    const opened: string[] = [];
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      opened.push(String(args[0]));
      return realOpen(...args);
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await safeAtomicWrite(join(dir, "state.json"), "x");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(opened).not.toContain(dir);
    expect(opened.some((p) => p.endsWith(".tmp"))).toBe(true);
    expect(warnings).toEqual([]);
  });
});
