// Tor for Claude Code: an MCP server with tools that fetch pages through Tor (including .onion sites)
// and open pages in your Tor Browser. No dependencies: a small SOCKS5 client over node:net.
//
// Tor itself comes from Tor Browser: its SOCKS port (9150) while it's open, or Reroute starts the
// tor.exe bundled with it in the background on its own port. A system tor service (9050) works too.

import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const OWN_PORT = 9159;

export function torBrowserPaths() {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Desktop', 'Tor Browser'),
    path.join(home, 'OneDrive', 'Desktop', 'Tor Browser'),
    path.join(process.env.LOCALAPPDATA || '', 'Tor Browser'),
    path.join(process.env.APPDATA || '', 'Tor Browser'),
    'C:\\Program Files\\Tor Browser',
    '/Applications/Tor Browser.app',
    path.join(home, '.local', 'share', 'torbrowser', 'tbb', 'x86_64', 'tor-browser'),
    path.join(home, 'tor-browser'),
  ];
  for (const r of roots) {
    const win = path.join(r, 'Browser', 'firefox.exe');
    if (fs.existsSync(win)) return { browser: win, tor: path.join(r, 'Browser', 'TorBrowser', 'Tor', 'tor.exe') };
    const mac = path.join(r, 'Contents', 'MacOS', 'firefox');
    if (fs.existsSync(mac)) return { browser: mac, tor: path.join(r, 'Contents', 'MacOS', 'Tor', 'tor') };
    const lin = path.join(r, 'Browser', 'start-tor-browser');
    if (fs.existsSync(lin)) return { browser: lin, tor: path.join(r, 'Browser', 'TorBrowser', 'Tor', 'tor') };
  }
  return null;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(700);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });
}

let started = null;
let bootLog = '';

// Finds a working Tor SOCKS port, starting the bundled tor.exe if needed. Returns the port.
export async function ensureTor({ start = true } = {}) {
  for (const p of [9150, 9050, OWN_PORT]) if (await portOpen(p)) return p;
  if (!start) return null;
  const tb = torBrowserPaths();
  if (!tb || !fs.existsSync(tb.tor)) {
    throw new Error('Tor is not running and Tor Browser was not found. Install Tor Browser from https://www.torproject.org, or open it, then try again.');
  }
  if (!started) {
    const dataDir = path.join(os.homedir(), '.reroute', 'tor-data');
    fs.mkdirSync(dataDir, { recursive: true });
    started = spawn(tb.tor, ['--SocksPort', String(OWN_PORT), '--DataDirectory', dataDir, '--ControlPort', '0', '--Log', 'notice stdout'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    bootLog = '';
    started.stdout.on('data', (d) => (bootLog += d));
    started.on('exit', () => (started = null));
  }
  // Wait for Tor to build its first circuit (usually 5-30 seconds).
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (/Bootstrapped 100%/.test(bootLog) && (await portOpen(OWN_PORT))) return OWN_PORT;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Tor did not finish connecting within 90 seconds. Your network may block Tor; try opening Tor Browser and using a bridge.');
}

export function stopOwnTor() {
  if (started) started.kill();
}

function socksConnect(socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    s.setTimeout(60_000, () => s.destroy(new Error('Tor connection timed out')));
    let stage = 0;
    s.once('error', reject);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    const onData = (buf) => {
      if (stage === 0) {
        if (buf[0] !== 5 || buf[1] !== 0) return reject(new Error('Tor SOCKS handshake failed'));
        stage = 1;
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      } else {
        s.removeListener('data', onData);
        if (buf[1] !== 0) {
          const why = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired' }[buf[1]] || `code ${buf[1]}`;
          return reject(new Error(`Tor couldn't reach ${host}: ${why}`));
        }
        s.setTimeout(0);
        resolve(s);
      }
    };
    s.on('data', onData);
  });
}

function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString(), 16);
    if (!size) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

// GET a URL through Tor. Follows up to 5 redirects. Returns { status, headers, body (string), url }.
export async function torFetch(url, { socksPort, redirects = 5, maxBytes = 5_000_000 } = {}) {
  const port = socksPort || (await ensureTor());
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https URLs are supported');
  const secure = u.protocol === 'https:';
  let sock = await socksConnect(port, u.hostname, Number(u.port) || (secure ? 443 : 80));
  if (secure) sock = tls.connect({ socket: sock, servername: u.hostname.endsWith('.onion') ? undefined : u.hostname, ALPNProtocols: ['http/1.1'] });
  const req =
    `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
    // Same User-Agent as Tor Browser, so pages don't single this client out.
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0\r\n' +
    'Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8\r\nAccept-Language: en-US,en;q=0.5\r\n' +
    'Accept-Encoding: gzip, deflate\r\nConnection: close\r\n\r\n';
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    sock.setTimeout(90_000, () => sock.destroy(new Error('the page took too long to load over Tor')));
    sock.once('error', reject);
    sock.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) return sock.destroy(new Error('page is too large'));
      chunks.push(d);
    });
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('close', () => resolve(Buffer.concat(chunks)));
    sock.write(req);
  });
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = {};
  for (const l of head.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  let body = raw.slice(split + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = decodeChunked(body);
  if (/gzip/i.test(headers['content-encoding'] || '')) body = zlib.gunzipSync(body);
  else if (/deflate/i.test(headers['content-encoding'] || '')) body = zlib.inflateSync(body);
  if (status >= 300 && status < 400 && headers.location && redirects > 0) {
    return torFetch(new URL(headers.location, u).toString(), { socksPort: port, redirects: redirects - 1, maxBytes });
  }
  return { status, headers, body: body.toString('utf8'), url: u.toString() };
}

// Readable text from HTML: drops scripts/styles, keeps link targets, collapses whitespace.
export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim();
  return (title ? `Title: ${title}\n\n` : '') + html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => `${t.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

export function openInTorBrowser(url) {
  const tb = torBrowserPaths();
  if (!tb) throw new Error('Tor Browser was not found. Install it from https://www.torproject.org.');
  if (url) new URL(url);
  const child = spawn(tb.browser, url ? [url] : [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return tb.browser;
}

// ---------------------------------------------------------------------------
// MCP server over stdio (JSON-RPC 2.0, one message per line).

const TOOLS = [
  {
    name: 'tor_fetch',
    description:
      'Fetch a web page through the Tor network and return its readable text (or raw HTML/JSON). Works for normal sites and .onion addresses. Use when the user asks to browse anonymously, over Tor, or to open an .onion site.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL, including .onion addresses' },
        raw: { type: 'boolean', description: 'Return the raw response body instead of readable text' },
        max_chars: { type: 'number', description: 'Maximum characters to return (default 20000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tor_check',
    description: 'Check that requests are going through Tor, and show the exit IP address the internet sees.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tor_open_browser',
    description: "Open a URL in the user's Tor Browser, so they can see and use the page themselves.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
];

async function callTool(name, args = {}) {
  if (name === 'tor_fetch') {
    const r = await torFetch(args.url);
    const type = r.headers['content-type'] || '';
    let text = args.raw || !/html/i.test(type) ? r.body : htmlToText(r.body);
    const max = Math.max(500, Math.min(Number(args.max_chars) || 20000, 200000));
    if (text.length > max) text = text.slice(0, max) + `\n\n[cut at ${max} characters of ${text.length}]`;
    return `HTTP ${r.status} · ${r.url} (via Tor)\n\n${text}`;
  }
  if (name === 'tor_check') {
    const r = await torFetch('https://check.torproject.org/api/ip');
    const j = JSON.parse(r.body);
    return j.IsTor ? `Connected through Tor. Exit IP: ${j.IP}` : `Warning: NOT going through Tor (IP ${j.IP}).`;
  }
  if (name === 'tor_open_browser') {
    const exe = openInTorBrowser(args.url);
    return `Opened ${args.url || 'Tor Browser'} in Tor Browser (${exe}).`;
  }
  throw new Error(`unknown tool ${name}`);
}

export function runMcpServer(version = '0') {
  let buf = '';
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const { id, method, params } = msg;
      if (id === undefined) continue; // notifications
      try {
        if (method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params?.protocolVersion || '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'reroute-tor', version },
              instructions: 'Tools for browsing through Tor. Only use them when the user wants Tor, anonymity, or an .onion site.',
            },
          });
        } else if (method === 'tools/list') {
          send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        } else if (method === 'tools/call') {
          try {
            const text = await callTool(params.name, params.arguments);
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
          } catch (e) {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
          }
        } else if (method === 'ping') {
          send({ jsonrpc: '2.0', id, result: {} });
        } else {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        }
      } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
      }
    }
  });
  process.stdin.on('end', () => {
    stopOwnTor();
    process.exit(0);
  });
}
