import { describe, expect, it } from "vitest";
import { parseConfluenceUrl } from "./url-parser.js";

const BASE = "https://example.atlassian.net";

describe("parseConfluenceUrl — happy paths", () => {
  it("parses a bare /wiki/spaces/KEY/pages/ID path", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("parses a path with a trailing slug (slug ignored)", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345/Design+Overview",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("parses a path with an anchor", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345#Heading-1",
        BASE
      )
    ).toEqual({
      contentId: "12345",
      spaceKey: "DEV",
      anchor: "Heading-1",
    });
  });

  it("parses a path with both slug and anchor", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345/Some-Slug#anchor-2",
        BASE
      )
    ).toEqual({
      contentId: "12345",
      spaceKey: "DEV",
      anchor: "anchor-2",
    });
  });

  it("decodes percent-encoded anchors", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345#Heading%20With%20Spaces",
        BASE
      )?.anchor
    ).toBe("Heading With Spaces");
  });

  it("returns anchor even when malformed percent-encoding is present", () => {
    // %ZZ is not a valid escape — we keep the anchor raw rather than fail.
    const ref = parseConfluenceUrl(
      "https://example.atlassian.net/wiki/spaces/DEV/pages/12345#bad%ZZ",
      BASE
    );
    expect(ref?.anchor).toBe("bad%ZZ");
  });

  it("tolerates a trailing slash", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345/",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("treats default port as identical to no-port", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net:443/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("normalises percent-encoded hostname characters", () => {
    // %65 == 'e'. After canonicalisation the hosts match.
    expect(
      parseConfluenceUrl(
        "https://%65xample.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("ignores userinfo prefix when comparing hosts", () => {
    expect(
      parseConfluenceUrl(
        "https://anyone@example.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("ignores case differences in the host", () => {
    expect(
      parseConfluenceUrl(
        "https://Example.Atlassian.NET/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });
});

describe("parseConfluenceUrl — spoofing / rejections", () => {
  it("rejects host suffix attack (subdomain-shaped)", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net.attacker.com/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("rejects query-string trickery that embeds the base host", () => {
    expect(
      parseConfluenceUrl(
        "https://attacker.com/wiki/spaces/DEV/pages/12345?host=example.atlassian.net",
        BASE
      )
    ).toBeNull();
  });

  it("rejects `userinfo@attacker.com` spoofing", () => {
    // Even though the username contains the base host literal, URL parser
    // resolves the true host as attacker.com.
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net@attacker.com/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("rejects non-matching port", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net:8080/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("rejects scheme mismatch (http vs https)", () => {
    expect(
      parseConfluenceUrl(
        "http://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("rejects non-http schemes", () => {
    expect(
      parseConfluenceUrl(
        "javascript://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
    expect(
      parseConfluenceUrl(
        "file://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("rejects non-matching IPv6 hosts", () => {
    expect(
      parseConfluenceUrl(
        "https://[::1]/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("accepts matching IPv6 hosts (different textual encoding)", () => {
    // URL canonicalises IPv6 bracket notation.
    const ipv6Base = "https://[2001:db8::1]/";
    expect(
      parseConfluenceUrl(
        "https://[2001:db8::1]/wiki/spaces/DEV/pages/12345",
        ipv6Base
      )
    ).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("rejects paths that are not /wiki/spaces/.../pages/...", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/display/DEV/Some+Page",
        BASE
      )
    ).toBeNull();
    expect(
      parseConfluenceUrl("https://example.atlassian.net/", BASE)
    ).toBeNull();
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/",
        BASE
      )
    ).toBeNull();
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/not-a-number",
        BASE
      )
    ).toBeNull();
  });

  it("rejects syntactically invalid URLs", () => {
    expect(parseConfluenceUrl("not a url", BASE)).toBeNull();
    expect(parseConfluenceUrl("", BASE)).toBeNull();
    expect(parseConfluenceUrl("://broken", BASE)).toBeNull();
  });

  it("rejects when the base URL itself is invalid", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        "not a url"
      )
    ).toBeNull();
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/12345",
        ""
      )
    ).toBeNull();
  });

  it("ignores fragment-only anchor when empty", () => {
    const ref = parseConfluenceUrl(
      "https://example.atlassian.net/wiki/spaces/DEV/pages/12345#",
      BASE
    );
    expect(ref).toEqual({ contentId: "12345", spaceKey: "DEV" });
  });

  it("does not use substring matching — host ending with base host is rejected", () => {
    expect(
      parseConfluenceUrl(
        "https://evilexample.atlassian.net/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });

  it("does not use startsWith matching — host starting with base host is rejected", () => {
    expect(
      parseConfluenceUrl(
        "https://example.atlassian.net.example.com/wiki/spaces/DEV/pages/12345",
        BASE
      )
    ).toBeNull();
  });
});

describe("parseConfluenceUrl — type-level defensiveness", () => {
  it("treats non-string inputs as invalid", () => {
    // Runtime callers may occasionally hand in non-string values; make
    // sure we return null rather than throw.
    // @ts-expect-error -- intentional.
    expect(parseConfluenceUrl(null, BASE)).toBeNull();
    // @ts-expect-error -- intentional.
    expect(parseConfluenceUrl(undefined, BASE)).toBeNull();
    // @ts-expect-error -- intentional.
    expect(parseConfluenceUrl(12345, BASE)).toBeNull();
  });
});
