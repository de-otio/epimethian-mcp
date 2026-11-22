/**
 * Gateway-mode fields in the keychain record (doc/design/gateway-mode.md §2).
 *
 * The trap these tests close: the opportunistic tenant seal re-saves
 * `{ ...stored, cloudId }`, where `stored` is what `readFromKeychain` parsed.
 * A field the parser does not copy is silently erased by that re-save.
 *
 * The OS keychain is replaced by an in-memory store behind a mocked
 * `child_process`; no real entry is ever read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { execFile } from "node:child_process";
import {
  buildKeychainRecord,
  parseKeychainRecord,
  readFromKeychain,
  saveToKeychain,
  type KeychainCredentials,
} from "./keychain.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

/** In-memory `security` CLI: add-generic-password stores `-w`, find-generic-password returns it. */
const store = new Map<string, string>();

function installFakeSecurity(): void {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], _o: unknown, cb: unknown) => {
    const done = cb as (e: Error | null, out: string, err: string) => void;
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === "add-generic-password") store.set(arg("-a"), arg("-w"));
    if (args[0] === "delete-generic-password") store.delete(arg("-a"));
    if (args[0] === "find-generic-password") {
      const v = store.get(arg("-a"));
      if (v === undefined) return done(new Error("not found"), "", "not found");
      return done(null, v + "\n", "");
    }
    done(null, "", "");
    return {} as ReturnType<typeof execFile>;
  }) as never);
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  installFakeSecurity();
});

const base = { url: "https://example.atlassian.net", email: "user@example.com", apiToken: "tok" };

describe("buildKeychainRecord", () => {
  it("refuses gateway mode without a cloudId", () => {
    expect(() => buildKeychainRecord({ ...base, apiMode: "gateway" })).toThrow(/tenant seal/);
    expect(() => buildKeychainRecord({ ...base, apiMode: "gateway", cloudId: "" })).toThrow(/tenant seal/);
  });

  it("writes mode and expiry together with the cloudId", () => {
    expect(
      buildKeychainRecord({ ...base, apiMode: "gateway", cloudId: CLOUD_ID, tokenExpiry: "2027-01-31" }),
    ).toEqual({ ...base, cloudId: CLOUD_ID, apiMode: "gateway", tokenExpiry: "2027-01-31" });
  });

  it("never writes apiMode 'site' or empty optionals: a site record is exactly the pre-7.6 shape", () => {
    expect(buildKeychainRecord(base)).toEqual(base);
    expect(Object.keys(buildKeychainRecord({ ...base, cloudId: CLOUD_ID }))).toEqual([
      "url",
      "email",
      "apiToken",
      "cloudId",
    ]);
  });

  it("refuses an invalid expiry", () => {
    expect(() => buildKeychainRecord({ ...base, tokenExpiry: "2027-02-30" })).toThrow(/expiry/);
  });

  it("saveToKeychain refuses gateway mode without a seal even if the builder was bypassed", async () => {
    await expect(saveToKeychain({ ...base, apiMode: "gateway" }, "p")).rejects.toThrow(/tenant seal/);
    expect(store.size).toBe(0);
  });
});

describe("parseKeychainRecord", () => {
  it("keeps apiMode only when exactly 'gateway'", () => {
    expect(parseKeychainRecord({ ...base, apiMode: "gateway" })?.apiMode).toBe("gateway");
    for (const bad of ["site", "Gateway", true, 1, null, {}]) {
      expect(parseKeychainRecord({ ...base, apiMode: bad })).toEqual(base);
    }
  });

  it("keeps tokenExpiry only as a real YYYY-MM-DD date", () => {
    expect(parseKeychainRecord({ ...base, tokenExpiry: "2027-01-31" })?.tokenExpiry).toBe("2027-01-31");
    for (const bad of ["2027-1-31", "2027-02-30", "tomorrow", 20270131, null]) {
      expect(parseKeychainRecord({ ...base, tokenExpiry: bad })).toEqual(base);
    }
  });
});

describe("the seal re-save does not erase gateway fields", () => {
  it("read -> {...stored, cloudId} -> save keeps apiMode and tokenExpiry", async () => {
    // A record as a hand-edit or a future setup could leave it: mode and expiry, seal added later.
    store.set(
      "confluence-credentials/p",
      JSON.stringify({ ...base, apiMode: "gateway", tokenExpiry: "2027-01-31" }),
    );
    const stored = await readFromKeychain("p");
    expect(stored).toMatchObject({ apiMode: "gateway", tokenExpiry: "2027-01-31" });

    // Exactly what verifyOrSealTenant writes (confluence-client.ts).
    await saveToKeychain({ ...stored!, cloudId: CLOUD_ID, tenantDisplayName: "Example" }, "p");

    const raw = JSON.parse(store.get("confluence-credentials/p")!);
    expect(raw).toMatchObject({
      apiMode: "gateway",
      tokenExpiry: "2027-01-31",
      cloudId: CLOUD_ID,
      tenantDisplayName: "Example",
    });
  });
});

describe("keychain round-trip (property)", () => {
  const dateArb = fc
    .date({ min: new Date("2024-01-01"), max: new Date("2040-12-31"), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10));
  const recordArb = fc.record({
    url: fc.constantFrom("https://a.atlassian.net", "https://b.atlassian.net"),
    email: fc.emailAddress(),
    apiToken: fc.string({ minLength: 1, maxLength: 40 }),
    cloudId: fc.option(fc.uuid(), { nil: undefined }),
    tenantDisplayName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    gateway: fc.boolean(),
    tokenExpiry: fc.option(dateArb, { nil: undefined }),
  });

  it("build -> save -> read returns the same record, and gateway never survives without a seal", async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, async (r) => {
        const { gateway, ...rest } = r;
        const input = { ...rest, ...(gateway ? { apiMode: "gateway" as const } : {}) };
        if (gateway && !r.cloudId) {
          expect(() => buildKeychainRecord(input)).toThrow();
          return;
        }
        const built: KeychainCredentials = buildKeychainRecord(input);
        await saveToKeychain(built, "prop");
        const back = await readFromKeychain("prop");
        expect(back).toEqual(built);
        // And through the seal re-save path: nothing the record held is lost.
        await saveToKeychain({ ...back!, cloudId: r.cloudId ?? CLOUD_ID }, "prop");
        const again = await readFromKeychain("prop");
        expect(again?.apiMode).toBe(built.apiMode);
        expect(again?.tokenExpiry).toBe(built.tokenExpiry);
      }),
      { seed: 760, numRuns: 150 },
    );
  });
});
