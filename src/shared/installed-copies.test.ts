/**
 * Finding every installed copy of the package, against fake npm prefixes in
 * temp directories. Nothing here reads a real global prefix: the fixed system
 * prefixes are overridden with `systemPrefixes`, and `home`, `env` and the
 * running script all point into the temp tree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidatePrefixes,
  describeCopies,
  describeNotUpgraded,
  findInstalledCopies,
  runningBinPath,
  upgradeInstruction,
  type InstalledCopy,
} from "./installed-copies.js";

let root: string;

/** Make `<prefix>/lib/node_modules/@de-otio/epimethian-mcp` and a bin link into it. */
async function makePrefix(prefix: string, version: string | null): Promise<{ bin: string; pkgDir: string }> {
  const pkgDir = join(prefix, "lib", "node_modules", "@de-otio", "epimethian-mcp");
  await mkdir(join(pkgDir, "dist", "cli"), { recursive: true });
  await writeFile(join(pkgDir, "dist", "cli", "index.js"), "");
  if (version !== null) {
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@de-otio/epimethian-mcp", version }));
  }
  await mkdir(join(prefix, "bin"), { recursive: true });
  const bin = join(prefix, "bin", "epimethian-mcp");
  await symlink(join(pkgDir, "dist", "cli", "index.js"), bin);
  return { bin, pkgDir };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "epi-copies-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base = () => ({ platform: "darwin" as const, home: join(root, "home"), systemPrefixes: [] as string[] });

describe("findInstalledCopies", () => {
  it("two prefixes on PATH: two copies, with versions, the running one and the PATH ranks", async () => {
    const brew = await makePrefix(join(root, "brew"), "7.4.0");
    const nvm = await makePrefix(join(root, "other"), "7.2.0");
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: [join(root, "other", "bin"), join(root, "brew", "bin")].join(":") },
      runningScript: brew.bin,
    });
    expect(copies).toHaveLength(2);
    const byDir = Object.fromEntries(copies.map((c) => [c.packageDir, c]));
    expect(byDir[brew.pkgDir]).toMatchObject({ prefix: join(root, "brew"), version: "7.4.0", running: true, pathRank: 1 });
    expect(byDir[nvm.pkgDir]).toMatchObject({ prefix: join(root, "other"), version: "7.2.0", running: false, pathRank: 0 });
    // The running copy is listed first.
    expect(copies[0].running).toBe(true);
  });

  it("the same prefix reached through PATH and through the well-known list is one copy (deduped by realpath)", async () => {
    // home is a symlink, so the well-known ~/.npm-global path is not the
    // realpath that the PATH hit resolves to.
    await mkdir(join(root, "home-real"), { recursive: true });
    await symlink(join(root, "home-real"), join(root, "home"));
    const g = await makePrefix(join(root, "home-real", ".npm-global"), "7.3.0");
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: join(root, "home-real", ".npm-global", "bin") },
      runningScript: g.bin,
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ version: "7.3.0", running: true, pathRank: 0 });
  });

  it("finds a copy under ~/.nvm/versions/node/* that is not on PATH (the IDE-started-from-the-Dock case)", async () => {
    const brew = await makePrefix(join(root, "brew"), "7.4.0");
    await makePrefix(join(root, "home", ".nvm", "versions", "node", "v22.1.0"), "7.2.0");
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: join(root, "brew", "bin") },
      runningScript: brew.bin,
    });
    expect(copies.map((c) => c.version).sort()).toEqual(["7.2.0", "7.4.0"]);
    const nvm = copies.find((c) => c.version === "7.2.0")!;
    expect(nvm.prefix).toBe(join(root, "home", ".nvm", "versions", "node", "v22.1.0"));
    expect(nvm.pathRank).toBeNull();
    expect(nvm.running).toBe(false);
  });

  it("finds copies under the fixed prefixes and ~/.npm-global that are not on PATH", async () => {
    await makePrefix(join(root, "sys"), "7.0.0");
    await makePrefix(join(root, "home", ".npm-global"), "7.1.0");
    const copies = await findInstalledCopies({ ...base(), systemPrefixes: [join(root, "sys")], env: { PATH: "" } });
    expect(copies.map((c) => c.version)).toEqual(["7.0.0", "7.1.0"]);
  });

  it("probes $NVM_DIR as well as ~/.nvm", async () => {
    await makePrefix(join(root, "nvmdir", "versions", "node", "v20.0.0"), "7.1.0");
    const copies = await findInstalledCopies({ ...base(), env: { PATH: "", NVM_DIR: join(root, "nvmdir") } });
    expect(copies.map((c) => c.version)).toEqual(["7.1.0"]);
  });

  it("an nvm folder with three Node versions, one holding the package, gives one copy", async () => {
    const versions = join(root, "home", ".nvm", "versions", "node");
    await mkdir(join(versions, "v18.20.0", "lib", "node_modules"), { recursive: true });
    await mkdir(join(versions, "v20.11.0", "lib", "node_modules", "typescript"), { recursive: true });
    await makePrefix(join(versions, "v22.1.0"), "7.2.0");
    const copies = await findInstalledCopies({ ...base(), env: { PATH: "" } });
    expect(copies).toHaveLength(1);
    expect(copies[0].prefix).toBe(join(versions, "v22.1.0"));
  });

  it("a missing or unreadable package.json gives version null, without throwing", async () => {
    const a = await makePrefix(join(root, "a"), null);
    const b = await makePrefix(join(root, "b"), "7.4.0");
    await writeFile(join(b.pkgDir, "package.json"), "{ not json");
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: [join(root, "a", "bin"), join(root, "b", "bin")].join(":") },
      runningScript: a.bin,
    });
    expect(copies).toHaveLength(2);
    expect(copies.map((c) => c.version)).toEqual([null, null]);
  });

  it("ignores a source checkout's bin on PATH", async () => {
    const checkout = join(root, "repo");
    await mkdir(join(checkout, "dist", "cli"), { recursive: true });
    await writeFile(join(checkout, "dist", "cli", "index.js"), "");
    await mkdir(join(checkout, "node_modules", ".bin"), { recursive: true });
    await symlink(join(checkout, "dist", "cli", "index.js"), join(checkout, "node_modules", ".bin", "epimethian-mcp"));
    const g = await makePrefix(join(root, "brew"), "7.4.0");
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: [join(checkout, "node_modules", ".bin"), join(root, "brew", "bin")].join(":") },
      runningScript: join(checkout, "dist", "cli", "index.js"),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ packageDir: g.pkgDir, running: false });
    // The checkout's hit still counts as a PATH hit, so the global copy is second.
    expect(copies[0].pathRank).toBe(1);
  });

  it("includes the running copy even when no probe would find it", async () => {
    const custom = await makePrefix(join(root, "custom"), "7.4.0");
    const copies = await findInstalledCopies({ ...base(), env: { PATH: "" }, runningScript: custom.bin });
    expect(copies).toEqual([
      { prefix: join(root, "custom"), packageDir: custom.pkgDir, version: "7.4.0", running: true, pathRank: null },
    ]);
  });

  it("returns [] and does not throw when every fs call throws", async () => {
    await makePrefix(join(root, "brew"), "7.4.0");
    const boom = () => Promise.reject(new Error("EIO"));
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: join(root, "brew", "bin") },
      runningScript: join(root, "brew", "bin", "epimethian-mcp"),
      fs: { realpath: boom, readFile: boom, readdir: boom },
    });
    expect(copies).toEqual([]);
  });

  it("returns [] when the fs functions throw synchronously", async () => {
    const boom = () => {
      throw new Error("EIO");
    };
    const copies = await findInstalledCopies({
      ...base(),
      env: { PATH: join(root, "brew", "bin") },
      fs: { realpath: boom, readFile: boom, readdir: boom },
    });
    expect(copies).toEqual([]);
  });

  it("caps the nvm listing", async () => {
    const versions = join(root, "home", ".nvm", "versions", "node");
    for (let i = 0; i < 70; i++) await mkdir(join(versions, `v${i}.0.0`), { recursive: true });
    const seen: string[] = [];
    const { realpath: rp, readFile: rf, readdir: rd } = await import("node:fs/promises");
    await findInstalledCopies({
      ...base(),
      env: { PATH: "" },
      fs: {
        realpath: (p) => {
          seen.push(p);
          return rp(p);
        },
        readFile: (p, e) => rf(p, e),
        readdir: (p) => rd(p),
      },
    });
    expect(seen.filter((p) => p.startsWith(versions)).length).toBe(64);
  });
});

describe("candidatePrefixes", () => {
  it("POSIX: PATH bins in order, the fixed prefixes, ~/.npm-global and the nvm roots", () => {
    const c = candidatePrefixes({ env: { PATH: "/a/bin::/b/bin" }, platform: "darwin", home: "/Users/u" });
    expect(c.pathBins).toEqual(["/a/bin/epimethian-mcp", "/b/bin/epimethian-mcp"]);
    expect(c.prefixes).toEqual(["/opt/homebrew", "/usr/local", "/usr", "/Users/u/.npm-global"]);
    expect(c.nvmVersionRoots).toEqual(["/Users/u/.nvm/versions/node"]);
  });

  it("POSIX: $NVM_DIR is probed alongside ~/.nvm", () => {
    const c = candidatePrefixes({ env: { NVM_DIR: "/srv/nvm" }, platform: "linux", home: "/home/u" });
    expect(c.nvmVersionRoots).toEqual(["/home/u/.nvm/versions/node", "/srv/nvm/versions/node"]);
  });

  it("win32: the .cmd bin name, ';' as the separator, a case-insensitive Path, and %APPDATA%\\npm", () => {
    const c = candidatePrefixes({
      env: { Path: "C:\\Program Files\\nodejs;C:\\Users\\u\\AppData\\Roaming\\npm", APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      home: "C:\\Users\\u",
    });
    expect(c.pathBins).toEqual([
      "C:\\Program Files\\nodejs\\epimethian-mcp.cmd",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\epimethian-mcp.cmd",
    ]);
    expect(c.prefixes).toEqual(["C:\\Users\\u\\AppData\\Roaming\\npm"]);
    expect(c.nvmVersionRoots).toEqual([]);
  });

  it("systemPrefixes replaces the fixed list", () => {
    const c = candidatePrefixes({ env: {}, platform: "darwin", home: "/Users/u", systemPrefixes: ["/x"] });
    expect(c.prefixes).toEqual(["/x", "/Users/u/.npm-global"]);
  });
});

describe("runningBinPath", () => {
  it("is <prefix>/bin/epimethian-mcp on POSIX and <prefix>\\epimethian-mcp.cmd on win32", () => {
    expect(runningBinPath("/opt/homebrew", "darwin")).toBe("/opt/homebrew/bin/epimethian-mcp");
    expect(runningBinPath("C:\\Users\\u\\AppData\\Roaming\\npm", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\npm\\epimethian-mcp.cmd"
    );
  });
});

const BREW: InstalledCopy = {
  prefix: "/opt/homebrew",
  packageDir: "/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp",
  version: "7.4.0",
  running: true,
  pathRank: 0,
};
const NVM: InstalledCopy = {
  prefix: "/Users/u/.nvm/versions/node/v22.1.0",
  packageDir: "/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@de-otio/epimethian-mcp",
  version: "7.2.0",
  running: false,
  pathRank: null,
};

describe("describeCopies", () => {
  it("returns null for fewer than two copies", () => {
    expect(describeCopies([], "7.4.0")).toBeNull();
    expect(describeCopies([BREW], "7.4.0")).toBeNull();
  });

  it("two copies: the block, with the running one marked and the other's uninstall line", () => {
    expect(describeCopies([BREW, NVM], "7.4.0", { platform: "darwin" })).toBe(
      [
        "2 copies of epimethian-mcp are installed:",
        "  v7.4.0  /opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp   ← this server",
        "  v7.2.0  /Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@de-otio/epimethian-mcp",
        "An upgrade replaces only the copy it runs from. Keep the copy your MCP",
        `config's "command" starts, and remove the other:`,
        "  npm uninstall -g --prefix /Users/u/.nvm/versions/node/v22.1.0 @de-otio/epimethian-mcp",
      ].join("\n")
    );
  });

  it("uses the caller's label for the running copy", () => {
    expect(describeCopies([BREW, NVM], "7.4.0", { runningLabel: "this command" })).toContain("← this command");
  });

  it("running from a source checkout: lists the global copies, marks none, and gives every uninstall line", () => {
    const out = describeCopies([{ ...BREW, running: false }, NVM], "7.5.0-dev", { platform: "darwin" })!;
    expect(out).not.toContain("←");
    expect(out).toContain("npm uninstall -g --prefix /opt/homebrew @de-otio/epimethian-mcp");
    expect(out).toContain("npm uninstall -g --prefix /Users/u/.nvm/versions/node/v22.1.0 @de-otio/epimethian-mcp");
  });

  it("never offers to uninstall the running copy", () => {
    const out = describeCopies([BREW, NVM], "7.4.0", { platform: "darwin" })!;
    expect(out).not.toContain("--prefix /opt/homebrew ");
  });

  it("quotes a prefix that holds spaces", () => {
    const spaced = { ...NVM, prefix: "/Users/u/My Tools/npm", packageDir: "/Users/u/My Tools/npm/lib/node_modules/@de-otio/epimethian-mcp" };
    expect(describeCopies([BREW, spaced], "7.4.0", { platform: "darwin" })).toContain(
      "npm uninstall -g --prefix '/Users/u/My Tools/npm' @de-otio/epimethian-mcp"
    );
    const win = {
      ...NVM,
      prefix: "C:\\Users\\John Doe\\AppData\\Roaming\\npm",
      packageDir: "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\@de-otio\\epimethian-mcp",
    };
    expect(describeCopies([BREW, win], "7.4.0", { platform: "win32" })).toContain(
      `npm uninstall -g --prefix "C:\\Users\\John Doe\\AppData\\Roaming\\npm" @de-otio/epimethian-mcp`
    );
  });

  it("shows an unknown version, falling back to the running version for the running copy", () => {
    const out = describeCopies([{ ...BREW, version: null }, { ...NVM, version: null }], "7.4.0")!;
    expect(out).toContain("  v7.4.0   /opt/homebrew/");
    expect(out).toContain("unknown  /Users/u/.nvm/");
  });
});

describe("describeNotUpgraded", () => {
  it("lists the copy the upgrade did not touch, with its uninstall line", () => {
    expect(describeNotUpgraded([BREW, NVM], "darwin")).toBe(
      [
        "Not upgraded: v7.2.0 at /Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@de-otio/epimethian-mcp",
        "If your MCP config starts that copy, it still runs v7.2.0. Remove the copy you don't use:",
        "  npm uninstall -g --prefix /Users/u/.nvm/versions/node/v22.1.0 @de-otio/epimethian-mcp",
      ].join("\n")
    );
  });

  it("returns null when the upgraded copy is the only one", () => {
    expect(describeNotUpgraded([BREW], "darwin")).toBeNull();
  });
});

describe("upgradeInstruction", () => {
  it("names the running copy's bin by absolute path when there are two or more copies", () => {
    expect(upgradeInstruction([BREW, NVM], "darwin")).toBe(
      'Ask your agent to run the `upgrade` tool, or run `"/opt/homebrew/bin/epimethian-mcp" upgrade` in your terminal. ' +
        "A bare `epimethian-mcp upgrade` may upgrade a different copy (see above)."
    );
  });

  it("is null with one copy, or when no copy is the running one", () => {
    expect(upgradeInstruction([BREW], "darwin")).toBeNull();
    expect(upgradeInstruction([{ ...BREW, running: false }, NVM], "darwin")).toBeNull();
  });
});
