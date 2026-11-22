/**
 * Pagination cursors for v2 list endpoints.
 *
 * A v2 list answer carries `_links.next`, a link the client follows with the
 * account's credential attached. A cursor is therefore a place the credential
 * can be sent: it must point back into the same API (same origin, same path
 * prefix, same endpoint) or it is refused. A refused cursor is an error for the
 * caller, never a silently short list.
 *
 * Pure: no I/O, no config singleton. W-GW extends the rule for the gateway
 * origin and prefix in `doc/design/gateway-mode.md` section 5; because the
 * check is made against `Config.apiV2` (which already carries the gateway
 * prefix in gateway mode), the same predicate holds there.
 */

/** The path every v2 `_links.next` starts with when it is relative. */
const RELATIVE_V2_PREFIX = "/wiki/api/v2";

/**
 * Resolve a `_links.next` value to an absolute URL that is safe to follow, or
 * null when it is not provably safe.
 *
 * Accepted:
 *   - a relative `/wiki/api/v2/...` path, resolved against `apiV2`;
 *   - an absolute URL on the same origin whose path stays under `apiV2`'s path.
 * In both cases the resolved path must equal the path of `requestUrl` (the
 * request that produced the cursor): a cursor continues one listing, it cannot
 * redirect the walk to another page's attachments or another endpoint.
 *
 * @param next        the raw `_links.next` value (untrusted)
 * @param apiV2       `Config.apiV2`, e.g. `https://example.atlassian.net/wiki/api/v2`
 * @param requestUrl  the URL of the request whose answer carried `next`
 */
export function resolveV2NextLink(
  next: unknown,
  apiV2: string,
  requestUrl: string
): string | null {
  if (typeof next !== "string" || next === "") return null;
  if (next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return null;
  try {
    const base = new URL(apiV2);
    const basePath = base.pathname.replace(/\/+$/, "");
    const expectedPath = new URL(requestUrl).pathname;

    let candidate: string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(next)) {
      candidate = next; // absolute: judged by the parsed URL below
    } else if (next.startsWith(`${RELATIVE_V2_PREFIX}/`)) {
      candidate = `${base.origin}${basePath}${next.slice(RELATIVE_V2_PREFIX.length)}`;
    } else {
      return null; // protocol-relative (`//host`), other paths, bare words
    }

    const url = new URL(candidate);
    if (url.protocol !== base.protocol) return null;
    if (url.origin !== base.origin) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (!url.pathname.startsWith(`${basePath}/`)) return null;
    if (url.pathname !== expectedPath) return null;
    return url.toString();
  } catch {
    return null;
  }
}
