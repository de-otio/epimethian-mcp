/**
 * performUpgrade targets the npm prefix of the running copy and checks the
 * result, against real temp directories; only `npm` itself is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCalls: string[][] = [];
/** The `cwd` each npm call ran in, parallel to `npmCalls`. */
const npmCwds: (string | undefined)[] = [];
/** The package.json found in the verification directory at install time. */
let verifyManifest: string | null = null;
/** What the mocked `npm install -g` writes, and where: null writes nothing. */
let installWrites: { prefix: "from-args" | string; version: string } | null = null;
/** Mocked `npm view … predicateType` output. */
let viewOut = "https://slsa.dev/provenance/v1\n";
/** Mocked `npm audit signatures` result: an Error makes it exit non-zero. */
let auditResult: string | Error = "120 packages have verified registry signatures\n\n12 packages have verified attestations\n";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], opts: { cwd?: string }, cb: (err: Error | null, out: unknown) => void) => {
      npmCalls.push(args);
      npmCwds.push(opts?.cwd);
      if (args[0] === "view") {
        cb(null, { stdout: viewOut, stderr: "" });
        return;
      }
      if (args[0] === "audit") {
        if (auditResult instanceof Error) cb(auditResult, undefined);
        else cb(null, { stdout: auditResult, stderr: "" });
        return;
      }
      if (args[0] === "install" && !args.includes("-g")) {
        readFile(join(opts.cwd!, "package.json"), "utf8").then(
          (m) => {
            verifyManifest = m;
            cb(null, { stdout: "added 120 packages", stderr: "" });
          },
          (e) => cb(e, undefined)
        );
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

import { performUpgrade, verifyNpmProvenance } from "./update-check.js";

let root: string;
let prefix: string;
let binLink: string;

beforeEach(async () => {
  npmCalls.length = 0;
  npmCwds.length = 0;
  verifyManifest = null;
  viewOut = "https://slsa.dev/provenance/v1\n";
  auditResult = "120 packages have verified registry signatures\n\n12 packages have verified attestations\n";
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
    const install = npmCalls.find((a) => a[0] === "install" && a.includes("-g"));
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
    expect(npmCalls.some((a) => a[0] === "install" && a.includes("-g"))).toBe(false);
  });

  it("refuses when the running script cannot be located", async () => {
    await expect(performUpgrade("7.2.0", join(root, "missing.js"))).rejects.toThrow(/not an npm global install/);
    expect(npmCalls.some((a) => a[0] === "install" && a.includes("-g"))).toBe(false);
  });
});

describe("verifyNpmProvenance", () => {
  const isGlobalInstall = (a: string[]) => a[0] === "install" && a.includes("-g");

  it("audits a temp directory holding the exact version, not the current directory", async () => {
    await expect(verifyNpmProvenance("7.3.0")).resolves.toEqual({ ok: true });

    expect(npmCalls[0]).toEqual(["view", "@de-otio/epimethian-mcp@7.3.0", "dist.attestations.provenance.predicateType"]);
    expect(npmCalls[1]).toEqual(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    // `npm audit signatures` ignores a package argument, so none is passed.
    expect(npmCalls[2]).toEqual(["audit", "signatures"]);
    const dir = npmCwds[1];
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(process.cwd());
    expect(npmCwds[2]).toBe(dir);
    expect(JSON.parse(verifyManifest!).dependencies).toEqual({ "@de-otio/epimethian-mcp": "7.3.0" });
    // The temp directory is removed afterwards.
    await expect(access(dir!)).rejects.toThrow();
  });

  it("refuses when the registry lists no provenance for the package, before installing anything", async () => {
    viewOut = "\n";
    const result = await verifyNpmProvenance("7.3.0");
    expect(result.ok).toBe(false);
    expect(npmCalls.map((a) => a[0])).toEqual(["view"]);
  });

  it("refuses when the audit exits non-zero, and removes the temp directory", async () => {
    auditResult = new Error("found 1 package with an invalid attestation");
    const result = await verifyNpmProvenance("7.3.0");
    expect(result).toEqual({ ok: false, message: expect.stringContaining("invalid attestation") });
    await expect(access(npmCwds[2]!)).rejects.toThrow();
  });

  it("refuses when the audit verifies signatures but no attestations", async () => {
    auditResult = "120 packages have verified registry signatures\n";
    const result = await verifyNpmProvenance("7.3.0");
    expect(result.ok).toBe(false);
  });

  it("performUpgrade installs nothing globally when verification fails", async () => {
    auditResult = new Error("found no installed dependencies to audit");
    await expect(performUpgrade("7.2.0", binLink)).rejects.toThrow(/Integrity check failed/);
    expect(npmCalls.some(isGlobalInstall)).toBe(false);
  });
});
