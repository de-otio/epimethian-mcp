/**
 * Granular scopes a scoped API token needs for gateway mode (plan
 * §5.3 item 7). TO BE CONFIRMED BY THE LIVE PROBE: the list below is the
 * plan's starting point and W-INV's live results correct it. Setup prints it
 * and `doc/user-doc/installation.md` repeats it from here.
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
 * Classify the status of the setup-time dry-run `PUT /pages/999999999999`
 * for a token the user declared read-only (R4: one call must pass, one must
 * fail). 403 means the token lacks write scope (narrow, as intended). Any
 * other 4xx that is not an auth failure means the write was permitted to
 * proceed to validation or lookup (broad). Auth failures, 5xx and transport
 * errors prove nothing.
 */
export function classifyScopeProbe(status: number | undefined): "narrow" | "broad" | "inconclusive" {
  if (status === undefined) return "inconclusive";
  if (status === 403) return "narrow";
  if ([401, 405, 407, 410, 429].includes(status)) return "inconclusive";
  if (status >= 200 && status < 300) return "broad";
  if (status >= 400 && status < 500) return "broad";
  return "inconclusive";
}
