import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../shared/update-check.js", () => ({
  checkLatestNow: vi.fn(),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  getPendingUpdate: vi.fn(),
  performUpgrade: vi.fn(),
  verifyNpmProvenance: vi.fn(),
}));

import {
  checkLatestNow,
  clearPendingUpdate,
  getPendingUpdate,
  performUpgrade,
  verifyNpmProvenance,
} from "../shared/update-check.js";
import { runUpgrade as realRunUpgrade, type UpgradeDeps } from "./upgrade.js";
import { findInstalledCopies } from "../shared/installed-copies.js";

const mockCheckLatestNow = vi.mocked(checkLatestNow);
const mockClearPendingUpdate = vi.mocked(clearPendingUpdate);
const mockGetPendingUpdate = vi.mocked(getPendingUpdate);
const mockPerformUpgrade = vi.mocked(performUpgrade);
const mockVerifyNpmProvenance = vi.mocked(verifyNpmProvenance);

let root: string;

/** Hermetic by default: no probe of the real machine's prefixes. */
const runUpgrade = (deps: UpgradeDeps = {}) =>
  realRunUpgrade({ findCopies: async () => [], runningScript: join(root, "missing.js"), ...deps });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "epi-cli-upgrade-")));
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const RUNNING = (globalThis as any).__PKG_VERSION__ ?? "1.0.0";
const AVAILABLE = { status: "available" as const, info: { current: RUNNING, latest: "9.9.9", type: "patch" as const } };

describe("runUpgrade (Track A2 CLI)", () => {
  it("reports up-to-date only when the registry says so", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "up-to-date", latest: RUNNING });

    const result = await runUpgrade();

    expect(result.status).toBe("up-to-date");
    expect(mockVerifyNpmProvenance).not.toHaveBeenCalled();
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("always asks the registry, even with no pending record (the throttle must not hide a new release)", async () => {
    mockGetPendingUpdate.mockResolvedValue(null);
    mockCheckLatestNow.mockResolvedValue(AVAILABLE);
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("added 1 package");

    const result = await runUpgrade();

    expect(mockCheckLatestNow).toHaveBeenCalledWith(RUNNING);
    expect(result.status).toBe("installed");
  });

  it("an unreachable registry with no pending record is check-failed, never up-to-date", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "unreachable", reason: "the npm registry could not be reached (ENOTFOUND)" });
    mockGetPendingUpdate.mockResolvedValue(null);

    const result = await runUpgrade();

    expect(result.status).toBe("check-failed");
    expect(result.message).toContain("ENOTFOUND");
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("an unreachable registry falls back to a pending record for this version", async () => {
    mockCheckLatestNow.mockResolvedValue({ status: "unreachable", reason: "offline" });
    mockGetPendingUpdate.mockResolvedValue({ current: RUNNING, latest: "9.9.9", type: "patch" });
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("added 1 package");

    const result = await runUpgrade();

    expect(mockGetPendingUpdate).toHaveBeenCalledWith(RUNNING);
    expect(result.status).toBe("installed");
    expect(result.installed).toBe("9.9.9");
  });

  it("success path: provenance passes and the install succeeds, so the result is installed and pending is cleared", async () => {
    mockCheckLatestNow.mockResolvedValue(AVAILABLE);
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("added 1 package");

    const result = await runUpgrade();

    expect(mockVerifyNpmProvenance).toHaveBeenCalledWith("9.9.9");
    expect(mockPerformUpgrade).toHaveBeenCalledWith("9.9.9", join(root, "missing.js"));
    expect(mockClearPendingUpdate).toHaveBeenCalledOnce();
    expect(result.status).toBe("installed");
    expect(result.installed).toBe("9.9.9");
  });

  it("refuses install when provenance verification fails, leaves pending intact", async () => {
    mockCheckLatestNow.mockResolvedValue(AVAILABLE);
    mockVerifyNpmProvenance.mockResolvedValue({
      ok: false,
      message: "provenance attestation missing",
    });

    const result = await runUpgrade();

    expect(result.status).toBe("integrity-failed");
    expect(result.message).toContain("provenance attestation missing");
    // Critical: do NOT clear pending record on failure — the banner keeps nagging.
    expect(mockClearPendingUpdate).not.toHaveBeenCalled();
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("reports install-failed when performUpgrade throws", async () => {
    mockCheckLatestNow.mockResolvedValue(AVAILABLE);
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockRejectedValue(new Error("EACCES on /usr/local/lib"));

    const result = await runUpgrade();

    expect(result.status).toBe("install-failed");
    expect(result.message).toContain("EACCES");
    expect(mockClearPendingUpdate).not.toHaveBeenCalled();
  });
});

/** A fake npm global prefix holding the package, with its bin link. */
async function makePrefix(prefix: string, version: string): Promise<{ bin: string; pkgDir: string }> {
  const pkgDir = join(prefix, "lib", "node_modules", "@de-otio", "epimethian-mcp");
  await mkdir(join(pkgDir, "dist", "cli"), { recursive: true });
  await writeFile(join(pkgDir, "dist", "cli", "index.js"), "");
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ version }));
  await mkdir(join(prefix, "bin"), { recursive: true });
  const bin = join(prefix, "bin", "epimethian-mcp");
  await symlink(join(pkgDir, "dist", "cli", "index.js"), bin);
  return { bin, pkgDir };
}

describe("runUpgrade and other installed copies (fake prefixes)", () => {
  const finderFor = (runningScript: string) => () =>
    findInstalledCopies({ env: { PATH: "" }, home: join(root, "home"), systemPrefixes: [], runningScript });

  beforeEach(() => {
    mockCheckLatestNow.mockResolvedValue(AVAILABLE);
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("changed 1 package");
  });

  it("after the install, lists a second copy it did not upgrade", async () => {
    const brew = await makePrefix(join(root, "brew"), "9.9.9");
    const nvm = await makePrefix(join(root, "home", ".nvm", "versions", "node", "v22.1.0"), "7.2.0");

    const result = await runUpgrade({ runningScript: brew.bin, findCopies: finderFor(brew.bin) });

    expect(result.status).toBe("installed");
    expect(result.otherCopies).toEqual([{ packageDir: nvm.pkgDir, version: "7.2.0" }]);
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(`Not upgraded: v7.2.0 at ${nvm.pkgDir}`);
    expect(logged).toContain(
      `npm uninstall -g --prefix ${join(root, "home", ".nvm", "versions", "node", "v22.1.0")} @de-otio/epimethian-mcp`
    );
  });

  it("with no second copy, otherCopies is absent", async () => {
    const brew = await makePrefix(join(root, "brew"), "9.9.9");
    const result = await runUpgrade({ runningScript: brew.bin, findCopies: finderFor(brew.bin) });
    expect(result.status).toBe("installed");
    expect(result).not.toHaveProperty("otherCopies");
  });

  it("prints which copy it is upgrading before any install call", async () => {
    const brew = await makePrefix(join(root, "brew"), "7.4.0");
    await runUpgrade({ runningScript: brew.bin, findCopies: finderFor(brew.bin) });

    const log = vi.mocked(console.log);
    const at = log.mock.calls.findIndex((c) => String(c[0]) === `Upgrading the copy at ${brew.pkgDir}.`);
    expect(at).toBeGreaterThanOrEqual(0);
    const printedAt = log.mock.invocationCallOrder[at];
    expect(printedAt).toBeLessThan(mockVerifyNpmProvenance.mock.invocationCallOrder[0]);
    expect(printedAt).toBeLessThan(mockPerformUpgrade.mock.invocationCallOrder[0]);
  });

  it("a failed install lists no other copies and still reports the failure", async () => {
    const brew = await makePrefix(join(root, "brew"), "7.4.0");
    await makePrefix(join(root, "home", ".nvm", "versions", "node", "v22.1.0"), "7.2.0");
    mockPerformUpgrade.mockRejectedValue(new Error("EACCES"));
    const result = await runUpgrade({ runningScript: brew.bin, findCopies: finderFor(brew.bin) });
    expect(result.status).toBe("install-failed");
    expect(result).not.toHaveProperty("otherCopies");
  });
});
