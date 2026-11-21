/*
 * Shipholm integration for the Node server (server.mjs): sign-in, and a narrow proxy to the
 * Shipholm API so the browser can deploy the project it builds.
 *
 *   GET  /auth/login           -> Shipholm's GitHub sign-in (API: /account/login)
 *   GET  /auth/callback?code=  <- one-time code; exchanged server to server for a session,
 *                                 kept in an HttpOnly cookie (never readable by page scripts)
 *   POST /auth/logout
 *   GET  /api/shipholm/me      -> { enabled, signedIn, tenant, account }
 *   POST /api/shipholm/tool    { tool, arguments } -> the tool's result, called as the signed-in
 *                                 customer; only the tools in TOOLS
 *
 * With SHIPHOLM_REQUIRE_SIGNIN=true every other request needs a valid session: pages show a
 * sign-in page, API calls get 401. That keeps the server-side LLM key (GARAGEAI_API_KEY) for
 * Shipholm customers only.
 *
 * Environment:
 *   SHIPHOLM_API_URL         default https://api.shipholm.com
 *   SHIPHOLM_PUBLIC_URL      this app's own address (https://code.shipholm.com); the API only
 *                            accepts return addresses it knows. Default: from the request.
 *   SHIPHOLM_REQUIRE_SIGNIN  "true" to require a session for everything but sign-in and health
 */
import { createHash } from 'node:crypto';

const COOKIE = 'shipholm_session';
const PROTOCOL_VERSION = '2025-06-18';
const VALID_FOR_MS = 5 * 60 * 1000;

// What the browser may ask the API to do on the customer's behalf – deploying and watching apps.
export const TOOLS = new Set([
  'get_account',
  'list_apps',
  'get_app',
  'check_host',
  'create_app',
  'rebuild_app',
  'app_status',
  'build_log',
  'app_logs',
  'connect_github',
]);

class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function cookies(request) {
  const out = {};

  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');

    if (i > 0) {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }

  return out;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #16181d; --muted: #5b6170; --card: #fff; --line: #e3e5ea; --accent: #2457e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --fg: #eceef2; --muted: #9aa1b0; --card: #171a21; --line: #2a2f3a; --accent: #6d93ff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 420px; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 8px; } p { color: var(--muted); margin: 0 0 20px; }
  a.button { display: block; text-align: center; background: var(--accent); color: #fff; text-decoration: none;
             padding: 12px 16px; border-radius: 10px; font-weight: 600; }
  small { display: block; margin-top: 16px; color: var(--muted); }
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

export function createShipholm(env = process.env, fetchImpl = fetch) {
  const apiUrl = (env.SHIPHOLM_API_URL || 'https://api.shipholm.com').replace(/\/+$/, '');
  const requireSignin = env.SHIPHOLM_REQUIRE_SIGNIN === 'true';
  const sessions = new Map(); // sha256(token) -> { tenant, account, until }

  function publicUrl(request) {
    if (env.SHIPHOLM_PUBLIC_URL) {
      return env.SHIPHOLM_PUBLIC_URL.replace(/\/+$/, '');
    }

    return new URL(request.url).origin;
  }

  function secure(request) {
    return publicUrl(request).startsWith('https://');
  }

  function setCookie(request, value, maxAge) {
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
      secure(request) ? '; Secure' : ''
    }`;
  }

  async function post(body, token, session) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    if (session) {
      headers['Mcp-Session-Id'] = session;
    }

    let res;

    try {
      res = await fetchImpl(`${apiUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new ApiError('The Shipholm API is not reachable.');
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError('Your Shipholm session has expired. Please sign in again.', 401);
    }

    if (!res.ok && res.status !== 202) {
      throw new ApiError(`The Shipholm API answered HTTP ${res.status}.`);
    }

    const raw = await res.text();

    const events = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());

    const text = events.length ? events[events.length - 1] : raw.trim();

    return { session: res.headers.get('mcp-session-id'), message: text ? JSON.parse(text) : null };
  }

  async function callTool(token, tool, args = {}) {
    const init = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'shipholm-code', version: '1' },
        },
      },
      token,
    );

    if (!init.message?.result) {
      throw new ApiError('Could not start a session with the Shipholm API.');
    }

    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, init.session);

    const { message } = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
      token,
      init.session,
    );

    if (!message) {
      throw new ApiError('The Shipholm API sent an empty answer.');
    }

    if (message.error) {
      throw new ApiError(String(message.error.message || 'API error'), 400);
    }

    const result = message.result || {};

    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (result.isError) {
      throw new ApiError(text || 'The tool failed.', 400);
    }

    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  // The signed-in customer, or null. Checked against the API, remembered for a few minutes.
  async function whoami(request) {
    const token = cookies(request)[COOKIE];

    if (!token || !token.startsWith('abs_')) {
      return null;
    }

    const key = createHash('sha256').update(token).digest('hex');
    const known = sessions.get(key);

    if (known && known.until > Date.now()) {
      return { token, ...known };
    }

    try {
      const info = await callTool(token, 'get_account');
      const entry = { tenant: info.tenant, account: info.account || null, until: Date.now() + VALID_FOR_MS };

      if (sessions.size > 1000) {
        sessions.clear();
      }

      sessions.set(key, entry);

      return { token, ...entry };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        sessions.delete(key);
        return null;
      }

      throw error;
    }
  }

  function sameOrigin(request) {
    const origin = request.headers.get('origin');
    return !origin || origin === new URL(request.url).origin || origin === publicUrl(request);
  }

  async function login(request) {
    const target = `${apiUrl}/account/login?return=${encodeURIComponent(`${publicUrl(request)}/auth/callback`)}`;
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
  }

  async function callback(request) {
    const code = new URL(request.url).searchParams.get('code') || '';

    const failed = (why) =>
      page(
        'Could not sign in',
        `<h1>Could not sign in</h1><p>${esc(why)}</p><a class="button" href="/auth/login">Try again</a>`,
        400,
      );

    if (!code) {
      return failed('The sign-in link is incomplete.');
    }

    let res;

    try {
      res = await fetchImpl(`${apiUrl}/account/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      return failed('The Shipholm API is not reachable.');
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok || typeof data.session !== 'string') {
      return failed(data.error || 'The sign-in code was not accepted.');
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': setCookie(request, data.session, Number(data.expires_in) || 7 * 24 * 3600),
        'Cache-Control': 'no-store',
      },
    });
  }

  function signinPage() {
    return page(
      'Sign in – Shipholm Code',
      `<h1>Shipholm Code</h1>
<p>Describe an app and watch it being built – then deploy it to Shipholm with one click.</p>
<a class="button" href="/auth/login">Sign in with GitHub</a>
<small>Sign-in goes through your Shipholm account. New here? Signing in creates one.</small>`,
      401,
    );
  }

  /*
   * Handles the request if it is ours (or must be refused); otherwise returns null and the
   * request goes on to the app.
   */
  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/auth/login' && request.method === 'GET') {
        return await login(request);
      }

      if (path === '/auth/callback' && request.method === 'GET') {
        return await callback(request);
      }

      if (path === '/auth/logout') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405);
        }

        if (!sameOrigin(request)) {
          return json({ error: 'origin not allowed' }, 403);
        }

        const headers = { 'Set-Cookie': setCookie(request, '', 0) };

        return request.method === 'GET'
          ? new Response(null, { status: 302, headers: { ...headers, Location: '/' } })
          : json({ ok: true }, 200, headers);
      }

      if (path === '/api/health') {
        return null;
      }

      if (path === '/api/shipholm/me') {
        const me = await whoami(request);
        return json({
          enabled: true,
          requireSignin,
          signedIn: Boolean(me),
          tenant: me?.tenant || null,
          account: me?.account || null,
        });
      }

      if (path === '/api/shipholm/tool') {
        if (request.method !== 'POST') {
          return json({ error: 'method not allowed' }, 405);
        }

        if (!sameOrigin(request)) {
          return json({ error: 'origin not allowed' }, 403);
        }

        const me = await whoami(request);

        if (!me) {
          return json({ error: 'Sign in with Shipholm first.', signin: '/auth/login' }, 401);
        }

        const body = await request.json().catch(() => null);
        const tool = body?.tool;
        const args = body?.arguments && typeof body.arguments === 'object' ? body.arguments : {};

        if (!TOOLS.has(tool)) {
          return json({ error: `The tool "${String(tool)}" is not available here.` }, 400);
        }

        delete args.tenant; // always the signed-in customer's own tenant

        return json(await callTool(me.token, tool, args));
      }

      if (!requireSignin) {
        return null;
      }

      if (await whoami(request)) {
        return null;
      }

      const wantsPage = request.method === 'GET' && !path.startsWith('/api/');

      return wantsPage ? signinPage() : json({ error: 'Sign in with Shipholm first.', signin: '/auth/login' }, 401);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;

      if (!(error instanceof ApiError)) {
        console.error(error);
      }

      return json({ error: error instanceof ApiError ? error.message : 'Internal error' }, status);
    }
  }

  return { handle, callTool, whoami, apiUrl, requireSignin };
}
