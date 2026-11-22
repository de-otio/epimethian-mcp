/**
 * `status` for a gateway-mode profile: the Mode line, the token expiry at
 * 15 / 14 / 0 / -1 days with a frozen clock, and the connection test going
 * through the pinned gateway base (never the site URL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTestConnection = vi.fn();
const mockReadFromKeychain = vi.fn();

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/installed-copies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/installed-copies.js")>();
  return { ...actual, findInstalledCopies: vi.fn().mockResolvedValue([]) };
});

import { runStatus } from "./status.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
  process.env.CONFLUENCE_PROFILE = "gw-test";
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
  mockTestConnection.mockResolvedValue({ ok: true, message: "Connected successfully." });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CONFLUENCE_PROFILE;
});

async function statusFor(record: Record<string, unknown>): Promise<string> {
  mockReadFromKeychain.mockResolvedValue({
    url: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "tok",
    ...record,
  });
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await runStatus();
  const out = spy.mock.calls.map((c) => c[0]).join("\n");
  spy.mockRestore();
  return out;
}

const gw = (tokenExpiry?: string) => ({
  cloudId: CLOUD_ID,
  apiMode: "gateway",
  ...(tokenExpiry ? { tokenExpiry } : {}),
});

describe("status: token expiry", () => {
  it.each([
    ["2026-12-16", "Token expires: 2026-12-16 (15 days left)"],
    ["2026-12-15", "Token expires: 2026-12-15 (14 days left)"],
    ["2026-12-01", "Token expires: 2026-12-01 (expires today)"],
    ["2026-11-30", "Token expires: EXPIRED on 2026-11-30 (1 day ago)"],
  ])("expiry %s", async (expiry, line) => {
    expect(await statusFor(gw(expiry))).toContain(line);
  });

  it("no expiry recorded: no expiry line", async () => {
    expect(await statusFor(gw())).not.toContain("Token expires");
  });

  it("a site profile shows no expiry line even if the record carries a date", async () => {
    expect(await statusFor({ tokenExpiry: "2026-12-16" })).not.toContain("Token expires");
  });
});

describe("status: mode and connection base", () => {
  it("gateway: Mode line, and the connection test uses the gateway base with the gateway flag", async () => {
    const out = await statusFor(gw("2027-06-30"));
    expect(out).toContain("Mode:     gateway (scoped token)");
    expect(mockTestConnection).toHaveBeenCalledWith(GATEWAY, "user@example.com", "tok", { gateway: true });
  });

  it("site: Mode line, and the connection test uses the site URL", async () => {
    const out = await statusFor({});
    expect(out).toContain("Mode:     site");
    expect(mockTestConnection).toHaveBeenCalledWith("https://example.atlassian.net", "user@example.com", "tok");
  });

  it("a gateway record without a seal is reported, and no request is made", async () => {
    const out = await statusFor({ apiMode: "gateway" });
    expect(out).toMatch(/Status:\s+Failed - Gateway mode needs the tenant seal/);
    expect(mockTestConnection).not.toHaveBeenCalled();
  });
});
