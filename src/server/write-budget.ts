/**
 * Track F4: in-process session write budget.
 *
 * Per-session sliding-window counter that bounds the number of mutating
 * operations an agent can perform. Complements the elicitation gate
 * (Track E4): budget is a hard numeric cap; elicitation is an
 * interactive prompt. An agent that mass-creates pages still hits the
 * ceiling even if the user has blanket-approved every elicitation.
 *
 * Two windows enforced:
 *   - Session total: absolute cap since process start. Prevents a long-
 *     running session from amortising a burst by pausing.
 *   - Hourly window: sliding 60-minute cap. Tighter limit that catches
 *     bursts.
 *
 * Defaults (Track F4-design):
 *   SESSION_TOTAL: 100 writes per process lifetime
 *   HOURLY:        25 writes per rolling hour
 *
 * Env overrides:
 *   EPIMETHIAN_WRITE_BUDGET_SESSION=<n>
 *   EPIMETHIAN_WRITE_BUDGET_HOURLY=<n>
 *
 * Set either to `0` to disable the window entirely (use with care).
 *
 * Scope: all `create_*` / `update_*` / `delete_*` / `append_*` /
 * `prepend_*` / `revert_*` / `set_page_status` / `remove_page_status` /
 * `add_attachment` / `add_drawio_diagram` / `add_label` / `remove_label`
 * calls. Read operations are never counted.
 */

const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_SESSION_BUDGET = 100;
const DEFAULT_HOURLY_BUDGET = 25;

function parseBudget(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const n = parseInt(envValue, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `epimethian-mcp: invalid write-budget override "${envValue}"; using default (${fallback}).`,
    );
    return fallback;
  }
  return n;
}

class WriteBudget {
  private sessionCount = 0;
  private hourlyTimestamps: number[] = [];

  get sessionLimit(): number {
    return parseBudget(
      process.env.EPIMETHIAN_WRITE_BUDGET_SESSION,
      DEFAULT_SESSION_BUDGET,
    );
  }

  get hourlyLimit(): number {
    return parseBudget(
      process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY,
      DEFAULT_HOURLY_BUDGET,
    );
  }

  /**
   * Check whether another write would exceed either budget. Throws when
   * over the cap; otherwise increments both counters and returns.
   *
   * `budget=0` (either scope) disables that scope — useful for CI, where
   * per-run caps are enforced by the harness, or for interactive dev.
   */
  consume(): void {
    const now = Date.now();
    const cutoff = now - HOUR_MS;
    this.hourlyTimestamps = this.hourlyTimestamps.filter((ts) => ts >= cutoff);

    const sessionLimit = this.sessionLimit;
    if (sessionLimit > 0 && this.sessionCount >= sessionLimit) {
      throw new WriteBudgetExceededError(
        `Session write budget exhausted: ${this.sessionCount} writes issued, ` +
          `limit ${sessionLimit}. Restart the MCP server to reset. ` +
          `Raise the cap with EPIMETHIAN_WRITE_BUDGET_SESSION=<n> ` +
          `(or 0 to disable).`,
        "session",
        this.sessionCount,
        sessionLimit,
      );
    }

    const hourlyLimit = this.hourlyLimit;
    if (hourlyLimit > 0 && this.hourlyTimestamps.length >= hourlyLimit) {
      const oldest = this.hourlyTimestamps[0];
      const waitMs = Math.max(0, oldest + HOUR_MS - now);
      const waitMin = Math.ceil(waitMs / 60_000);
      throw new WriteBudgetExceededError(
        `Hourly write budget exhausted: ${this.hourlyTimestamps.length} writes in ` +
          `the last hour, limit ${hourlyLimit}. Window opens again in ~${waitMin} min. ` +
          `Raise the cap with EPIMETHIAN_WRITE_BUDGET_HOURLY=<n> (or 0 to disable).`,
        "hourly",
        this.hourlyTimestamps.length,
        hourlyLimit,
      );
    }

    this.sessionCount += 1;
    this.hourlyTimestamps.push(now);
  }

  /** Current session counter (for observability). */
  get session(): number {
    return this.sessionCount;
  }

  /** Current hourly counter (for observability). */
  get hourly(): number {
    const now = Date.now();
    const cutoff = now - HOUR_MS;
    this.hourlyTimestamps = this.hourlyTimestamps.filter((ts) => ts >= cutoff);
    return this.hourlyTimestamps.length;
  }

  /** Testing only. */
  _resetForTest(): void {
    this.sessionCount = 0;
    this.hourlyTimestamps = [];
  }
}

/** Error code used when the budget is exhausted. */
export const WRITE_BUDGET_EXCEEDED = "WRITE_BUDGET_EXCEEDED";

export class WriteBudgetExceededError extends Error {
  readonly code = WRITE_BUDGET_EXCEEDED;
  readonly scope: "session" | "hourly";
  readonly current: number;
  readonly limit: number;

  constructor(
    message: string,
    scope: "session" | "hourly",
    current: number,
    limit: number,
  ) {
    super(message);
    this.name = "WriteBudgetExceededError";
    this.scope = scope;
    this.current = current;
    this.limit = limit;
  }
}

/** Process-wide singleton. */
export const writeBudget = new WriteBudget();
