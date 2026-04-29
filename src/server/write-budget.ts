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
 *   - Rolling burst window: sliding 15-minute cap. Catches bursts; tighter
 *     limit than the session total. (Historically a 60-minute cap named
 *     HOURLY, tightened to 15 minutes in 6.2.0.)
 *
 * Defaults (raised in 6.2.3 to accommodate multi-page documentation builds
 * at human pace — a single 30-page pass with cross-links easily reaches 60
 * writes, while a runaway loop trivially exceeds the new ceiling within
 * seconds):
 *   SESSION_TOTAL: 250 writes per process lifetime
 *   ROLLING:       75 writes per rolling 15 minutes
 *
 * Env overrides:
 *   EPIMETHIAN_WRITE_BUDGET_SESSION=<n>
 *   EPIMETHIAN_WRITE_BUDGET_ROLLING=<n>   (governs the 15-minute window)
 *   EPIMETHIAN_WRITE_BUDGET_HOURLY=<n>    (deprecated alias for _ROLLING;
 *                                          still accepted, removal in 7.0.0)
 *
 * Resolution order for the rolling cap:
 *   1. EPIMETHIAN_WRITE_BUDGET_ROLLING (preferred)
 *   2. EPIMETHIAN_WRITE_BUDGET_HOURLY  (deprecated alias — sets a flag that
 *      surfaces a one-shot deprecation warning in the next tool result)
 *   3. Default (75)
 *
 * Set either env var to `0` to disable the window entirely (use with care).
 *
 * Scope: all `create_*` / `update_*` / `delete_*` / `append_*` /
 * `prepend_*` / `revert_*` / `set_page_status` / `remove_page_status` /
 * `add_attachment` / `add_drawio_diagram` / `add_label` / `remove_label`
 * calls. Read operations are never counted.
 */

const WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_SESSION_BUDGET = 250;
const DEFAULT_ROLLING_BUDGET = 75;

/**
 * Parse a numeric budget from an env-var string. Returns the fallback on
 * parse failure (invalid or negative values). Does NOT emit to stderr — the
 * caller is responsible for routing any diagnostic through the warning channel.
 */
function parseBudget(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const n = parseInt(envValue, 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return n;
}

class WriteBudget {
  private sessionCount = 0;
  private rollingTimestamps: number[] = [];

  /**
   * Set when the process resolved the rolling cap via the deprecated
   * EPIMETHIAN_WRITE_BUDGET_HOURLY env var (and _ROLLING was absent).
   * Cleared after the first drainPendingWarnings() emits the warning.
   */
  private deprecatedHourlyEnvVarSet = false;

  /**
   * True after drainPendingWarnings() has fired once for the current
   * HOURLY env-var session. Prevents the flag from being re-set by
   * subsequent consume() calls while the env var is still present.
   */
  private deprecationWarningFired = false;

  get sessionLimit(): number {
    return parseBudget(
      process.env.EPIMETHIAN_WRITE_BUDGET_SESSION,
      DEFAULT_SESSION_BUDGET,
    );
  }

  get rollingLimit(): number {
    // Resolution order: ROLLING > HOURLY > default
    if (process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING !== undefined) {
      return parseBudget(
        process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING,
        DEFAULT_ROLLING_BUDGET,
      );
    }
    if (process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY !== undefined) {
      return parseBudget(
        process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY,
        DEFAULT_ROLLING_BUDGET,
      );
    }
    return DEFAULT_ROLLING_BUDGET;
  }

  /**
   * Re-evaluate whether the deprecated env var flag should be set.
   * Called during consume() so the flag picks up env changes (relevant
   * mainly in tests that hotswap env vars). Once the warning has fired
   * (deprecationWarningFired = true) we stop re-setting it.
   */
  private refreshDeprecationFlag(): void {
    if (this.deprecationWarningFired) return;
    if (
      process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY !== undefined &&
      process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING === undefined
    ) {
      this.deprecatedHourlyEnvVarSet = true;
    }
  }

  /**
   * Drain any pending one-shot deprecation warnings. Returns an array of
   * warning strings (zero or one element). The flag is cleared after the
   * first drain so subsequent consume() calls produce no warnings.
   *
   * Callers should invoke this immediately after a successful consume() and
   * surface the returned strings through the tool-result warning channel.
   */
  drainPendingWarnings(): string[] {
    if (!this.deprecatedHourlyEnvVarSet) return [];
    this.deprecatedHourlyEnvVarSet = false;
    this.deprecationWarningFired = true;
    return [
      "Deprecated MCP config: the user's MCP config sets `EPIMETHIAN_WRITE_BUDGET_HOURLY`, " +
        "which still works but has been renamed to `EPIMETHIAN_WRITE_BUDGET_ROLLING` " +
        "(the window is 15 min, not 60). Tell the user to update the env-var name in their " +
        "`.mcp.json` (or equivalent MCP config). The old name will be removed in 7.0.0.",
    ];
  }

  /**
   * Check whether another write would exceed either budget. Throws when
   * over the cap; otherwise increments both counters and returns.
   *
   * `budget=0` (either scope) disables that scope — useful for CI, where
   * per-run caps are enforced by the harness, or for interactive dev.
   *
   * After a successful consume(), call drainPendingWarnings() to retrieve
   * any one-shot deprecation warnings to surface in the tool result.
   */
  consume(): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    this.rollingTimestamps = this.rollingTimestamps.filter((ts) => ts >= cutoff);

    // Refresh deprecation flag before checking limits (picks up hot env changes in tests).
    this.refreshDeprecationFlag();

    const sessionLimit = this.sessionLimit;
    if (sessionLimit > 0 && this.sessionCount >= sessionLimit) {
      throw new WriteBudgetExceededError(
        buildSessionExceededMessage(this.sessionCount, sessionLimit),
        "session",
        this.sessionCount,
        sessionLimit,
      );
    }

    const rollingLimit = this.rollingLimit;
    if (rollingLimit > 0 && this.rollingTimestamps.length >= rollingLimit) {
      const oldest = this.rollingTimestamps[0];
      const waitMs = Math.max(0, oldest + WINDOW_MS - now);
      const waitMin = Math.ceil(waitMs / 60_000);
      const deprecationNote =
        this.deprecatedHourlyEnvVarSet
          ? "\n\nNote: the cap was sourced from the deprecated `EPIMETHIAN_WRITE_BUDGET_HOURLY` env var. " +
            "Rename it to `EPIMETHIAN_WRITE_BUDGET_ROLLING` in the MCP config."
          : "";
      throw new WriteBudgetExceededError(
        buildRollingExceededMessage(
          this.rollingTimestamps.length,
          rollingLimit,
          waitMin,
        ) + deprecationNote,
        "rolling",
        this.rollingTimestamps.length,
        rollingLimit,
      );
    }

    this.sessionCount += 1;
    this.rollingTimestamps.push(now);
  }

  /** Current session counter (for observability). */
  get session(): number {
    return this.sessionCount;
  }

  /** Current rolling-window counter (for observability). */
  get hourly(): number {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    this.rollingTimestamps = this.rollingTimestamps.filter((ts) => ts >= cutoff);
    return this.rollingTimestamps.length;
  }

  /** Testing only. */
  _resetForTest(): void {
    this.sessionCount = 0;
    this.rollingTimestamps = [];
    this.deprecatedHourlyEnvVarSet = false;
    this.deprecationWarningFired = false;
  }
}

// ---------------------------------------------------------------------------
// Message builders (exported for tests)
// ---------------------------------------------------------------------------

export function buildSessionExceededMessage(current: number, limit: number): string {
  return (
    `Write budget exhausted (session): ${current} writes in this session, limit ${limit}.\n\n` +
    `Why this exists: epimethian-mcp caps writes per session and per 15-minute window as a ` +
    `safety net against runaway agents (loops, mistakes in long autonomous runs). ` +
    `The cap is not a Confluence rate limit — it is a local guard.\n\n` +
    `What to tell the user:\n` +
    `  - Briefly explain that the safety budget has been reached.\n` +
    `  - Confirm whether the work in progress was intentional. If the agent\n` +
    `    is mid-task on user-requested work, the user almost certainly wants\n` +
    `    to raise the cap.\n` +
    `  - If unintentional (loop, retries gone wrong), STOP and ask the user\n` +
    `    before doing anything else.\n\n` +
    `How to raise or disable the cap:\n` +
    `  - Edit the user's MCP config (typically .mcp.json) and add to the\n` +
    `    "env" block for this server:\n` +
    `        "EPIMETHIAN_WRITE_BUDGET_SESSION": "<higher number>"\n` +
    `    Set to "0" to disable this scope entirely.\n` +
    `  - Restart the MCP server (re-open the client) for the new value to\n` +
    `    take effect.\n\n` +
    `Restart the MCP server to reset the session counter.`
  );
}

export function buildRollingExceededMessage(
  current: number,
  limit: number,
  waitMin: number,
): string {
  return (
    `Rolling write budget exhausted: ${current} writes in the last 15 min, limit ${limit}.\n\n` +
    `Why this exists: epimethian-mcp caps writes per session and per 15-minute window as a ` +
    `safety net against runaway agents (loops, mistakes in long autonomous runs). ` +
    `The cap is not a Confluence rate limit — it is a local guard.\n\n` +
    `What to tell the user:\n` +
    `  - Briefly explain that the safety budget has been reached.\n` +
    `  - Confirm whether the work in progress was intentional. If the agent\n` +
    `    is mid-task on user-requested work, the user almost certainly wants\n` +
    `    to raise the cap.\n` +
    `  - If unintentional (loop, retries gone wrong), STOP and ask the user\n` +
    `    before doing anything else.\n\n` +
    `How to raise or disable the cap:\n` +
    `  - Edit the user's MCP config (typically .mcp.json) and add to the\n` +
    `    "env" block for this server:\n` +
    `        "EPIMETHIAN_WRITE_BUDGET_ROLLING": "<higher number>"\n` +
    `    Set to "0" to disable this scope entirely.\n` +
    `  - Restart the MCP server (re-open the client) for the new value to\n` +
    `    take effect.\n` +
    `  - For the rolling window, the env var name is\n` +
    `    EPIMETHIAN_WRITE_BUDGET_ROLLING (the legacy name\n` +
    `    EPIMETHIAN_WRITE_BUDGET_HOURLY is still accepted as an alias).\n\n` +
    `Window opens again in ~${waitMin} min if you wait.`
  );
}

/** Error code used when the budget is exhausted. */
export const WRITE_BUDGET_EXCEEDED = "WRITE_BUDGET_EXCEEDED";

export class WriteBudgetExceededError extends Error {
  readonly code = WRITE_BUDGET_EXCEEDED;
  readonly scope: "session" | "rolling";
  readonly current: number;
  readonly limit: number;

  constructor(
    message: string,
    scope: "session" | "rolling",
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
