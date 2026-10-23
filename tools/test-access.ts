// Checks worker/access.ts, the check of the token Cloudflare Access adds to each request, with a throwaway RSA key standing in for
// Cloudflare's: a good token, and each reason to refuse one. No network: the key set comes from a fake fetch.
import assert from 'node:assert/strict';
import { createAccessVerifier } from '../worker/access.ts';

const b64url = (data: ArrayBuffer | Uint8Array | string): string =>
  Buffer.from(typeof data === 'string' ? data : new Uint8Array(data))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'app-aud';
const NOW = 1_800_000_000;
let fetches = 0;
const fetchFn: typeof fetch = async (url) => {
  fetches++;
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};
const verifier = createAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetchFn, now: () => NOW });

async function token(
  claims: Record<string, unknown>,
  { key = pair.privateKey, header = {} }: { key?: CryptoKey; header?: Record<string, unknown> } = {},
) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', ...header }));
  const body = b64url(
    JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 600, email: 'vera@example.com', sub: 's', ...claims }),
  );
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const good = await verifier.verify(await token({}));
assert.deepEqual(good, { ok: true, identity: { email: 'vera@example.com', serviceToken: null, sub: 's' } });
assert.equal(fetches, 1);
await verifier.verify(await token({}));
assert.equal(fetches, 1, 'the key set is kept');

const reason = async (t: string | null) => {
  const r = await verifier.verify(t);
  return r.ok ? 'ok' : r.reason;
};
assert.equal(await reason(null), 'no token');
assert.equal(await reason('a.b'), 'not a JWT');
assert.equal(await reason('a.b.c'), 'malformed token');
assert.equal(await reason(await token({ aud: ['another-app'] })), 'wrong audience');
assert.equal(await reason(await token({ iss: 'https://evil.example' })), 'wrong issuer');
assert.equal(await reason(await token({ exp: NOW - 120 })), 'expired');
assert.equal(await reason(await token({ nbf: NOW + 120 })), 'not valid yet');
assert.equal(await reason(await token({}, { key: other.privateKey })), 'bad signature');
assert.equal(await reason(await token({}, { header: { alg: 'none' } })), 'unexpected algorithm');
assert.equal(await reason(await token({ email: undefined })), 'no identity in the token');
assert.equal(await reason(await token({}, { header: { kid: 'unknown' } })), 'unknown signing key');

const bot = await verifier.verify(await token({ email: undefined, common_name: 'ci-bot' }));
assert.deepEqual(bot.ok && bot.identity.serviceToken, 'ci-bot');

const unconfigured = createAccessVerifier({ teamDomain: '', audience: '' }, { fetchFn, now: () => NOW });
assert.deepEqual(await unconfigured.verify(await token({})), { ok: false, reason: 'Access is not configured' }, 'fails closed');

console.log('test-access: ok');
