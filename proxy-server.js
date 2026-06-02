#!/usr/bin/env node
/**
 * relay-server.js — HTTP relay proxy (works behind any reverse proxy/platform)
 *
 * Instead of CONNECT tunneling (which gets blocked by hosting platforms),
 * this exposes a simple POST /relay endpoint that iptv-gen.js calls directly.
 * The relay fetches the target URL server-side and returns the response as JSON.
 *
 * Usage:
 *   PROXY_SECRET=yoursecret node relay-server.js
 *
 * Set in Diploi env:
 *   PROXY_URL=https://your-proxy-domain.com
 *   PROXY_SECRET=yoursecret
 */

'use strict';

const http = require('http');
const { URL } = require('url');

const PORT         = +(process.env.PROXY_PORT   || 3001);
const PROXY_SECRET =   process.env.PROXY_SECRET || '6afac4085bd2325ef5b6d3f7291443e8753c45842361767865be9ad356a932ba';
const BIND         =   process.env.PROXY_BIND   || '0.0.0.0';

if (!PROXY_SECRET) console.warn('[WARN] PROXY_SECRET not set — relay is open!');

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  if (!PROXY_SECRET) return true;
  const auth = req.headers['authorization'] || req.headers['x-proxy-secret'] || '';
  if (auth === PROXY_SECRET) return true;
  if (auth.startsWith('Bearer ') && auth.slice(7) === PROXY_SECRET) return true;
  return false;
}

// ─── BODY READER ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  // ── GET / or /status — health check (no auth) ─────────────────────────────
  if (pathname === '/' || pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      proxy:  'residential-relay',
      auth:   !!PROXY_SECRET,
      ts:     Date.now(),
    }));
  }

  // ── POST /relay — forward any HTTP/S request ──────────────────────────────
  // Request body (JSON):
  //   { url, method, headers, body (base64, optional), redirect }
  // Response (JSON):
  //   { status, headers, body (base64), url }
  if (req.method === 'POST' && pathname === '/relay') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    let params;
    try {
      const raw = await readBody(req);
      params = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400);
      return res.end('Bad JSON');
    }

    const { url, method = 'GET', headers = {}, body, redirect = 'manual' } = params;
    if (!url) { res.writeHead(400); return res.end('Missing url'); }

    // Drop hop-by-hop headers
    const fwdHeaders = { ...headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['connection'];
    delete fwdHeaders['transfer-encoding'];

    try {
      const upRes  = await fetch(url, {
        method,
        headers: fwdHeaders,
        body:    body ? Buffer.from(body, 'base64') : undefined,
        redirect,
      });

      const upBody = Buffer.from(await upRes.arrayBuffer());
      const upHdrs = {};
      upRes.headers.forEach((v, k) => { upHdrs[k] = v; });

      // Preserve all Set-Cookie headers (forEach collapses them)
      if (upRes.headers.getSetCookie) {
        const cookies = upRes.headers.getSetCookie();
        if (cookies.length) upHdrs['set-cookie'] = cookies;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:  upRes.status,
        headers: upHdrs,
        body:    upBody.toString('base64'),
        url:     upRes.url || url,
      }));

      console.log(`[RELAY] ${method} ${url} → ${upRes.status}`);
    } catch (e) {
      console.error(`[RELAY] error: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, BIND, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Residential Relay Proxy — ready                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Listening  : ${BIND}:${PORT}`.padEnd(51) + '║');
  console.log(`║   Auth       : ${PROXY_SECRET ? 'enabled ✅' : 'DISABLED ⚠️ '}`.padEnd(51) + '║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║   Set in Diploi env:                             ║');
  console.log('║   PROXY_URL=https://your-domain.com'.padEnd(51)  + '║');
  console.log('║   PROXY_SECRET=<your secret>'.padEnd(51)         + '║');
  console.log('╚══════════════════════════════════════════════════╝');
});
