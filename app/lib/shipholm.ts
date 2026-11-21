/*
 * Browser side of the Shipholm integration. The session lives in an HttpOnly cookie that only
 * the server (shipholm.mjs) reads; the browser asks it to call the Shipholm API on its behalf.
 */

export interface ShipholmMe {
  enabled: boolean;
  requireSignin?: boolean;
  signedIn: boolean;
  tenant: string | null;
  account: { github_login?: string; plan?: string } | null;
}

export class ShipholmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function shipholmMe(): Promise<ShipholmMe> {
  const res = await fetch('/api/shipholm/me', { credentials: 'same-origin' });

  if (!res.ok) {
    // not served by the Node server (vite dev, Cloudflare): no integration
    return { enabled: false, signedIn: false, tenant: null, account: null };
  }

  return (await res.json()) as ShipholmMe;
}

export async function shipholmTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}) {
  const res = await fetch('/api/shipholm/tool', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    throw new ShipholmError(String(data.error || `HTTP ${res.status}`), res.status);
  }

  return data as T;
}

/** A valid Shipholm app name: lowercase letters, digits and '-', 1–30 characters, starting with a letter. */
export function shipholmAppName(name: string): string {
  let out = name
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 30)
    .replace(/-+$/, '');

  if (!out) {
    out = 'my-app';
  }

  return out;
}

export interface ShipholmAppStatus {
  url: string | null;
  ready: boolean;
  sleeping?: boolean;
  source?: { repo: string; built_sha?: string } | null;
  build?: { status?: string; sha?: string; at?: string; rebuild_requested?: boolean } | null;
  hints?: string[];
}
