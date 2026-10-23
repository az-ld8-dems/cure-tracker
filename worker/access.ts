// Checks the JWT that Cloudflare Access adds to every request it lets through (the Cf-Access-Jwt-Assertion header), so a Worker
// does not trust the network path alone: a request that skipped Access, or came through another Access application, is refused.
// The token is RS256, signed by a key published at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. We check the
// signature, the algorithm (only RS256), the issuer, the audience tag of this application, and the times. Web Crypto only.
// Only erasable TypeScript syntax (no enums or parameter properties), so Node runs this file as is in tests.
const te = new TextEncoder();
const td = new TextDecoder();

type FetchFn = typeof fetch;

export interface AccessConfig {
  // The team domain, like "example.cloudflareaccess.com", without a scheme.
  teamDomain: string;
  // The application's Audience (AUD) tag from the Access dashboard. Each Access application has its own.
  audience: string;
  // Optional second lock: when not empty, only these emails get in (case-insensitive). Service tokens have no email and are refused.
  allowedEmails?: readonly string[];
}

export interface AccessIdentity {
  // The user's email, or null for a service token.
  email: string | null;
  // The service token's name (common_name), or null for a user.
  serviceToken: string | null;
  sub: string;
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

export interface AccessVerifier {
  verify(token: string | null | undefined): Promise<AccessResult>;
}

export interface VerifierOptions {
  fetchFn?: FetchFn;
  // Seconds since the epoch; tests pass a fixed time.
  now?: () => number;
}

// Clock difference we forgive between Cloudflare and this Worker.
const LEEWAY = 60;
// Keys are kept for an hour. A token with a kid we do not know triggers one refetch, at most once a minute, so a rotated key
// is picked up at once but a flood of forged tokens cannot make us fetch the key set on every request.
const KEY_TTL = 3600;
const REFETCH_AFTER = 60;

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(part: string): Record<string, unknown> {
  const v: unknown = JSON.parse(td.decode(fromB64url(part)));
  if (!isObject(v)) throw new Error('not an object');
  return v;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createAccessVerifier(config: AccessConfig, options: VerifierOptions = {}): AccessVerifier {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const issuer = `https://${config.teamDomain}`;
  const allowed = (config.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== '');

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = Number.NEGATIVE_INFINITY;

  async function refresh(): Promise<void> {
    const res = await fetchFn(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`key set request failed: ${res.status}`);
    const body: unknown = await res.json();
    const list = isObject(body) && Array.isArray(body.keys) ? (body.keys as unknown[]) : [];
    const next = new Map<string, CryptoKey>();
    for (const jwk of list) {
      if (!isObject(jwk) || jwk.kty !== 'RSA') continue;
      const kid = str(jwk.kid);
      if (kid === null) continue;
      const key = await crypto.subtle
        .importKey(
          'jwk',
          { kty: 'RSA', n: String(jwk.n), e: String(jwk.e), alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        )
        .catch(() => null);
      if (key) next.set(kid, key);
    }
    if (next.size === 0) throw new Error('key set has no usable RSA keys');
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const age = now() - fetchedAt;
    if (age > KEY_TTL) await refresh();
    else if (!keys.has(kid) && age > REFETCH_AFTER) await refresh();
    return keys.get(kid) ?? null;
  }

  async function verify(token: string | null | undefined): Promise<AccessResult> {
    if (!config.teamDomain || !config.audience) return { ok: false, reason: 'Access is not configured' };
    if (!token) return { ok: false, reason: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
    const [head, body, sig] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = parseJson(head);
      claims = parseJson(body);
      signature = fromB64url(sig);
    } catch {
      return { ok: false, reason: 'malformed token' };
    }
    if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected algorithm' };
    const kid = str(header.kid);
    if (kid === null) return { ok: false, reason: 'no key id' };

    let key: CryptoKey | null;
    try {
      key = await keyFor(kid);
    } catch (e) {
      return { ok: false, reason: `could not load signing keys: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!key) return { ok: false, reason: 'unknown signing key' };
    const good = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, te.encode(`${head}.${body}`));
    if (!good) return { ok: false, reason: 'bad signature' };

    if (claims.iss !== issuer) return { ok: false, reason: 'wrong issuer' };
    const aud = claims.aud;
    if (!(typeof aud === 'string' ? aud === config.audience : Array.isArray(aud) && aud.includes(config.audience))) {
      return { ok: false, reason: 'wrong audience' };
    }
    const t = now();
    const exp = num(claims.exp);
    if (exp === null || exp + LEEWAY < t) return { ok: false, reason: 'expired' };
    const nbf = num(claims.nbf);
    if (nbf !== null && nbf - LEEWAY > t) return { ok: false, reason: 'not valid yet' };

    const email = str(claims.email);
    const serviceToken = str(claims.common_name);
    if (email === null && serviceToken === null) return { ok: false, reason: 'no identity in the token' };
    if (allowed.length > 0 && (email === null || !allowed.includes(email.toLowerCase())))
      return { ok: false, reason: 'not on the allow list' };
    return { ok: true, identity: { email, serviceToken, sub: str(claims.sub) ?? '' } };
  }

  return { verify };
}

// The header Access adds. Read this one, never Cf-Access-Authenticated-User-Email: that header is not signed.
export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
