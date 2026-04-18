import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, symlink, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeOpenRead,
  safeOpenAppend,
  verifyDirChain,
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
