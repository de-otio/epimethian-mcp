import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_READ_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  ConcurrencyTimeoutError,
  Semaphore,
  decideRetry,
  httpTimeoutMs,
  isRetryableMethod,
  parseRetryAfter,
  resolveReadTimeoutMs,
  settleInChunks,
} from "./request-policy.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const FC = { seed: 20261006, numRuns: 200 };

afterEach(() => {
  vi.useRealTimers();
});

describe("httpTimeoutMs", () => {
  it("defaults to 30 s reads, 60 s writes, 120 s transfers", () => {
    expect(httpTimeoutMs("read", undefined)).toBe(30_000);
    expect(httpTimeoutMs("write", undefined)).toBe(60_000);
    expect(httpTimeoutMs("transfer", undefined)).toBe(120_000);
  });

  it("scales all three with EPIMETHIAN_HTTP_TIMEOUT_MS, keeping the ratio", () => {
    expect(httpTimeoutMs("read", "10000")).toBe(10_000);
    expect(httpTimeoutMs("write", "10000")).toBe(20_000);
    expect(httpTimeoutMs("transfer", "10000")).toBe(40_000);
  });

  it("clamps the env value to 5 s - 300 s", () => {
    expect(resolveReadTimeoutMs("1")).toBe(5_000);
    expect(resolveReadTimeoutMs("4999")).toBe(5_000);
    expect(resolveReadTimeoutMs("5000")).toBe(5_000);
    expect(resolveReadTimeoutMs("300000")).toBe(300_000);
    expect(resolveReadTimeoutMs("300001")).toBe(300_000);
    expect(resolveReadTimeoutMs("99999999999")).toBe(300_000);
  });

  it("falls back to the default for unset, empty or non-numeric values", () => {
    for (const bad of [undefined, "", "  ", "abc", "-5", "1.5", "1e4", "30s", "NaN"]) {
      expect(resolveReadTimeoutMs(bad)).toBe(DEFAULT_READ_TIMEOUT_MS);
    }
  });

  it("property: the read timeout is always within bounds", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const ms = resolveReadTimeoutMs(raw);
        return ms >= 5_000 && ms <= 300_000;
      }),
      FC,
    );
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("7", NOW)).toBe(7_000);
    expect(parseRetryAfter(" 60 ", NOW)).toBe(60_000);
  });

  it("parses an HTTP-date relative to the injected clock", () => {
    const at = new Date(NOW + 12_000).toUTCString();
    expect(parseRetryAfter(at, NOW)).toBe(12_000);
  });

  it("parses the obsolete RFC 850 and asctime date forms as GMT", () => {
    // NOW is Tue 2026-10-06 12:00:00 GMT; both strings are 30 s later.
    expect(parseRetryAfter("Tuesday, 06-Oct-26 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfter("Tue Oct  6 12:00:30 2026", NOW)).toBe(30_000);
  });

  it("treats a date in the past as zero", () => {
    expect(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
  });

  it("rejects absent, negative, fractional and garbage values", () => {
    for (const bad of [undefined, null, "", "  ", "-1", "1.5", "soon", "12 seconds", "Jan 1", "99999999999999999999"]) {
      expect(parseRetryAfter(bad, NOW)).toBeUndefined();
    }
  });
});

describe("decideRetry", () => {
  const base = {
    method: "GET",
    status: 429,
    retryAfterHeader: "2",
    attempt: 1,
    nowMs: NOW,
    random: () => 0,
  };

  it("retries a GET 429 with a Retry-After, waiting at least that long", () => {
    const d = decideRetry(base);
    expect(d).toEqual({ retry: true, delayMs: 2_000 });
  });

  it("adds jitter on top of Retry-After, never below it", () => {
    const d = decideRetry({ ...base, random: () => 0.999 });
    expect(d.retry).toBe(true);
    if (d.retry) {
      expect(d.delayMs).toBeGreaterThanOrEqual(2_000);
      expect(d.delayMs).toBeLessThan(2_000 + 5_000);
    }
  });

  it("retries HEAD and 503", () => {
    expect(decideRetry({ ...base, method: "head" }).retry).toBe(true);
    expect(decideRetry({ ...base, status: 503 }).retry).toBe(true);
  });

  it("never retries PUT, POST, DELETE or PATCH", () => {
    for (const method of ["PUT", "POST", "DELETE", "PATCH", "put"]) {
      expect(decideRetry({ ...base, method }).retry).toBe(false);
      expect(isRetryableMethod(method)).toBe(false);
    }
  });

  it("does not retry other statuses", () => {
    for (const status of [400, 401, 403, 404, 409, 500, 502, 504]) {
      expect(decideRetry({ ...base, status }).retry).toBe(false);
    }
  });

  it("does not retry without a parseable Retry-After", () => {
    expect(decideRetry({ ...base, retryAfterHeader: undefined }).retry).toBe(false);
    expect(decideRetry({ ...base, retryAfterHeader: "later" }).retry).toBe(false);
  });

  it("does not retry when Retry-After exceeds 60 s, but does at exactly 60 s", () => {
    expect(decideRetry({ ...base, retryAfterHeader: "61" }).retry).toBe(false);
    expect(decideRetry({ ...base, retryAfterHeader: "60" }).retry).toBe(true);
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
  });

  it("allows at most 3 attempts in total", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(decideRetry({ ...base, attempt: 1 }).retry).toBe(true);
    expect(decideRetry({ ...base, attempt: 2 }).retry).toBe(true);
    expect(decideRetry({ ...base, attempt: 3 }).retry).toBe(false);
  });

  it("property: a write method is never retried, whatever the response", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("PUT", "POST", "DELETE", "PATCH"),
        fc.integer({ min: 100, max: 599 }),
        fc.option(fc.string(), { nil: undefined }),
        fc.integer({ min: 1, max: 5 }),
        (method, status, header, attempt) =>
          !decideRetry({ method, status, retryAfterHeader: header, attempt, nowMs: NOW, random: () => 0.5 }).retry,
      ),
      FC,
    );
  });

  it("property: any retry delay is >= Retry-After and the Retry-After is <= 60 s", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.double({ min: 0, max: 0.9999999 }), (secs, r) => {
        const d = decideRetry({ ...base, retryAfterHeader: String(secs), random: () => r });
        if (!d.retry) return secs * 1000 > MAX_RETRY_AFTER_MS;
        return secs * 1000 <= MAX_RETRY_AFTER_MS && d.delayMs >= secs * 1000;
      }),
      FC,
    );
  });
});

describe("Semaphore", () => {
  it("rejects a non-positive or fractional limit", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  it("never lets more than `limit` holders run at once and runs everything", async () => {
    const sem = new Semaphore(3, 60_000);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sem.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 1));
          running--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(sem.inFlight).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("releases the permit when the work throws", async () => {
    const sem = new Semaphore(1, 60_000);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(sem.inFlight).toBe(0);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("release is idempotent: calling it twice frees one slot, not two", async () => {
    const sem = new Semaphore(1, 60_000);
    const release = await sem.acquire();
    release();
    release();
    const second = await sem.acquire();
    // A double release must not have opened a second slot.
    let thirdGranted = false;
    void sem.acquire().then(() => { thirdGranted = true; });
    await Promise.resolve();
    expect(thirdGranted).toBe(false);
    expect(sem.inFlight).toBe(1);
    second();
  });

  it("hands permits to waiters in FIFO order", async () => {
    const sem = new Semaphore(1, 60_000);
    const first = await sem.acquire();
    const order: number[] = [];
    const a = sem.acquire().then((rel) => { order.push(1); rel(); });
    const b = sem.acquire().then((rel) => { order.push(2); rel(); });
    first();
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });

  it("rejects with ConcurrencyTimeoutError after the acquire timeout and leaves the queue clean", async () => {
    vi.useFakeTimers();
    const sem = new Semaphore(1, 30_000);
    const held = await sem.acquire();
    const waiting = sem.acquire();
    const assertion = expect(waiting).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(sem.queued).toBe(0);
    held();
    // The timed-out waiter must not swallow the next permit.
    await expect(sem.acquire()).resolves.toBeTypeOf("function");
  });

  it("does not time out a waiter that is granted before the deadline", async () => {
    vi.useFakeTimers();
    const sem = new Semaphore(1, 30_000);
    const held = await sem.acquire();
    const waiting = sem.acquire();
    await vi.advanceTimersByTimeAsync(10_000);
    held();
    const release = await waiting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sem.inFlight).toBe(1);
    release();
    expect(sem.inFlight).toBe(0);
  });
});

describe("settleInChunks", () => {
  it("never runs more than `size` calls at once and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await settleInChunks(Array.from({ length: 25 }, (_, i) => i), 6, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (n === 7) throw new Error("seven");
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(6);
    expect(out).toHaveLength(25);
    expect(out[3]).toEqual({ status: "fulfilled", value: 6 });
    expect(out[7]!.status).toBe("rejected");
    expect(out[24]).toEqual({ status: "fulfilled", value: 48 });
  });

  it("handles an empty list and a non-positive size", async () => {
    expect(await settleInChunks([], 6, async () => 1)).toEqual([]);
    const out = await settleInChunks([1, 2], 0, async (n) => n);
    expect(out.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
