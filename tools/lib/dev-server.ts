// The cure tracker as production serves it, for the dev server, the smoke tests and Lighthouse: the Worker's own request handling
// (worker/app.ts) in front of the static files (tools/lib/asset-server.ts), on a SQLite database filled with synthetic people through
// the real upload path. Access is stood in for by a verifier that reads the signed-in email from a cookie (visit /__as?email=you@example.com),
// which exists only here.
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AccessVerifier } from '../../worker/access.ts';
import { type AppEnv, handle } from '../../worker/app.ts';
import { applyUpload } from '../../worker/uploads.ts';
import { portOf, startAssetServer } from './asset-server.ts';
import { sheetCsv, syntheticPeople } from './sheet.ts';
import { migratedDb, sqliteD1 } from './sqlite-d1.ts';

export const DEV_ADMIN = 'admin@example.com';
export const DEV_VOLUNTEER = 'volunteer@example.com';

const cookieUser = (header: string | null): string | null => /(?:^|;\s*)dev_user=([^;]+)/.exec(header ?? '')?.[1] ?? null;

export async function startDevServer({
  port = 0,
  host = '127.0.0.1',
  people = 40,
  defaultUser = DEV_VOLUNTEER,
  named = false,
}: {
  port?: number;
  host?: string;
  people?: number;
  defaultUser?: string;
  // Give the two dev users a name, so their first visit goes straight to the pages.
  named?: boolean;
} = {}) {
  const assets = await startAssetServer({ root: fileURLToPath(new URL('../../public/', import.meta.url)) });
  const sqlite = migratedDb();
  const db = sqliteD1(sqlite);
  if (people > 0) {
    await applyUpload(db, sheetCsv(syntheticPeople(people)), {
      now: new Date().toISOString(),
      actor: 'seed@example.com',
      filename: 'seed.csv',
      force: true,
    });
  }

  if (named) {
    for (const [email, who] of [
      [DEV_VOLUNTEER, 'Vera Volunteer'],
      [DEV_ADMIN, 'Ada Admin'],
    ] as const) {
      await db
        .prepare('INSERT INTO volunteers (email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .bind(email, who, new Date().toISOString(), new Date().toISOString())
        .run();
    }
  }

  // The assets binding: ask the static server and hand back its answer as it is, compression and all.
  const ASSETS: AppEnv['ASSETS'] = {
    fetch: (req) =>
      new Promise((resolve, reject) => {
        const url = new URL(req.url);
        const up = httpRequest(
          {
            host: '127.0.0.1',
            port: assets.port,
            path: url.pathname + url.search,
            method: req.method,
            headers: Object.fromEntries(req.headers),
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => {
              const headers = new Headers();
              for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
              resolve(new Response(Buffer.concat(chunks), { status: r.statusCode ?? 502, headers }));
            });
          },
        );
        up.on('error', reject);
        up.end();
      }),
  };
  const env: AppEnv = {
    ACCESS_TEAM_DOMAIN: 'dev.example',
    ACCESS_AUD: 'dev',
    ADMIN_EMAILS: DEV_ADMIN,
    ALLOW_RESET: 'true',
    DB: db,
    ASSETS,
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      if (url.pathname === '/__as') {
        const email = url.searchParams.get('email') ?? defaultUser;
        res.writeHead(303, { 'Set-Cookie': `dev_user=${encodeURIComponent(email)}; Path=/; SameSite=Strict`, Location: '/' }).end();
        return;
      }
      const email = decodeURIComponent(cookieUser(headers.get('cookie')) ?? defaultUser);
      const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email, serviceToken: null, sub: email } }) };
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await handle(
        new Request(url, { method: req.method ?? 'GET', headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }),
        env,
        { verifier },
      );
      const out = Object.fromEntries(response.headers);
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const close = () => {
    server.close();
    assets.server.close();
  };
  return { server: { close }, port: portOf(server), sqlite, db };
}
