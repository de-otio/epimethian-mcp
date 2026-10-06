/**
 * Pure policy for outbound Confluence HTTP traffic (R1).
 *
 * Everything here is free of I/O: timeouts, the retry decision, `Retry-After`
 * parsing, a counting semaphore and a chunked fan-out helper. The clock, the
 * random source and (in the client) `sleep` are passed in so tests can pin them.
 * The fetch wrapper that applies the policy lives in confluence-client.ts.
 */

// --- Timeouts -------------------------------------------------------------

/** What a request is for; it decides the timeout. */
export type HttpKind = "read" | "write" | "transfer";

export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const MIN_READ_TIMEOUT_MS = 5_000;
export const MAX_READ_TIMEOUT_MS = 300_000;

/** Write and transfer timeouts keep their ratio to the read timeout (30 s : 60 s : 120 s). */
const TIMEOUT_RATIO: Readonly<Record<HttpKind, number>> = {
  read: 1,
  write: 2,
  transfer: 4,
};

/**
 * Resolve the read timeout from `EPIMETHIAN_HTTP_TIMEOUT_MS`.
 * Unset, empty or non-numeric falls back to the default; a number outside
 * 5 s-300 s is clamped (the conservative reading of "bounded").
 */
export function resolveReadTimeoutMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_READ_TIMEOUT_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_READ_TIMEOUT_MS;
  return Math.min(MAX_READ_TIMEOUT_MS, Math.max(MIN_READ_TIMEOUT_MS, n));
}

export function httpTimeoutMs(kind: HttpKind, rawEnv: string | undefined): number {
  return resolveReadTimeoutMs(rawEnv) * TIMEOUT_RATIO[kind];
}

// --- Retry ----------------------------------------------------------------

export const MAX_ATTEMPTS = 3;
/** A `Retry-After` longer than this is not honoured; the 429/503 is surfaced instead. */
export const MAX_RETRY_AFTER_MS = 60_000;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** Only requests with no side effects are ever retried automatically. */
export function isRetryableMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

const HTTP_DATE_RES: readonly RegExp[] = [
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/, // IMF-fixdate
  /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/, // RFC 850
  /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/, // asctime
];

/**
 * Parse a `Retry-After` header: delta-seconds (digits only) or an HTTP-date.
 * Returns milliseconds from `nowMs`, or `undefined` when the value is absent
 * or unparseable. A date in the past is 0.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) {
    const seconds = Number(v);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  // Only the three HTTP-date shapes; Date.parse alone would read loose
  // strings such as "Jan 1" as a date.
  if (!HTTP_DATE_RES.some((re) => re.test(v))) return undefined;
  // asctime carries no zone, but HTTP dates are always GMT; Date.parse would
  // otherwise read it as local time.
  const at = Date.parse(v.endsWith("GMT") ? v : `${v} GMT`);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false };

/**
 * Decide whether to retry a failed response.
 *
 * Retries GET/HEAD on 429/503 only, only with a parseable `Retry-After` of at
 * most 60 s, and only while fewer than `MAX_ATTEMPTS` attempts have been made
 * (`attempt` is the 1-based count of attempts already made). The header is a
 * floor, so the jitter is added on top of it, never subtracted.
 */
export function decideRetry(input: {
  method: string;
  status: number;
  retryAfterHeader: string | null | undefined;
  attempt: number;
  nowMs: number;
  random: () => number;
}): RetryDecision {
  const { method, status, retryAfterHeader, attempt, nowMs, random } = input;
  if (!isRetryableMethod(method)) return { retry: false };
  if (!RETRYABLE_STATUSES.has(status)) return { retry: false };
  if (attempt >= MAX_ATTEMPTS) return { retry: false };
  const retryAfterMs = parseRetryAfter(retryAfterHeader, nowMs);
  if (retryAfterMs === undefined || retryAfterMs > MAX_RETRY_AFTER_MS) {
    return { retry: false };
  }
  const jitterSpan = Math.min(5_000, Math.max(250, retryAfterMs));
  return { retry: true, delayMs: retryAfterMs + Math.floor(random() * jitterSpan) };
}

// --- Concurrency ----------------------------------------------------------

export const DEFAULT_MAX_CONCURRENCY = 6;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

/** The request was never sent: no slot became free in time. */
export class ConcurrencyTimeoutError extends Error {
  constructor(limit: number, waitedMs: number) {
    super(
      `Too many concurrent Confluence requests (limit ${limit}); gave up waiting ` +
        `for a free slot after ${Math.round(waitedMs / 1000)}s. The request was not sent.`,
    );
    this.name = "ConcurrencyTimeoutError";
  }
}

interface Waiter {
  grant: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Counting semaphore with an acquire timeout. Permits are handed over in
 * FIFO order. A permit is released exactly once, however often its release
 * function is called.
 */
export class Semaphore {
  private active = 0;
  // Mutated in place: a FIFO queue is the whole point of this class.
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly limit: number = DEFAULT_MAX_CONCURRENCY,
    readonly acquireTimeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Semaphore limit must be a positive integer");
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new ConcurrencyTimeoutError(this.limit, this.acquireTimeoutMs));
        }, this.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Run `fn` while holding a permit; the permit is released in `finally`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit straight to the next waiter; `active` is unchanged.
        clearTimeout(next.timer);
        next.grant(this.makeRelease());
      } else {
        this.active--;
      }
    };
  }
}

// --- Fan-out --------------------------------------------------------------

/**
 * `Promise.allSettled` over `items`, at most `size` at a time. Results keep
 * the input order. Used so a burst (one request per comment) cannot queue
 * more work than the semaphore's acquire timeout can absorb.
 */
export async function settleInChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const chunk = Math.max(1, Math.floor(size));
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += chunk) {
    const settled = await Promise.allSettled(items.slice(i, i + chunk).map(fn));
    out.push(...settled);
  }
  return out;
}
