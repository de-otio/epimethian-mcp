import { sanitizeDisplayName } from './display-text.js';

/**
 * Upper bound for each startup/setup check (tenant_info, the spaces check, the
 * setup scope probe). A hung connection must not hang setup or server startup.
 */
export const CONNECTION_CHECK_TIMEOUT_MS = 15_000;

class CheckTimeoutError extends Error {
  constructor() {
    super(`timed out after ${CONNECTION_CHECK_TIMEOUT_MS / 1000} s`);
    this.name = 'CheckTimeoutError';
  }
}

/**
 * Run `op` (fetch plus body read) with an abort signal, and give up after
 * CONNECTION_CHECK_TIMEOUT_MS even if the fetch ignores the signal.
 */
async function withCheckTimeout<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new CheckTimeoutError();
      controller.abort(err);
      reject(err);
    }, CONNECTION_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([op(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A 3xx answer to a request sent with `redirect: "manual"`. */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export async function verifyTenantIdentity(
  url: string,
  email: string,
  apiToken: string
): Promise<{ ok: boolean; authenticatedEmail?: string; message: string }> {
  const endpoint = `${url.replace(/\/+$/, '')}/wiki/rest/api/user/current`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}: ${response.statusText}` };
    }

    const body = (await response.json()) as {
      email?: string;
      displayName?: string;
    };
    const authenticatedEmail = body.email ?? '';

    if (authenticatedEmail.toLowerCase() !== email.toLowerCase()) {
      return {
        ok: false,
        authenticatedEmail,
        message:
          `Tenant identity mismatch. Expected: ${email}, authenticated as: ${authenticatedEmail}. ` +
          'This may indicate a DNS or configuration issue.',
      };
    }

    return { ok: true, authenticatedEmail, message: `Verified identity: ${authenticatedEmail}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Identity verification failed: ${message}` };
  }
}

/**
 * Fetch the tenant's cloudId and a friendly display name.
 *
 * Uses the site-level `/_edge/tenant_info` endpoint which returns
 * `{ cloudId: "<uuid>" }` (and sometimes `cloudName`). This is a stable
 * Atlassian Cloud edge endpoint used for identifying the tenant backing a
 * given `*.atlassian.net` host.
 *
 * The endpoint is site-scoped and does not require authentication. In site
 * mode we still pass the Basic auth header so the call shares cache/connection
 * with the authenticated API calls and so a broken token surfaces consistently.
 * In gateway mode (`authenticated: false`) NO Authorization header is sent: a
 * scoped token must never reach the site origin, which does not serve it.
 *
 * Returns `{ ok: false }` (graceful degrade) on any failure — callers should
 * treat a missing tenant_info as "cannot seal" rather than a hard error, so
 * that sites where the endpoint is unavailable still work.
 */
export interface TenantInfo {
  cloudId: string;
  displayName: string;
}

export async function fetchTenantInfo(
  url: string,
  email: string,
  apiToken: string,
  opts: { authenticated?: boolean } = {}
): Promise<{ ok: true; info: TenantInfo } | { ok: false; message: string }> {
  const base = url.replace(/\/+$/, '');
  const endpoint = `${base}/_edge/tenant_info`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.authenticated !== false) {
    headers.Authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  }

  // Derive a fallback display name from the host (e.g. "globex" from
  // "globex.atlassian.net"). Used if the response has no cloudName.
  let hostFallback = base;
  try {
    const parsed = new URL(base);
    hostFallback = parsed.hostname.replace(/\.atlassian\.net$/i, '') || parsed.hostname;
  } catch {
    // keep base as-is
  }

  try {
    return await withCheckTimeout(async (signal) => {
      const response = await fetch(endpoint, { method: 'GET', headers, signal });
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}: ${response.statusText}` } as const;
      }
      const body = (await response.json()) as { cloudId?: unknown; cloudName?: unknown };
      const cloudId = typeof body.cloudId === 'string' ? body.cloudId.trim() : '';
      if (!cloudId) {
        return { ok: false, message: 'tenant_info response missing cloudId' } as const;
      }
      // Tenant-supplied text, printed for the user to confirm: no control characters.
      const cloudName =
        typeof body.cloudName === 'string' ? sanitizeDisplayName(body.cloudName) : '';
      return { ok: true, info: { cloudId, displayName: cloudName || hostFallback } } as const;
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `tenant_info fetch failed: ${message}` };
  }
}

/**
 * `GET {requestBase}/wiki/api/v2/spaces?limit=1`.
 *
 * `requestBase` is `requestBaseFor(...)`: the site URL in site mode, the
 * pinned `https://api.atlassian.com/ex/confluence/{cloudId}` in gateway mode.
 * `opts.gateway` only changes the wording of a 401/403, which on the gateway
 * means an expired, revoked or under-scoped token rather than a bad key.
 */
export async function testConnection(
  requestBase: string,
  email: string,
  apiToken: string,
  opts: { gateway?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  const endpoint = `${requestBase.replace(/\/+$/, '')}/wiki/api/v2/spaces?limit=1`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    return await withCheckTimeout(async (signal) => {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        // Gateway: never follow a redirect with the credential (it could name
        // another cloudId on the same origin). Site mode is unchanged.
        ...(opts.gateway ? { redirect: 'manual' as const } : {}),
        signal,
      });

      if (opts.gateway && isRedirect(response.status)) {
        await Promise.resolve(response.body?.cancel?.()).catch(() => {});
        return {
          ok: false,
          message: `HTTP ${response.status} from the Atlassian API gateway: a redirect was refused (credentialed gateway requests never follow redirects).`,
        };
      }

      if (!response.ok) {
        const status = response.status;
        if (opts.gateway && (status === 401 || status === 403)) {
          return {
            ok: false,
            message:
              `HTTP ${status} from the Atlassian API gateway: the scoped API token is expired, revoked, ` +
              'or missing a scope (this check needs read:space:confluence). ' +
              'Create a new token at https://id.atlassian.com/manage-profile/security/api-tokens',
          };
        }
        if (status === 401) {
          return {
            ok: false,
            message:
              'Token is invalid or expired. Generate a new one at https://id.atlassian.com/manage-profile/security/api-tokens',
          };
        }
        return { ok: false, message: `HTTP ${status}: ${response.statusText}` };
      }

      const body = (await response.json()) as {
        results?: Array<{ name?: string }>;
      };
      const spaceCount = body.results?.length ?? 0;
      const spaceName = body.results?.[0]?.name;
      const detail = spaceName
        ? `Found space "${spaceName}"`
        : `${spaceCount} space(s) accessible`;

      return { ok: true, message: `Connected successfully. ${detail}.` };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection failed: ${message}` };
  }
}

/**
 * Setup-time scope probe (R4: one call must pass, one must fail). Sends the
 * same dry-run page update the server's capability probe uses,
 * `PUT /pages/999999999999` with an empty body, to the pinned gateway base,
 * and returns only the HTTP status (or undefined on a transport error or
 * timeout). The page does not exist, so a token that may update pages answers
 * 400/404 and nothing is modified. It proves whether the token can update
 * pages, nothing about other write scopes. Classify with `classifyScopeProbe`
 * (gateway-scopes.ts).
 */
export async function probeGatewayWriteScope(
  requestBase: string,
  email: string,
  apiToken: string
): Promise<number | undefined> {
  const endpoint = `${requestBase.replace(/\/+$/, '')}/wiki/api/v2/pages/999999999999`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  try {
    return await withCheckTimeout(async (signal) => {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        // Never follow a redirect: it would replay the write, with the credential.
        // A 3xx is returned as is and classifies as inconclusive.
        redirect: 'manual',
        signal,
      });
      await Promise.resolve(response.body?.cancel?.()).catch(() => {});
      return response.status;
    });
  } catch {
    return undefined;
  }
}
