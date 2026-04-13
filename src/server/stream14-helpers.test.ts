/**
 * Stream 14 — Tests for searchUsers and searchPagesByTitle (confluence-client.ts)
 * and registration of lookup_user / resolve_page_link tools (index.ts).
 *
 * All HTTP is mocked via vi.spyOn(global, "fetch").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Set env vars BEFORE module evaluation
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

// Mock keychain
vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// Mock test-connection
vi.mock("../shared/test-connection.js", () => ({
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  verifyTenantIdentity: vi
    .fn()
    .mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com" }),
}));

import { searchUsers, searchPagesByTitle } from "./confluence-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://test.atlassian.net";
const API_V1 = `${BASE_URL}/wiki/rest/api`;

function mockFetchOk(body: unknown) {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function mockFetchError(status: number, body = "Server Error") {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ message: body }),
    text: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// searchUsers
// ─────────────────────────────────────────────────────────────────────────────

describe("searchUsers", () => {
  it("happy path — returns up to 10 users parsed from response", async () => {
    mockFetchOk({
      results: [
        {
          user: {
            accountId: "557058:aaa-111",
            displayName: "Alice Smith",
            email: "alice@example.com",
          },
        },
        {
          user: {
            accountId: "557058:bbb-222",
            displayName: "Bob Jones",
            email: "bob@example.com",
          },
        },
        {
          user: {
            accountId: "557058:ccc-333",
            displayName: "Carol White",
            email: "carol@example.com",
          },
        },
      ],
    });

    const users = await searchUsers("alice");

    expect(users).toHaveLength(3);
    expect(users[0]).toEqual({
      accountId: "557058:aaa-111",
      displayName: "Alice Smith",
      email: "alice@example.com",
    });
    expect(users[1].displayName).toBe("Bob Jones");
    expect(users[2].email).toBe("carol@example.com");
  });

  it("empty result — returns empty array", async () => {
    mockFetchOk({ results: [] });

    const users = await searchUsers("nobody");
    expect(users).toHaveLength(0);
  });

  it("API error — throws ConfluenceApiError", async () => {
    mockFetchError(500, "Internal Server Error");

    await expect(searchUsers("error")).rejects.toThrow(/Confluence API error/);
  });

  it("includes correct CQL in the request URL", async () => {
    const spy = mockFetchOk({ results: [] });

    await searchUsers("John Doe");

    const calledUrl: string = (spy.mock.calls[0] as unknown[])[0] as string;
    // URLSearchParams encodes spaces as '+', so decode both variants
    const decoded = decodeURIComponent(calledUrl.replace(/\+/g, " "));
    expect(decoded).toContain(`${API_V1}/search/user`);
    expect(decoded).toContain(`user.fullname~"John Doe"`);
  });

  it("caps limit at 10 even when a larger value is passed", async () => {
    const spy = mockFetchOk({ results: [] });

    await searchUsers("test", 99);

    const calledUrl: string = (spy.mock.calls[0] as unknown[])[0] as string;
    expect(decodeURIComponent(calledUrl)).toContain("limit=10");
  });

  it("defaults missing email to empty string", async () => {
    mockFetchOk({
      results: [
        {
          user: {
            accountId: "557058:no-email",
            displayName: "No Email User",
            // email field omitted
          },
        },
      ],
    });

    const users = await searchUsers("no-email");
    expect(users[0].email).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchPagesByTitle
// ─────────────────────────────────────────────────────────────────────────────

describe("searchPagesByTitle", () => {
  it("happy path — returns matching page details", async () => {
    mockFetchOk({
      results: [
        {
          content: {
            id: "123456",
            title: "My Design Doc",
            space: { key: "ENG" },
            _links: {
              base: "https://test.atlassian.net/wiki",
              webui: "/spaces/ENG/pages/123456/My+Design+Doc",
            },
          },
        },
      ],
    });

    const pages = await searchPagesByTitle("My Design Doc", "ENG");

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({
      contentId: "123456",
      url: "https://test.atlassian.net/wiki/spaces/ENG/pages/123456/My+Design+Doc",
      spaceKey: "ENG",
      title: "My Design Doc",
    });
  });

  it("page not found — returns empty array", async () => {
    mockFetchOk({ results: [] });

    const pages = await searchPagesByTitle("Ghost Page", "ENG");
    expect(pages).toHaveLength(0);
  });

  it("ambiguous — returns all matches (caller decides policy)", async () => {
    mockFetchOk({
      results: [
        {
          content: {
            id: "100",
            title: "Home",
            space: { key: "ENG" },
            _links: {
              base: "https://test.atlassian.net/wiki",
              webui: "/spaces/ENG/pages/100",
            },
          },
        },
        {
          content: {
            id: "200",
            title: "Home",
            space: { key: "ENG" },
            _links: {
              base: "https://test.atlassian.net/wiki",
              webui: "/spaces/ENG/pages/200",
            },
          },
        },
      ],
    });

    const pages = await searchPagesByTitle("Home", "ENG");

    // Both matches are returned — the tool layer is responsible for picking the first
    expect(pages).toHaveLength(2);
    expect(pages[0].contentId).toBe("100");
    expect(pages[1].contentId).toBe("200");
  });

  it("API error — throws ConfluenceApiError", async () => {
    mockFetchError(403, "Forbidden");

    await expect(searchPagesByTitle("Restricted Page", "ENG")).rejects.toThrow(
      /Confluence API error/
    );
  });

  it("uses correct CQL including title and space key", async () => {
    const spy = mockFetchOk({ results: [] });

    await searchPagesByTitle("My Page", "PLATFORM");

    const calledUrl: string = (spy.mock.calls[0] as unknown[])[0] as string;
    // URLSearchParams encodes spaces as '+', so decode both variants
    const decoded = decodeURIComponent(calledUrl.replace(/\+/g, " "));
    expect(decoded).toContain(`title="My Page"`);
    expect(decoded).toContain(`space.key="PLATFORM"`);
    expect(decoded).toContain("type=page");
  });

  it("skips entries without id or title", async () => {
    mockFetchOk({
      results: [
        // Malformed entry with no content.id
        { content: { title: "No ID Page", space: { key: "ENG" }, _links: {} } },
        // Valid entry
        {
          content: {
            id: "999",
            title: "Valid Page",
            space: { key: "ENG" },
            _links: {
              base: "https://test.atlassian.net/wiki",
              webui: "/spaces/ENG/pages/999",
            },
          },
        },
      ],
    });

    const pages = await searchPagesByTitle("Valid Page", "ENG");
    expect(pages).toHaveLength(1);
    expect(pages[0].contentId).toBe("999");
  });
});
