// The Access check (docs/setup.md): one verifier per isolate for the configured team and application, so the signing keys are fetched
// about once an hour and not on every request, and one way of refusing. The verifier itself is in access.ts. Free of Worker-only
// globals, so Node tests it. Only erasable TypeScript syntax.
import { ACCESS_HEADER, type AccessIdentity, type AccessVerifier, createAccessVerifier } from './access.ts';

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

let cached: { key: string; verifier: AccessVerifier } | undefined;

export function verifierFor(env: AccessEnv): AccessVerifier {
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (cached?.key !== key) {
    cached = { key, verifier: createAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }) };
  }
  return cached.verifier;
}

// The reason goes to the log, not to the visitor.
export function deny(reason: string): Response {
  console.warn(`access denied: ${reason}`);
  return new Response('Forbidden\n', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Who is calling, or the response that refuses them. `verifier` is for tests and the local dev server, which stand in for Access.
export async function requireAccess(
  request: Request,
  env: AccessEnv,
  verifier: AccessVerifier = verifierFor(env),
): Promise<{ ok: true; identity: AccessIdentity } | { ok: false; response: Response }> {
  const result = await verifier.verify(request.headers.get(ACCESS_HEADER));
  return result.ok ? { ok: true, identity: result.identity } : { ok: false, response: deny(result.reason) };
}
