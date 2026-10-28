// The request handling of the cure tracker, as production runs it and the tests and dev server call it. Every request needs the
// Access token. /api is the JSON API (api.ts), /admin and /api/admin are for admins, and anything else is a static file from the
// assets binding. Free of Worker-only globals. Only erasable TypeScript syntax.
import type { AccessVerifier } from './access.ts';
import { type AccessEnv, requireAccess } from './access-gate.ts';
import { handleApi } from './api.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mail.ts';
import { organizesAnything } from './organizers.ts';
import { serveTiles, TILES_PATH, type TileBucket, tilesReady } from './tiles.ts';

export interface AppEnv extends AccessEnv {
  // Comma-separated emails that get the admin pages: a Worker secret (wrangler secret put ADMIN_EMAILS). Missing means no admins.
  ADMIN_EMAILS: string | undefined;
  // "true" lets admins reset (delete every voter). Anything else turns the reset off.
  ALLOW_RESET: string;
  DB: Db;
  // The R2 bucket that holds the map's tiles (docs/setup.md). Without it the map file answers 404 and the map draws only the pins.
  TILES?: TileBucket;
  // The `send_email` binding (wrangler.jsonc, docs/setup.md). Without it nothing is emailed and assigning still works.
  EMAIL?: Mailer | undefined;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export interface Deps {
  // For tests and the dev server, which stand in for Access.
  verifier?: AccessVerifier;
  now?: () => Date;
  // How the Worker reaches other services (the Census geocoder): the global fetch, or a test's own.
  fetcher?: typeof fetch;
}

export const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function handle(request: Request, env: AppEnv, deps: Deps = {}): Promise<Response> {
  const access = await requireAccess(request, env, deps.verifier);
  if (!access.ok) return access.response;
  const email = access.identity.email?.toLowerCase() ?? null;
  // A service token has no email, so no volunteer to be.
  if (email === null) return text(403, 'Forbidden');
  const admins = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
  const isAdmin = admins.includes(email);
  const path = new URL(request.url).pathname;

  if (path === '/api' || path.startsWith('/api/')) {
    return handleApi(request, {
      db: env.DB,
      email,
      isAdmin,
      admins,
      allowReset: env.ALLOW_RESET === 'true',
      now: deps.now ?? (() => new Date()),
      fetcher: deps.fetcher ?? fetch,
      tilesReady: () => tilesReady(env.TILES),
      mailer: env.EMAIL,
    });
  }
  if (path === TILES_PATH) return serveTiles(request, env.TILES);
  // The admin pages are for site admins and for volunteers who organize some precincts (the API checks what each may do).
  if ((path === '/admin' || path.startsWith('/admin/')) && !isAdmin && !(await organizesAnything(env.DB, email)))
    return text(403, 'Forbidden');
  return env.ASSETS.fetch(request);
}
