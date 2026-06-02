#!/usr/bin/env node
/**
 * proxy-server.js — Lightweight residential HTTP/HTTPS proxy
 *
 * Run this on your HOME PC (residential IP) so Diploi can tunnel
 * iptvv.ca requests through it and bypass Cloudflare datacenter blocks.
 *
 * Usage:
 *   node proxy-server.js
 *
 * Then set in Diploi env:
 *   PROXY_URL=http://YOUR_HOME_IP:8877
 *   PROXY_SECRET=<same secret as below>
 */

'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const { URL } = require('url');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT          = +(process.env.PROXY_PORT   || 3001);
const PROXY_SECRET  =   process.env.PROXY_SECRET || '6afac4085bd2325ef5b6d3f7291443e8753c45842361767865be9ad356a932ba';   // set this!
const BIND          =   process.env.PROXY_BIND   || '0.0.0.0';

// Allow all hosts — this proxy is private/server-side only
const ALLOWED_HOSTS = [];

if (!PROXY_SECRET) {
  console.warn('[WARN] PROXY_SECRET not set — proxy is OPEN to anyone who knows the port!');
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  if (!PROXY_SECRET) return true;
  const auth = req.headers['proxy-authorization'] || req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').replace(/^Basic\s+.*/i, '');
  // Support both "Bearer <secret>" and "Proxy-Authorization: <secret>" directly
  return auth === PROXY_SECRET || token === PROXY_SECRET;
}

// ─── HOST WHITELIST CHECK ─────────────────────────────────────────────────────
function isAllowed(hostname) {
  if (!ALLOWED_HOSTS.length) return true;
  return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

// ─── HTTP PROXY (plain HTTP requests) ────────────────────────────────────────
function handleHttp(clientReq, clientRes) {
  // ── Status page — so you can verify it's alive in a browser ──────────────
  if (clientReq.url === '/' || clientReq.url === '/status') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({
      status : 'ok',
      proxy  : 'residential-proxy',
      auth   : !!PROXY_SECRET,
      ts     : Date.now(),
    }));
  }

  if (!isAuthorized(clientReq)) {
    clientRes.writeHead(407, { 'Proxy-Authenticate': 'Bearer realm="proxy"' });
    return clientRes.end('Proxy auth required');
  }

  let targetUrl;
  try {
    targetUrl = new URL(clientReq.url);
  } catch {
    clientRes.writeHead(400);
    return clientRes.end('Bad URL');
  }

  if (!isAllowed(targetUrl.hostname)) {
    clientRes.writeHead(403);
    return clientRes.end(`Host not allowed: ${targetUrl.hostname}`);
  }

  // Strip proxy-only headers
  const headers = { ...clientReq.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  headers['connection'] = 'close';

  const lib = targetUrl.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname : targetUrl.hostname,
    port     : targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path     : targetUrl.pathname + targetUrl.search,
    method   : clientReq.method,
    headers,
    rejectUnauthorized: false,
  }, upRes => {
    clientRes.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(clientRes);
    upRes.on('error', () => clientRes.end());
  });

  upReq.on('error', err => {
    console.error(`[HTTP] upstream error: ${err.message}`);
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`Upstream error: ${err.message}`);
  });

  clientReq.pipe(upReq);
}

// ─── HTTPS TUNNEL (CONNECT method) ────────────────────────────────────────────
function handleConnect(req, clientSocket, head) {
  if (!isAuthorized(req)) {
    clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Bearer realm="proxy"\r\n\r\n');
    return clientSocket.destroy();
  }

  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr) || 443;

  if (!isAllowed(hostname)) {
    clientSocket.write(`HTTP/1.1 403 Forbidden\r\n\r\nHost not allowed: ${hostname}`);
    return clientSocket.destroy();
  }

  const serverSocket = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', err => {
    console.error(`[CONNECT] ${hostname}:${port} — ${err.message}`);
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    clientSocket.destroy();
  });

  clientSocket.on('error', () => serverSocket.destroy());
  serverSocket.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => serverSocket.destroy());
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(handleHttp);
server.on('connect', handleConnect);

server.on('error', err => {
  console.error('[PROXY] Server error:', err.message);
});

server.listen(PORT, BIND, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Residential HTTP/S Proxy — ready               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Listening : ${BIND}:${PORT}`.padEnd(51) + '║');
  console.log(`║   Auth      : ${PROXY_SECRET ? 'enabled ✅' : 'DISABLED ⚠️ '}`.padEnd(51) + '║');
  console.log(`║   Whitelist : ${ALLOWED_HOSTS.length ? ALLOWED_HOSTS.join(', ') : 'all hosts'}`.padEnd(51) + '║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║   Set in Diploi env:                             ║');
  console.log(`║   PROXY_URL=http://YOUR_IP:${PORT}`.padEnd(51) + '║');
  console.log(`║   PROXY_SECRET=<your secret>`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
});
