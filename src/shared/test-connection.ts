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
