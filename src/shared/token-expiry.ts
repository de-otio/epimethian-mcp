/**
 * Scoped API token expiry (gateway mode, doc/design/gateway-mode.md §7).
 *
 * Atlassian does not expose a token's expiry through the REST API, so setup
 * asks for the date shown at token creation and stores it as `YYYY-MM-DD`.
 * Everything here is pure: the clock is passed in as a `YYYY-MM-DD` string.
 */

export type ExpiryState =
  | { readonly kind: "none" }
  | { readonly kind: "ok" | "soon"; readonly daysLeft: number }
  | { readonly kind: "expired"; readonly daysLeft: number };

/** A token expiring within this many days (inclusive, day 0 included) is "soon". */
export const EXPIRY_WARNING_DAYS = 14;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** UTC midnight of a real calendar date, or undefined for anything else (2026-02-30, 2026-1-5, ...). */
function utcDay(date: string): number | undefined {
  const m = ISO_DATE_RE.exec(date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return ms;
}

/** True when `s` is `YYYY-MM-DD` and a real calendar date. */
export function isValidExpiryDate(s: string): boolean {
  return utcDay(s) !== undefined;
}

/** Today's date in UTC as `YYYY-MM-DD`. The only clock read in the expiry code. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * daysLeft = whole UTC days from `today` to `expiry`.
 * soon: 0 <= daysLeft <= 14. expired: daysLeft < 0. A missing or malformed
 * expiry is "none" (the same policy as a malformed cloudId: dropped).
 */
export function tokenExpiryState(expiry: string | undefined, today: string): ExpiryState {
  if (expiry === undefined) return { kind: "none" };
  const e = utcDay(expiry);
  const t = utcDay(today);
  if (e === undefined || t === undefined) return { kind: "none" };
  const daysLeft = Math.round((e - t) / MS_PER_DAY);
  if (daysLeft < 0) return { kind: "expired", daysLeft };
  return { kind: daysLeft <= EXPIRY_WARNING_DAYS ? "soon" : "ok", daysLeft };
}

/** One human line for `status`: `2026-12-01 (30 days left)`, `... (expires today)` or `EXPIRED on ...`. */
export function describeExpiry(expiry: string, state: ExpiryState): string {
  switch (state.kind) {
    case "none":
      return expiry;
    case "expired":
      return `EXPIRED on ${expiry} (${-state.daysLeft} day${state.daysLeft === -1 ? "" : "s"} ago)`;
    case "ok":
    case "soon":
      return state.daysLeft === 0
        ? `${expiry} (expires today)`
        : `${expiry} (${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} left)`;
  }
}
