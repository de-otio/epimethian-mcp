/**
 * Pagination cursors for v2 list endpoints.
 *
 * A v2 list answer carries `_links.next`, a link the client follows with the
 * account's credential attached. A cursor is therefore a place the credential
 * can be sent: it must point back into the same API (same origin, same path
 * prefix, same endpoint) or it is refused. A refused cursor is an error for the
 * caller, never a silently short list.
 *
 * Pure: no I/O, no config singleton.
 *
 * Why there are two cursor resolvers. `resolveNextLink` (api-base.ts) serves
 * the v1 CQL search, whose `_links.next` is relative to the `/wiki` context
 * (`/rest/api/search?...`, with or without `/wiki`) and whose follow-up is
 * allowed anywhere under the request base. This one serves v2 lists and is
 * stricter: the cursor must continue the SAME listing (same request path), so
 * a cursor cannot move the walk to another page's attachments or another
 * endpoint. Both end with the same final gate, `isCredentialedUrl`, so neither
 * can send the credential outside the pinned request base (the site origin,
 * or the sealed gateway prefix `/ex/confluence/{sealedCloudId}`).
 */

import { isCredentialedUrl } from "./api-base.js";

/** The path every v2 `_links.next` starts with when it is relative to the site. */
const RELATIVE_V2_PREFIX = "/wiki/api/v2";

/**
 * Resolve a `_links.next` value to an absolute URL that is safe to follow, or
 * null when it is not provably safe.
 *
 * Accepted:
 *   - a relative `/wiki/api/v2/...` path, resolved under `apiV2`'s prefix;
 *   - a relative path that starts with `apiV2`'s full path (in gateway mode
 *     `/ex/confluence/{sealedCloudId}/wiki/api/v2/...`: the gateway may return
 *     its own prefixed form). In site mode `apiV2`'s path is `/wiki/api/v2`,
 *     so an `/ex/...` cursor matches neither form and is refused;
 *   - an absolute URL on the same origin whose path stays under `apiV2`'s path.
 * In every case the resolved path must equal the path of `requestUrl` (the
 * request that produced the cursor) and pass `isCredentialedUrl` against the
 * request base derived from `apiV2`: a cursor continues one listing, it cannot
 * redirect the walk to another page, endpoint or cloudId.
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
    if (!basePath.endsWith(RELATIVE_V2_PREFIX)) return null;
    // The request base: `apiV2` without `/wiki/api/v2` (site origin, or the gateway prefix).
    const requestBase = `${base.origin}${basePath.slice(0, -RELATIVE_V2_PREFIX.length)}`;
    const expectedPath = new URL(requestUrl).pathname;

    let candidate: string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(next)) {
      candidate = next; // absolute: judged by the parsed URL below
    } else if (next.startsWith("//")) {
      return null; // protocol-relative
    } else if (basePath !== RELATIVE_V2_PREFIX && next.startsWith(`${basePath}/`)) {
      candidate = `${base.origin}${next}`; // gateway's prefixed form
    } else if (next.startsWith(`${RELATIVE_V2_PREFIX}/`)) {
      candidate = `${base.origin}${basePath}${next.slice(RELATIVE_V2_PREFIX.length)}`;
    } else {
      return null; // other paths, bare words
    }

    const url = new URL(candidate);
    if (url.protocol !== base.protocol) return null;
    if (url.origin !== base.origin) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (!url.pathname.startsWith(`${basePath}/`)) return null;
    if (url.pathname !== expectedPath) return null;
    const out = url.toString();
    return isCredentialedUrl(out, requestBase) ? out : null;
  } catch {
    return null;
  }
}
