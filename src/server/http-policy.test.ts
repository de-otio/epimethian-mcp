import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Env must be set before the client module evaluates.
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/test-connection.js", () => ({
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  verifyTenantIdentity: vi.fn().mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com", message: "Verified" }),
}));

import {
  _rawCreatePage,
  _rawUpdatePage,
  _resetHttpStateForTests,
  ConfluenceApiError,
  ConfluenceApprovalRequiredError,
  ConfluenceConflictError,
  ConfluenceTimeoutError,
  ConfluenceUnexpectedConflictError,
  PageOutcomeUnknownError,
  WriteOutcomeUnknownError,
  createFooterComment,
  deletePage,
  downloadAttachmentBytes,
  formatPage,
  getLabels,
  getPage,
  setContentState,
  uploadAttachment,
} from "./confluence-client.js";
import { ConcurrencyTimeoutError } from "./request-policy.js";
import { errorRecord } from "./mutation-log.js";
import { pageCache } from "./page-cache.js";

const BASE_URL = "https://test.atlassian.net";
const API_V2 = `${BASE_URL}/wiki/api/v2`;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function pageJson(version: number, id = "30") {
  return { id, title: "T", version: { number: version } };
}

const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

let sleeps: number[];
let timeoutSpy: ReturnType<typeof vi.spyOn>;
const timeoutArgs = (): unknown[] => timeoutSpy.mock.calls.map((call: unknown[]) => call[0]);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.EPIMETHIAN_HTTP_TIMEOUT_MS;
  pageCache.clear();
  sleeps = [];
  _resetHttpStateForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => Date.parse("2026-10-06T12:00:00Z"),
  });
  timeoutSpy = vi.spyOn(AbortSignal, "timeout");
});

afterEach(() => {
  delete process.env.EPIMETHIAN_HTTP_TIMEOUT_MS;
  _resetHttpStateForTests();
});

function setFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// =============================================================================
// Timeouts
// =============================================================================

describe("R1 timeouts", () => {
  it("gives reads 30 s, writes 60 s and attachment transfers 120 s, each as a real AbortSignal", async () => {
    const f = setFetch(() => json(pageJson(1)));
    await getPage("30", false);
    await _rawUpdatePage("30", { title: "T", version: 1 });
    expect(timeoutArgs()).toEqual([30_000, 60_000]);
    for (const [, init] of f.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }

    timeoutSpy.mockClear();
    setFetch(() => json({ results: [{ id: "a1", title: "f.txt" }] }));
    await uploadAttachment("30", Buffer.from("x"), "f.txt");
    expect(timeoutArgs()).toEqual([120_000]);

    timeoutSpy.mockClear();
    setFetch(() => new Response(new Uint8Array([1, 2, 3])));
    await downloadAttachmentBytes({ id: "a1", title: "f.txt", downloadLink: "/download/attachments/30/f.txt" });
    expect(timeoutArgs()).toEqual([120_000]);
  });

  it("scales all three with EPIMETHIAN_HTTP_TIMEOUT_MS and clamps it to 5 s - 300 s", async () => {
    process.env.EPIMETHIAN_HTTP_TIMEOUT_MS = "10000";
    setFetch(() => json(pageJson(1)));
    await getPage("30", false);
    await _rawUpdatePage("30", { title: "T", version: 1 });
    expect(timeoutArgs()).toEqual([10_000, 20_000]);

    timeoutSpy.mockClear();
    process.env.EPIMETHIAN_HTTP_TIMEOUT_MS = "1";
    await getPage("30", false);
    process.env.EPIMETHIAN_HTTP_TIMEOUT_MS = "9999999";
    await getPage("30", false);
    expect(timeoutArgs()).toEqual([5_000, 300_000]);
  });

  it("turns a read timeout into ConfluenceTimeoutError that names the path but not the query", async () => {
    setFetch(() => {
      throw timeoutError();
    });
    const err = await getPage("30", true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceTimeoutError);
    expect((err as Error).message).toContain("/wiki/api/v2/pages/30");
    expect((err as Error).message).not.toContain("body-format");
    expect((err as Error).message).toContain("Nothing was changed");
  });

  it("propagates a non-timeout read failure unchanged (it is not a write)", async () => {
    const boom = new TypeError("fetch failed");
    setFetch(() => {
      throw boom;
    });
    await expect(getPage("30", false)).rejects.toBe(boom);
  });

  it("times out a download as ConfluenceTimeoutError", async () => {
    setFetch(() => {
      throw timeoutError();
    });
    await expect(
      downloadAttachmentBytes({ id: "a1", title: "f.txt", downloadLink: "/download/attachments/30/f.txt" }),
    ).rejects.toBeInstanceOf(ConfluenceTimeoutError);
  });
});

// =============================================================================
// Retry
// =============================================================================

describe("R1 retry", () => {
  it("retries a GET 429 that carries Retry-After, sleeping at least that long, then succeeds", async () => {
    let calls = 0;
    const f = setFetch(() => (++calls === 1 ? json({}, 429, { "Retry-After": "2" }) : json(pageJson(4))));
    const page = await getPage("30", false);
    expect(page.version?.number).toBe(4);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("honours an HTTP-date Retry-After against the injected clock and retries 503", async () => {
    let calls = 0;
    const when = new Date(Date.parse("2026-10-06T12:00:09Z")).toUTCString();
    const f = setFetch(() => (++calls === 1 ? json({}, 503, { "Retry-After": when }) : json(pageJson(1))));
    await getPage("30", false);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([9_000]);
  });

  it("gives up after 3 attempts in total and surfaces the 429", async () => {
    const f = setFetch(() => json({ message: "slow down" }, 429, { "Retry-After": "1" }));
    const err = await getPage("30", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect((err as ConfluenceApiError).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry a 429 without Retry-After, or with one over 60 s", async () => {
    const f = setFetch(() => json({}, 429));
    await expect(getPage("30", false)).rejects.toBeInstanceOf(ConfluenceApiError);
    expect(f).toHaveBeenCalledTimes(1);

    const g = setFetch(() => json({}, 429, { "Retry-After": "61" }));
    await expect(getPage("30", false)).rejects.toBeInstanceOf(ConfluenceApiError);
    expect(g).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("does not crash on a fake response with no headers object", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("slow"),
    }) as unknown as typeof fetch;
    await expect(getPage("30", false)).rejects.toBeInstanceOf(ConfluenceApiError);
  });

  it("never retries a PUT, POST or DELETE, even with a valid Retry-After", async () => {
    const f = setFetch(() => json({}, 429, { "Retry-After": "1" }));
    await expect(_rawUpdatePage("30", { title: "T", version: 1 })).rejects.toBeInstanceOf(ConfluenceApiError);
    await expect(createFooterComment("30", "hi")).rejects.toBeInstanceOf(ConfluenceApiError);
    await expect(deletePage("30")).rejects.toBeInstanceOf(ConfluenceApiError);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([]);
  });

  it("keeps setContentState's own 409 retry (the documented exemption)", async () => {
    let calls = 0;
    const f = setFetch(() => (++calls < 3 ? json({}, 409) : json({})));
    await setContentState("30", "AI-edited", "#FFC400");
    expect(f).toHaveBeenCalledTimes(3);
  });
});

// =============================================================================
// Concurrency
// =============================================================================

describe("R1 concurrency cap", () => {
  it("keeps the permit through the body read, so at most N requests are in flight", async () => {
    _resetHttpStateForTests({ maxConcurrency: 2 });
    let active = 0;
    let peak = 0;
    setFetch(() => {
      active++;
      peak = Math.max(peak, active);
      return {
        ok: true,
        status: 200,
        // The body read is slow: a permit that covered only fetch() would let all six overlap here.
        json: async () => {
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return { results: [] };
        },
      } as unknown as Response;
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => getLabels(String(i))));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("releases the permit when the response body is never read (DELETE)", async () => {
    _resetHttpStateForTests({ maxConcurrency: 1, acquireTimeoutMs: 100 });
    setFetch(() => new Response(null, { status: 204 }));
    await Promise.all([deletePage("1"), deletePage("2"), deletePage("3")]);
  });

  it("releases the permit when a request fails", async () => {
    _resetHttpStateForTests({ maxConcurrency: 1, acquireTimeoutMs: 100 });
    setFetch(() => json({}, 500));
    for (let i = 0; i < 3; i++) {
      await expect(getPage("30", false)).rejects.toBeInstanceOf(ConfluenceApiError);
    }
  });

  it("does not hold the permit while sleeping for Retry-After", async () => {
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let sleepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    _resetHttpStateForTests({
      maxConcurrency: 1,
      acquireTimeoutMs: 200,
      sleep: async () => {
        sleepStarted();
        await sleeping;
      },
    });
    let first = true;
    setFetch((url) => {
      if (url.includes("/content/1/")) {
        if (first) {
          first = false;
          return json({}, 429, { "Retry-After": "1" });
        }
        return json({ results: [] });
      }
      return json({ results: [] });
    });

    const p1 = getLabels("1");
    await started;
    // The only permit must be free now, so an unrelated request completes.
    await expect(getLabels("2")).resolves.toEqual([]);
    releaseSleep();
    await expect(p1).resolves.toEqual([]);
  });

  it("fails fast with ConcurrencyTimeoutError, and never sends the request, when no slot frees up", async () => {
    _resetHttpStateForTests({ maxConcurrency: 1, acquireTimeoutMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = setFetch(async () => {
      await gate;
      return json({ results: [] });
    });
    const held = getLabels("1");
    await expect(getLabels("2")).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    expect(f).toHaveBeenCalledTimes(1);
    release();
    await held;
  });

  it("applies the cap to uploads and downloads too", async () => {
    _resetHttpStateForTests({ maxConcurrency: 1, acquireTimeoutMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setFetch(async () => {
      await gate;
      return json({ results: [{ id: "a", title: "f" }] });
    });
    const held = uploadAttachment("30", Buffer.from("x"), "f.txt");
    await expect(
      downloadAttachmentBytes({ id: "a1", title: "f.txt", downloadLink: "/download/attachments/30/f.txt" }),
    ).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    release();
    await held;
  });
});

// =============================================================================
// Outcome unknown (M6)
// =============================================================================

describe("R1 outcome-unknown writes", () => {
  it("a network error after a PUT throws WriteOutcomeUnknownError, is never retried, and evicts the cache", async () => {
    pageCache.set("30", 5, "<p>cached</p>");
    const f = setFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await _rawUpdatePage("30", { title: "T", version: 5, body: "<p>x</p>" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect((err as Error).message).toContain("may have been applied");
    expect((err as Error).message).toContain("/wiki/api/v2/pages/30");
    expect(f).toHaveBeenCalledTimes(1);
    expect(pageCache.has("30")).toBeUndefined();
    expect(pageCache.getOutcomeUnknown("30")).toEqual({ attemptedVersion: 5 });
  });

  it("a timeout after a PUT is outcome-unknown, not a plain timeout", async () => {
    setFetch(() => {
      throw timeoutError();
    });
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err).not.toBeInstanceOf(ConfluenceTimeoutError);
    expect((err as Error).message).toContain("timed out");
  });

  it("a 2xx whose body cannot be read, or is not a page, is outcome-unknown too", async () => {
    setFetch(() => new Response("<html>not json</html>", { status: 200 }));
    await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(pageCache.getOutcomeUnknown("30")).toBeDefined();

    pageCache.clear();
    setFetch(() => json({ unexpected: "shape" }));
    await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(pageCache.getOutcomeUnknown("30")).toEqual({ attemptedVersion: 5 });

    pageCache.clear();
    setFetch(() => json({ unexpected: "shape" }));
    await expect(_rawCreatePage("1", "T", "<p>x</p>")).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it("a gateway 502/504 on a write is outcome-unknown; a 500 is a definite failure", async () => {
    for (const status of [502, 504]) {
      pageCache.clear();
      setFetch(() => json({}, status));
      await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    }
    pageCache.clear();
    setFetch(() => json({}, 500));
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(pageCache.getOutcomeUnknown("30")).toBeUndefined();
  });

  it("a 502 on a GET is an ordinary API error", async () => {
    setFetch(() => json({}, 502));
    const err = await getPage("30", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApiError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it("a failed create reports outcome-unknown without marking any page", async () => {
    setFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(_rawCreatePage("1", "T", "<p>x</p>")).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it("a failed delete reports outcome-unknown and evicts the cached body", async () => {
    pageCache.set("30", 5, "<p>cached</p>");
    setFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(deletePage("30")).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(pageCache.has("30")).toBeUndefined();
  });

  it("a failed upload reports outcome-unknown", async () => {
    setFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(uploadAttachment("30", Buffer.from("x"), "f.txt")).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it("the mutation log record carries outcome: unknown, and only for these errors", () => {
    const unknown = new WriteOutcomeUnknownError("PUT", `${API_V2}/pages/30`, new TypeError("x"), "request");
    expect(errorRecord("update_page", "30", unknown).outcome).toBe("unknown");
    expect(errorRecord("update_page", "30", new Error("plain")).outcome).toBeUndefined();
    expect(errorRecord("update_page", "30", new ConfluenceApiError(500, "x")).outcome).toBeUndefined();
  });

  describe("refusing a retry that would double-apply", () => {
    beforeEach(async () => {
      setFetch(() => {
        throw new TypeError("fetch failed");
      });
      await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    });

    it("refuses a write based on a newer version, without sending anything", async () => {
      const f = setFetch(() => json(pageJson(7)));
      // "current" resolves to whatever the page shows now: 6 if the earlier write landed.
      const err = await _rawUpdatePage("30", { title: "T", version: 6 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PageOutcomeUnknownError);
      expect((err as Error).message).toContain("get_page");
      expect(f).not.toHaveBeenCalled();
    });

    it("still allows a write based on the same version: the version check protects it", async () => {
      const f = setFetch(() => json(pageJson(6)));
      await _rawUpdatePage("30", { title: "T", version: 5 });
      expect(f).toHaveBeenCalledTimes(1);
      expect(pageCache.getOutcomeUnknown("30")).toBeUndefined();
    });

    it("an explicit-version write that hits the landed write gets a normal 409, not a silent double apply", async () => {
      setFetch((_url, init) => (init?.method === "PUT" ? json({ message: "Conflict" }, 409) : json(pageJson(6))));
      const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfluenceConflictError);
    });

    it("is settled when getPage observes the version the lost write was based on", async () => {
      setFetch(() => json(pageJson(5)));
      await getPage("30", false);
      expect(pageCache.getOutcomeUnknown("30")).toBeUndefined();
    });

    it("stays marked when getPage observes a newer version (the write may have landed)", async () => {
      setFetch(() => json(pageJson(6)));
      await getPage("30", false);
      expect(pageCache.getOutcomeUnknown("30")).toEqual({ attemptedVersion: 5 });
    });

    it("is settled when the agent is shown the page with its body (get_page)", async () => {
      const page = { id: "30", title: "T", version: { number: 6 }, body: { storage: { value: "<p>x</p>" } } };
      setFetch(() => json(page));
      const fetched = await getPage("30", true);
      // getPage alone is an internal read and must not settle the mark...
      expect(pageCache.getOutcomeUnknown("30")).toBeDefined();
      // ...rendering it for the agent does.
      await formatPage(fetched, { includeBody: true });
      expect(pageCache.getOutcomeUnknown("30")).toBeUndefined();
    });

    it("rendering a page without a body does not settle the mark", async () => {
      await formatPage({ id: "30", title: "T", version: { number: 6 } }, { includeBody: false });
      expect(pageCache.getOutcomeUnknown("30")).toBeDefined();
    });

    it("only marks the page that failed", async () => {
      const f = setFetch(() => json(pageJson(9, "31")));
      await _rawUpdatePage("31", { title: "T", version: 8 });
      expect(f).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// S7: approval-required spaces answer a page PUT with 409
// =============================================================================

describe("S7 409 classification", () => {
  function conflictThenRead(putBody: unknown, readVersion: number | "fail") {
    return setFetch((_url, init) => {
      if (init?.method === "PUT") return json(putBody, 409);
      if (readVersion === "fail") return json({}, 500);
      return json(pageJson(readVersion));
    });
  }

  it("page still at the sent version, body mentions approval: ConfluenceApprovalRequiredError, no retry hint", async () => {
    conflictThenRead({ errors: [{ title: "Content requires approval before it can be published" }] }, 5);
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceApprovalRequiredError);
    expect(err).not.toBeInstanceOf(ConfluenceConflictError);
    const message = (err as Error).message;
    expect(message).toContain("appears to require approval");
    expect(message).toContain("retrying will not help");
    expect(message).not.toMatch(/retry your update with version/i);
    expect(message).not.toContain("version 6");
  });

  it("page still at the sent version, body says nothing about approval: generic non-retryable conflict", async () => {
    conflictThenRead({ message: "Conflict" }, 5);
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceUnexpectedConflictError);
    expect(err).not.toBeInstanceOf(ConfluenceApprovalRequiredError);
    expect(err).not.toBeInstanceOf(ConfluenceConflictError);
    expect((err as Error).message).toContain("still at version 5");
    expect((err as Error).message).not.toMatch(/retry your update with version/i);
  });

  it("a body-parsed version equal to the sent one is confirmed by a re-read before it is trusted", async () => {
    // The body says "current version is 5", the page is really at 8: a stale conflict.
    conflictThenRead({ message: "The current version is 5" }, 8);
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceConflictError);
    expect((err as ConfluenceConflictError).currentVersion).toBe(8);
  });

  it("a genuinely stale conflict stays a ConfluenceConflictError even if the body mentions publishing", async () => {
    conflictThenRead({ message: "Cannot publish: page was modified" }, 7);
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceConflictError);
    expect((err as ConfluenceConflictError).currentVersion).toBe(7);
    expect((err as Error).message).toContain("version 7");
  });

  it("when the re-read fails and the body has no version, it is still a stale-style conflict", async () => {
    conflictThenRead({ message: "Conflict" }, "fail");
    const err = await _rawUpdatePage("30", { title: "T", version: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceConflictError);
    expect((err as ConfluenceConflictError).currentVersion).toBeUndefined();
  });

  it("does not retry the PUT", async () => {
    const f = conflictThenRead({ message: "approval" }, 5);
    await _rawUpdatePage("30", { title: "T", version: 5 }).catch(() => {});
    expect(f.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
});
