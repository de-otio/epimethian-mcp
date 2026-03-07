import * as vscode from 'vscode';

export async function saveCredentials(
  context: vscode.ExtensionContext,
  url: string,
  email: string,
  apiToken: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('epimethian-mcp');
  await config.update('url', url, vscode.ConfigurationTarget.Global);
  await config.update('email', email, vscode.ConfigurationTarget.Global);
  await context.secrets.store('epimethian-mcp.apiToken', apiToken);
}

export async function loadCredentials(
  context: vscode.ExtensionContext
): Promise<{ url: string; email: string; apiToken: string }> {
  const config = vscode.workspace.getConfiguration('epimethian-mcp');
  const url = config.get<string>('url') ?? '';
  const email = config.get<string>('email') ?? '';
  const apiToken = (await context.secrets.get('epimethian-mcp.apiToken')) ?? '';
  return { url, email, apiToken };
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
