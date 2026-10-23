// The request handling of the cure tracker, as production runs it and the tests and dev server call it. Every request needs the
// Access token. /api is the JSON API (api.ts), /admin and /api/admin are for admins, and anything else is a static file from the
// assets binding. Free of Worker-only globals. Only erasable TypeScript syntax.
import type { AccessVerifier } from './access.ts';
import { type AccessEnv, requireAccess } from './access-gate.ts';
import { handleApi } from './api.ts';
import type { Db } from './db.ts';

export interface AppEnv extends AccessEnv {
  // Comma-separated emails that get the admin pages.
  ADMIN_EMAILS: string;
  DB: Db;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export interface Deps {
  // For tests and the dev server, which stand in for Access.
  verifier?: AccessVerifier;
  now?: () => Date;
}

export const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function handle(request: Request, env: AppEnv, deps: Deps = {}): Promise<Response> {
  const access = await requireAccess(request, env, deps.verifier);
  if (!access.ok) return access.response;
  const email = access.identity.email?.toLowerCase() ?? null;
  // A service token has no email, so no volunteer to be.
  if (email === null) return text(403, 'Forbidden');
  const admins = env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
  const isAdmin = admins.includes(email);
  const path = new URL(request.url).pathname;

  if (path === '/api' || path.startsWith('/api/')) {
    return handleApi(request, { db: env.DB, email, isAdmin, now: deps.now ?? (() => new Date()) });
  }
  if ((path === '/admin' || path.startsWith('/admin/')) && !isAdmin) return text(403, 'Forbidden');
  return env.ASSETS.fetch(request);
}
