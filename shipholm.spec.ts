import { describe, expect, it } from 'vitest';

import { createShipholm } from './shipholm.mjs';

/** createShipholm with handle() typed as returning a Response (null means "on to the app"). */
function make(env: Record<string, string>, fetchImpl: typeof fetch) {
  const s = createShipholm(env, fetchImpl);
  return { handle: async (r: Request) => (await s.handle(r)) as Response };
}

const SESSION = 'abs_valid';

/** A stand-in for the Shipholm API: sign-in exchange and the MCP endpoint. */
function fakeApi() {
  const calls: Array<{ tool: string; args: Record<string, unknown>; token: string }> = [];

  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body || '{}');

    if (url.endsWith('/account/exchange')) {
      return body.code === 'good'
        ? Response.json({ session: SESSION, tenant: 't1', expires_in: 600 })
        : Response.json({ error: 'invalid or expired code' }, { status: 400 });
    }

    const token = (init.headers.Authorization || '').replace('Bearer ', '');

    if (token !== SESSION) {
      return new Response('unauthorized', { status: 401 });
    }

    if (body.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'Mcp-Session-Id': 's1' } });
    }

    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }

    const { name, arguments: args } = body.params;
    calls.push({ tool: name, args, token });

    const result = name === 'get_account' ? { tenant: 't1', account: { plan: 'free' } } : { ok: true, tool: name };

    // the API answers tool calls as a server-sent event stream
    return new Response(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: result } })}\n\n`,
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const BASE = 'https://code.example';

const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  new Request(BASE + path, {
    ...init,
    headers: { ...(init.cookie ? { cookie: `shipholm_session=${init.cookie}` } : {}), ...(init.headers as object) },
  });

describe('shipholm integration', () => {
  const env = { SHIPHOLM_API_URL: 'https://api.example', SHIPHOLM_PUBLIC_URL: BASE, SHIPHOLM_REQUIRE_SIGNIN: 'true' };

  it('sends sign-in to the API with this app as the return address', async () => {
    const { fetchImpl } = fakeApi();
    const res = await make(env, fetchImpl).handle(req('/auth/login'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://api.example/account/login?return=' + encodeURIComponent(`${BASE}/auth/callback`),
    );
  });

  it('exchanges the code for an HttpOnly session cookie', async () => {
    const { fetchImpl } = fakeApi();
    const s = make(env, fetchImpl);
    const ok = await s.handle(req('/auth/callback?code=good'));

    expect(ok.status).toBe(302);
    expect(ok.headers.get('set-cookie')).toMatch(
      /^shipholm_session=abs_valid; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
    );

    const bad = await s.handle(req('/auth/callback?code=bad'));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('invalid or expired code');
  });

  it('requires a session for pages and APIs, but not for health', async () => {
    const { fetchImpl } = fakeApi();
    const s = make(env, fetchImpl);

    const pageRes = await s.handle(req('/'));
    expect(pageRes.status).toBe(401);
    expect(await pageRes.text()).toContain('Sign in with GitHub');
    expect((await s.handle(req('/api/chat', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect((await s.handle(req('/', { cookie: 'abs_forged' }))).status).toBe(401);
    expect(await s.handle(req('/api/health'))).toBeNull();
    expect(await s.handle(req('/', { cookie: SESSION }))).toBeNull(); // on to the app
  });

  it('lets everything through when sign-in is not required', async () => {
    const { fetchImpl } = fakeApi();
    const s = make({ ...env, SHIPHOLM_REQUIRE_SIGNIN: 'false' }, fetchImpl);

    expect(await s.handle(req('/api/chat', { method: 'POST', body: '{}' }))).toBeNull();
  });

  it('reports who is signed in', async () => {
    const { fetchImpl } = fakeApi();
    const s = make(env, fetchImpl);
    const me = (await (await s.handle(req('/api/shipholm/me', { cookie: SESSION }))).json()) as Record<string, unknown>;

    expect(me).toMatchObject({ enabled: true, signedIn: true, tenant: 't1', account: { plan: 'free' } });
    expect(((await (await s.handle(req('/api/shipholm/me'))).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });

  it('proxies allowed tools as the signed-in customer, in their own tenant', async () => {
    const { fetchImpl, calls } = fakeApi();
    const s = make(env, fetchImpl);

    const call = (tool: string, args: object, extra: Record<string, string> = {}) =>
      s.handle(
        req('/api/shipholm/tool', {
          method: 'POST',
          cookie: SESSION,
          headers: { origin: BASE, ...extra },
          body: JSON.stringify({ tool, arguments: args }),
        }),
      );

    const ok = await call('create_app', { app: 'shop', source_repo: 'https://github.com/a/shop', tenant: 'other' });
    expect(await ok.json()).toEqual({ ok: true, tool: 'create_app' });
    expect(calls.at(-1)).toEqual({
      tool: 'create_app',
      args: { app: 'shop', source_repo: 'https://github.com/a/shop' },
      token: SESSION,
    });

    expect((await call('delete_app', { app: 'shop', confirm: true })).status).toBe(400);
    expect((await call('create_api_token', { name: 'x' })).status).toBe(400);
    expect((await call('app_status', { app: 'shop' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('refuses tool calls without a session', async () => {
    const { fetchImpl } = fakeApi();

    const res = await make(env, fetchImpl).handle(
      req('/api/shipholm/tool', { method: 'POST', body: JSON.stringify({ tool: 'list_apps' }) }),
    );

    expect(res.status).toBe(401);
  });
});
