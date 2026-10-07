import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { runUpgrade } from "./upgrade.js";

const mockCheckLatestNow = vi.mocked(checkLatestNow);
const mockClearPendingUpdate = vi.mocked(clearPendingUpdate);
const mockGetPendingUpdate = vi.mocked(getPendingUpdate);
const mockPerformUpgrade = vi.mocked(performUpgrade);
const mockVerifyNpmProvenance = vi.mocked(verifyNpmProvenance);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(mockPerformUpgrade).toHaveBeenCalledWith("9.9.9");
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
