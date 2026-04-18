import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn(),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  getPendingUpdate: vi.fn(),
  performUpgrade: vi.fn(),
  verifyNpmProvenance: vi.fn(),
}));

import {
  checkForUpdates,
  clearPendingUpdate,
  getPendingUpdate,
  performUpgrade,
  verifyNpmProvenance,
} from "../shared/update-check.js";
import { runUpgrade } from "./upgrade.js";

const mockCheckForUpdates = vi.mocked(checkForUpdates);
const mockClearPendingUpdate = vi.mocked(clearPendingUpdate);
const mockGetPendingUpdate = vi.mocked(getPendingUpdate);
const mockPerformUpgrade = vi.mocked(performUpgrade);
const mockVerifyNpmProvenance = vi.mocked(verifyNpmProvenance);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runUpgrade (Track A2 CLI)", () => {
  it("reports up-to-date when there is no pending record and no update from the registry", async () => {
    mockGetPendingUpdate.mockResolvedValue(null);
    mockCheckForUpdates.mockResolvedValue(null);

    const result = await runUpgrade();

    expect(result.status).toBe("up-to-date");
    expect(mockVerifyNpmProvenance).not.toHaveBeenCalled();
    expect(mockPerformUpgrade).not.toHaveBeenCalled();
  });

  it("success path: pending record + provenance passes + install succeeds → status=installed, pending cleared", async () => {
    mockGetPendingUpdate.mockResolvedValue({
      // Must match the current __PKG_VERSION__ (test shim resolves to whatever vitest injects)
      current: (globalThis as any).__PKG_VERSION__ ?? "1.0.0",
      latest: "9.9.9",
      type: "patch",
    });
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("added 1 package");

    const result = await runUpgrade();

    expect(mockVerifyNpmProvenance).toHaveBeenCalledWith("9.9.9");
    expect(mockPerformUpgrade).toHaveBeenCalledWith("9.9.9");
    expect(mockClearPendingUpdate).toHaveBeenCalledOnce();
    expect(result.status).toBe("installed");
    expect(result.installed).toBe("9.9.9");
  });

  it("refuses install when provenance verification fails, leaves pending intact", async () => {
    mockGetPendingUpdate.mockResolvedValue({
      current: (globalThis as any).__PKG_VERSION__ ?? "1.0.0",
      latest: "9.9.9",
      type: "patch",
    });
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
    mockGetPendingUpdate.mockResolvedValue({
      current: (globalThis as any).__PKG_VERSION__ ?? "1.0.0",
      latest: "9.9.9",
      type: "patch",
    });
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockRejectedValue(new Error("EACCES on /usr/local/lib"));

    const result = await runUpgrade();

    expect(result.status).toBe("install-failed");
    expect(result.message).toContain("EACCES");
    expect(mockClearPendingUpdate).not.toHaveBeenCalled();
  });

  it("clears a stale pending record whose current doesn't match the running version", async () => {
    mockGetPendingUpdate.mockResolvedValue({
      current: "0.0.1-stale", // different from running version
      latest: "9.9.9",
      type: "patch",
    });

    const result = await runUpgrade();

    expect(result.status).toBe("up-to-date");
    expect(mockClearPendingUpdate).toHaveBeenCalledOnce();
    expect(mockVerifyNpmProvenance).not.toHaveBeenCalled();
  });

  it("falls back to checkForUpdates when there is no pending record", async () => {
    mockGetPendingUpdate.mockResolvedValue(null);
    mockCheckForUpdates.mockResolvedValue({
      current: (globalThis as any).__PKG_VERSION__ ?? "1.0.0",
      latest: "9.9.9",
      type: "patch",
    });
    mockVerifyNpmProvenance.mockResolvedValue({ ok: true });
    mockPerformUpgrade.mockResolvedValue("added 1 package");

    const result = await runUpgrade();

    expect(mockCheckForUpdates).toHaveBeenCalledOnce();
    expect(result.status).toBe("installed");
  });
});
