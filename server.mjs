/*
 * Runs the production build on plain Node – for hosting outside Cloudflare (Shipholm, Docker).
 *
 *   pnpm run build && node server.mjs            # PORT (default 5173), HOST (default 0.0.0.0)
 *
 * The build is a Cloudflare Worker (build/server/index.js, `fetch(request, env, ctx)`) plus static
 * assets (build/client). This serves the assets itself and hands everything else to the worker,
 * with process.env as the worker's `env` – so API keys come from ordinary environment variables.
 * Unlike `vite preview` it loads no Vite config and writes nothing to disk, so it runs as a
 * non-root user on a read-only filesystem.
 *
 * Shipholm sign-in and deploys: see shipholm.mjs.
 *
 * Client IP (rate limits): the worker trusts `cf-connecting-ip`. Any such header from the client is
 * dropped and replaced with the socket address, or – behind a proxy that overwrites it, such as
 * Traefik on Shipholm – with the header named in CLIENT_IP_HEADER (e.g. x-real-ip).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createShipholm } from './shipholm.mjs';

const root = fileURLToPath(new URL('./build/', import.meta.url));
const clientDir = join(root, 'client');
const { default: worker } = await import(new URL('./build/server/index.js', import.meta.url));
const shipholm = createShipholm(process.env);

const port = Number(process.env.PORT || 5173);
const clientIpHeader = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
const host = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// The document is cross-origin isolated (WebContainer); same-origin assets need nothing extra.
const ISOLATION = { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' };

async function staticFile(pathname) {
  let rel;

  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return null;
  }

  const file = join(clientDir, rel);

  if (!rel || !file.startsWith(clientDir + sep)) {
    return null;
  }

  try {
    const info = await stat(file);
    return info.isFile() ? { file, size: info.size } : null;
  } catch {
    return null;
  }
}

function toRequest(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || 'http';
  const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'cf-connecting-ip') {
      continue;
    }

    if (Array.isArray(v)) {
      v.forEach((x) => headers.append(k, x));
    } else if (v !== undefined) {
      headers.set(k, v);
    }
  }

  const forwarded = clientIpHeader ? req.headers[clientIpHeader] : undefined;

  const clientIp =
    typeof forwarded === 'string' && forwarded.trim()
      ? forwarded.trim()
      : req.socket.remoteAddress?.replace(/^::ffff:/, '');

  if (clientIp) {
    headers.set('cf-connecting-ip', clientIp);
  }

  const controller = new AbortController();
  req.on('close', () => !req.complete && controller.abort());

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
    signal: controller.signal,
  });
}

async function send(res, response) {
  const headers = {};

  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') {
      headers[k] = v;
    }
  });

  const cookies = response.headers.getSetCookie?.() || [];

  if (cookies.length) {
    headers['set-cookie'] = cookies;
  }

  res.writeHead(response.status, response.statusText, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body);
  res.on('close', () => body.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}

const ctx = { waitUntil: (p) => Promise.resolve(p).catch(console.error), passThroughOnException() {} };

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname !== '/') {
      const asset = await staticFile(pathname);

      if (asset) {
        const immutable = pathname.startsWith('/assets/');
        res.writeHead(200, {
          'Content-Type': TYPES[extname(asset.file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': asset.size,
          'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
          ...ISOLATION,
        });

        if (req.method === 'HEAD') {
          res.end();
        } else {
          createReadStream(asset.file).pipe(res);
        }

        return;
      }
    }

    const request = toRequest(req);
    const answer = await shipholm.handle(request);

    await send(res, answer || (await worker.fetch(request, process.env, ctx)));
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }

    res.end('Internal Server Error');
  }
}).listen(port, host, () => console.log(`bolt listening on http://${host}:${port}`));
