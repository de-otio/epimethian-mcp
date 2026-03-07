// Webview -> Extension
export type WebviewMessage =
  | { type: 'save'; url: string; email: string; apiToken: string }
  | { type: 'testConnection'; url: string; email: string; apiToken: string }
  | { type: 'requestConfig' }
  | { type: 'registerClient'; clientId: string }
  | { type: 'unregisterClient'; clientId: string };

// Extension -> Webview
export type ExtensionMessage =
  | { type: 'configLoaded'; url: string; email: string; hasToken: boolean; clients: ClientStatus[] }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'saved' }
  | { type: 'clientUpdated'; clients: ClientStatus[] };

export interface ClientStatus {
  id: string;
  name: string;
  pathDescription: string;
  registered: boolean;
}
