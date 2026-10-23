// A small static server that behaves like a Cloudflare Worker serving static assets, for the dev server and the smoke tests.
//  - the URL path maps straight onto the root folder (so an app served at /snake/ lives in <root>/snake/);
//  - headers come from <root>/_headers (an unindented line is a path pattern, the indented lines under it are headers);
//  - "auto-trailing-slash": /snake redirects to /snake/ when snake/index.html exists;
//  - a missing path gets the nearest 404.html found walking up its folders, with a 404 status.
//  - text files (HTML, CSS, JS, SVG, JSON, text, Markdown) are compressed like Cloudflare does for visitors: Brotli when the browser
//    accepts it, else gzip, with Vary: Accept-Encoding. Fonts and images are sent as they are. Cloudflare's own Brotli level is not
//    known, so sizes here are an approximation (level 5), but a smaller file here is a smaller download there, which is what the
//    Lighthouse budgets rely on (tools/lighthouse.ts).
// Differences from Cloudflare: Cache-Control is always no-store so edits show up on reload, and the HSTS and
// Cross-Origin-Opener-Policy headers are left out because browsers ignore them over plain http.

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build } from './build.ts';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const compressible = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt', '.md']);
// Sends body with its content type, compressed when the type is text and the browser accepts Brotli or gzip.
function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  type: string,
  ext: string,
  body: Buffer,
) {
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = !compressible.has(ext) ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const out =
    enc === 'br'
      ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : enc === 'gzip'
        ? gzipSync(body, { level: 6 })
        : body;
  res.writeHead(status, {
    ...headers,
    'Content-Type': type,
    ...(compressible.has(ext) ? { Vary: 'Accept-Encoding' } : {}),
    ...(enc ? { 'Content-Encoding': enc } : {}),
    'Content-Length': out.length,
  });
  res.end(out);
}
// The TCP port a listening server got (a port of 0 asks the system to pick one).
export function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the server is not listening on a TCP port');
  return address.port;
}
const skipped = new Set(['strict-transport-security', 'cross-origin-opener-policy']);
const exists = (f: string) =>
  readFile(f).then(
    () => true,
    () => false,
  );
const matches = (pattern: string, path: string) =>
  pattern === '/*' || (pattern.endsWith('/*') && path.startsWith(pattern.slice(0, -1))) || pattern === path;

export async function startAssetServer({ root, port = 0, host = '127.0.0.1' }: { root: string; port?: number; host?: string }) {
  build(); // public/js is compiled from src/, not committed
  root = root.endsWith(sep) ? root : root + sep;
  const rules: { pattern: string; headers: Record<string, string> }[] = [];
  for (const line of (await readFile(join(root, '_headers'), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) rules.push({ pattern: line.trim(), headers: {} });
    else {
      const i = line.indexOf(':');
      const rule = rules.at(-1);
      if (!rule) throw new Error(`${root}_headers: a header line comes before any path pattern`);
      rule.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const headersFor = (path: string) => {
    const out: Record<string, string> = {};
    for (const r of rules) {
      if (!matches(r.pattern, path)) continue;
      for (const [k, v] of Object.entries(r.headers)) {
        if (skipped.has(k.toLowerCase())) continue;
        out[k] = v;
      }
    }
    out['Cache-Control'] = 'no-store';
    return out;
  };

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      send(req, res, 200, headersFor(path), types[extname(file)] ?? 'application/octet-stream', extname(file), body);
    } catch {
      if (!path.endsWith('/') && (await exists(join(root, path, 'index.html')))) {
        res.writeHead(307, { Location: `${path}/` }).end();
        return;
      }
      for (
        let dir = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
        ;
        dir = dir.slice(0, dir.slice(0, -1).lastIndexOf('/') + 1)
      ) {
        const page = join(root, dir, '404.html');
        if (await exists(page)) {
          send(req, res, 404, headersFor(path), types['.html'] ?? 'text/html', '.html', await readFile(page));
          return;
        }
        if (dir === '/' || dir === '') break;
      }
      res.writeHead(404, headersFor(path)).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, port: portOf(server) };
}
