import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildApiBases,
  FeatureUnavailableInGatewayMode,
  requestBaseFor,
  requireV1,
} from "./api-base.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

describe("buildApiBases — site mode is byte-identical to the pre-7.6 derivation", () => {
  it("derives v1 and v2 from the site URL", () => {
    expect(buildApiBases({ url: "https://example.atlassian.net", apiMode: "site" })).toEqual({
      apiMode: "site",
      apiV2: "https://example.atlassian.net/wiki/api/v2",
      apiV1: "https://example.atlassian.net/wiki/rest/api",
    });
  });

  it("property: for any site URL, bases equal `${url}/wiki/api/v2` and `${url}/wiki/rest/api`", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: false, withFragments: false }), (raw) => {
        const url = raw.replace(/\/$/, "");
        const b = buildApiBases({ url, apiMode: "site" });
        return b.apiV2 === `${url}/wiki/api/v2` && b.apiV1 === `${url}/wiki/rest/api`;
      }),
      { seed: 760, numRuns: 200 },
    );
  });

  it("absent apiMode is site mode", () => {
    expect(requestBaseFor({ url: "https://example.atlassian.net" })).toBe(
      "https://example.atlassian.net",
    );
  });
});

describe("buildApiBases — gateway mode (not switched on in 7.6.0 yet)", () => {
  it("pins origin + prefix to the sealed cloudId and has no v1 base", () => {
    expect(
      buildApiBases({ url: "https://example.atlassian.net", apiMode: "gateway", sealedCloudId: CLOUD_ID }),
    ).toEqual({
      apiMode: "gateway",
      apiV2: `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2`,
      apiV1: null,
    });
  });

  it.each([undefined, "", "../other", `${CLOUD_ID}/x`, "not-a-uuid"])(
    "refuses a missing or malformed cloudId (%s)",
    (sealedCloudId) => {
      expect(() =>
        requestBaseFor({ url: "https://example.atlassian.net", apiMode: "gateway", sealedCloudId }),
      ).toThrow(/tenant seal/);
    },
  );
});

describe("requireV1", () => {
  it("returns the v1 base in site mode", () => {
    expect(requireV1({ apiV1: "https://example.atlassian.net/wiki/rest/api" }, "labels.write")).toBe(
      "https://example.atlassian.net/wiki/rest/api",
    );
  });

  it("throws a typed error carrying the feature when there is no v1 base", () => {
    let caught: unknown;
    try {
      requireV1({ apiV1: null }, "contentState");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FeatureUnavailableInGatewayMode);
    expect((caught as FeatureUnavailableInGatewayMode).feature).toBe("contentState");
    expect((caught as Error).message).toContain('"contentState"');
    expect((caught as Error).message).toContain("gateway mode");
  });
});
