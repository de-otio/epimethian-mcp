/**
 * Granular scopes a scoped API token needs for gateway mode (plan
 * §5.3 item 7). The 12 read scopes are confirmed for reads by the live check
 * of 2026-11-22; the write scopes are not yet verified live. Setup prints the
 * list and `doc/user-doc/installation.md` repeats it from here.
 */
export type GatewayPosture = "read-only" | "read-write";

const READ_SCOPES = [
  "read:page:confluence",
  "read:blogpost:confluence",
  "read:space:confluence",
  "read:attachment:confluence",
  "read:label:confluence",
  "read:comment:confluence",
  "read:hierarchical-content:confluence",
  "read:folder:confluence",
  "read:task:confluence",
  "read:content.property:confluence",
  "read:user:confluence",
  "read:space.permission:confluence",
] as const;

const WRITE_SCOPES = [
  "write:page:confluence",
  "write:blogpost:confluence",
  "delete:page:confluence",
  "write:comment:confluence",
  "delete:comment:confluence",
  "delete:attachment:confluence",
] as const;

export const GATEWAY_SCOPES: Readonly<Record<GatewayPosture, readonly string[]>> = Object.freeze({
  "read-only": Object.freeze([...READ_SCOPES]),
  "read-write": Object.freeze([...READ_SCOPES, ...WRITE_SCOPES]),
});

/**
 * What the setup-time dry-run `PUT /pages/999999999999` answered: the HTTP
 * status, and whether the body said the token's scopes do not cover the
 * request. Nothing else from the body is kept (it is never logged).
 */
export interface ScopeProbeResult {
  status: number;
  scopeMismatch: boolean;
}

/**
 * True when an error body says the token's scopes do not cover the request.
 * Live (2026-11-22), a scoped read-only token's dry-run page update through
 * the gateway answered 401 with
 * `{"code":401,"message":"Unauthorized; scope does not match"}`.
 * Only the JSON `message` field is read; anything unparsable is false.
 */
export function bodySaysScopeMismatch(body: string | undefined): boolean {
  if (!body) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const message = (parsed as { message?: unknown }).message;
  return typeof message === "string" && /scope does not match/i.test(message);
}

/**
 * Classify the setup-time dry-run `PUT /pages/999999999999` for a token the
 * user declared read-only (R4: one call must pass, one must fail). The probe
 * proves ONE thing: whether this token can update pages. It says nothing
 * about the other write scopes (blog posts, comments, attachments, deletes),
 * which are not probed; callers must say so.
 *
 * 403, and 401 whose body says "scope does not match" (what the gateway
 * answers live), mean the token cannot update pages (narrow, as intended).
 * Any other 4xx that is not listed below means the update was allowed to
 * proceed to validation or lookup (broad). 3xx, 5xx and transport errors
 * prove nothing.
 */
export function classifyScopeProbe(probe: ScopeProbeResult | undefined): "narrow" | "broad" | "inconclusive" {
  if (probe === undefined) return "inconclusive";
  const { status } = probe;
  if (status === 403) return "narrow";
  if (status === 401 && probe.scopeMismatch) return "narrow";
  // Any other 401 stays inconclusive: it may be a bad or expired token.
  if ([401, 405, 407, 410, 429].includes(status)) return "inconclusive";
  if (status >= 200 && status < 300) return "broad";
  if (status >= 400 && status < 500) return "broad";
  return "inconclusive";
}
