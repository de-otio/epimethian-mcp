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
 * The endpoint is site-scoped and does not require authentication, but we
 * still pass the Basic auth header so the call shares cache/connection with
 * the authenticated API calls and so a broken token surfaces consistently.
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
  apiToken: string
): Promise<{ ok: true; info: TenantInfo } | { ok: false; message: string }> {
  const base = url.replace(/\/+$/, '');
  const endpoint = `${base}/_edge/tenant_info`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

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
    const body = (await response.json()) as { cloudId?: unknown; cloudName?: unknown };
    const cloudId = typeof body.cloudId === 'string' ? body.cloudId.trim() : '';
    if (!cloudId) {
      return { ok: false, message: 'tenant_info response missing cloudId' };
    }
    const cloudName =
      typeof body.cloudName === 'string' && body.cloudName.trim()
        ? body.cloudName.trim()
        : hostFallback;
    return { ok: true, info: { cloudId, displayName: cloudName } };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `tenant_info fetch failed: ${message}` };
  }
}

export async function testConnection(
  url: string,
  email: string,
  apiToken: string
): Promise<{ ok: boolean; message: string }> {
  const endpoint = `${url.replace(/\/+$/, '')}/wiki/api/v2/spaces?limit=1`;
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
      const status = response.status;
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection failed: ${message}` };
  }
}
