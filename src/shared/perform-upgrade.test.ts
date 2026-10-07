/**
 * performUpgrade targets the npm prefix of the running copy and checks the
 * result, against real temp directories; only `npm` itself is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCalls: string[][] = [];
/** What the mocked `npm install` writes, and where: null writes nothing. */
let installWrites: { prefix: "from-args" | string; version: string } | null = null;

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
      npmCalls.push(args);
      if (args[0] === "audit") {
        cb(null, { stdout: "audited 1 package\n1 package has a verified attestation", stderr: "" });
        return;
      }
      const write = async () => {
        if (installWrites) {
          const prefix = installWrites.prefix === "from-args" ? args[args.indexOf("--prefix") + 1] : installWrites.prefix;
          const dir = join(prefix, "lib", "node_modules", "@de-otio", "epimethian-mcp");
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "package.json"), JSON.stringify({ version: installWrites.version }));
        }
      };
      write().then(() => cb(null, { stdout: "changed 1 package", stderr: "" }), (e) => cb(e, undefined));
    }
  ),
}));

import { performUpgrade } from "./update-check.js";

let root: string;
let prefix: string;
let binLink: string;

beforeEach(async () => {
  npmCalls.length = 0;
  installWrites = { prefix: "from-args", version: "7.2.0" };
  root = await realpath(await mkdtemp(join(tmpdir(), "epi-upgrade-")));
  prefix = join(root, "brew");
  const pkgDir = join(prefix, "lib", "node_modules", "@de-otio", "epimethian-mcp");
  await mkdir(join(pkgDir, "dist", "cli"), { recursive: true });
  await writeFile(join(pkgDir, "dist", "cli", "index.js"), "");
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ version: "7.1.0" }));
  await mkdir(join(prefix, "bin"), { recursive: true });
  binLink = join(prefix, "bin", "epimethian-mcp");
  await symlink(join(pkgDir, "dist", "cli", "index.js"), binLink);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("performUpgrade", () => {
  it("installs into the prefix of the running copy, found through the bin symlink, and confirms the version", async () => {
    const out = await performUpgrade("7.2.0", binLink);
    const install = npmCalls.find((a) => a[0] === "install");
    expect(install).toEqual(["install", "-g", "--prefix", prefix, "@de-otio/epimethian-mcp@7.2.0"]);
    expect(out).toContain(`Installed into ${join(prefix, "lib", "node_modules", "@de-otio", "epimethian-mcp")}`);
  });

  it("npm reporting success while the running copy stays old is an error, not a success", async () => {
    // npm wrote into some other prefix (the one first on PATH).
    installWrites = { prefix: join(root, "nvm"), version: "7.2.0" };
    await expect(performUpgrade("7.2.0", binLink)).rejects.toThrow(/is at v7\.1\.0, not v7\.2\.0/);
  });

  it("refuses a copy that is not an npm global install, without running npm install", async () => {
    const checkout = join(root, "repo", "dist", "cli");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "index.js"), "");
    await expect(performUpgrade("7.2.0", join(checkout, "index.js"))).rejects.toThrow(/not an npm global install/);
    expect(npmCalls.some((a) => a[0] === "install")).toBe(false);
  });

  it("refuses when the running script cannot be located", async () => {
    await expect(performUpgrade("7.2.0", join(root, "missing.js"))).rejects.toThrow(/not an npm global install/);
    expect(npmCalls.some((a) => a[0] === "install")).toBe(false);
  });
});
