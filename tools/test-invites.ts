// Checks inviting people who have no account yet (worker/invites.ts and the /api/admin/invites routes): that only site admins can,
// what is parsed from pasted text, that each address gets one message with the steps and no voter data, that people with an account are
// skipped, the cooldown and a failing mailer, and that every send is in the audit log.
import assert from 'node:assert/strict';
import type { AuditEntry, InviteList, InviteResult } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { inviteMessage, MAX_PER_REQUEST, parseEmails, RESEND_MS } from '../worker/invites.ts';
import { FROM, type Mailer } from '../worker/mail.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

// Pasted text: separators, `Name <address>`, case, duplicates, junk with an @, words without one.
assert.deepEqual(parseEmails('Ada@Example.com, bob@example.com;\nAda@example.com  Carl Cook <carl@example.com> not@valid x@y').emails, [
  'ada@example.com',
  'bob@example.com',
  'carl@example.com',
]);
assert.deepEqual(parseEmails('not@valid x@y.com "q"@z.com a@b@c.com').rejected, ['not@valid', '"q"@z.com', 'a@b@c.com']);
assert.deepEqual(parseEmails('just names here').emails, []);

const sqlite = migratedDb();
const sent: Parameters<Mailer['send']>[0][] = [];
let failing = false;
const mailer: Mailer = {
  send: async (m) => {
    if (failing) throw new Error('mail is down');
    sent.push(m);
  },
};
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'boss@example.com',
  ALLOW_RESET: 'false',
  DB: sqliteD1(sqlite),
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  EMAIL: mailer,
};
let clock = new Date('2026-10-28T12:00:00.000Z');
const verifierFor = (email: string): AccessVerifier => ({
  verify: async () => ({ ok: true, identity: { email, serviceToken: null, sub: email } }),
});
async function call(as: string, method: string, path: string, body?: unknown, withMailer = true) {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const e = withMailer ? env : { ...env, EMAIL: undefined };
  const res = await handle(new Request(`https://cure.example${path}`, init), e, { verifier: verifierFor(as), now: () => clock });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const invites = async () => (await call('boss@example.com', 'GET', '/api/admin/invites')).data as InviteList;
const post = (emails: string) => call('boss@example.com', 'POST', '/api/admin/invites', { emails });

await call('boss@example.com', 'PUT', '/api/me', { name: 'Bea Boss' });
await call('vera@example.com', 'GET', '/api/me'); // Vera has signed in: she has an account

// Only site admins.
assert.equal((await call('vera@example.com', 'POST', '/api/admin/invites', { emails: 'x@example.com' })).status, 403);
assert.equal((await call('vera@example.com', 'GET', '/api/admin/invites')).status, 403);

// Bad input.
assert.equal((await post('no addresses here')).status, 400);
assert.equal((await post(Array.from({ length: MAX_PER_REQUEST + 1 }, (_, i) => `p${i}@example.com`).join('\n'))).status, 400);

// An invitation: one message each, from the app, replies to the admin, the steps, the person's own address, no voter data.
const first = (await post('Olga@example.com, vera@example.com, bad@x')).data as InviteResult;
assert.deepEqual(first.sent, ['olga@example.com']);
assert.deepEqual(first.skipped, [{ email: 'vera@example.com', why: 'has_account' }]);
assert.deepEqual(first.rejected, ['bad@x']);
assert.equal(sent.length, 1);
const mail = sent[0];
assert.equal(mail?.to, 'olga@example.com');
assert.equal(mail?.from, FROM);
assert.equal(mail?.replyTo, 'boss@example.com');
assert.match(mail?.text ?? '', /Bea Boss \(boss@example\.com\) invited you/);
assert.match(mail?.text ?? '', /type exactly this one: olga@example\.com/);
assert.match(mail?.text ?? '', /https:\/\/cure\.example\//);
assert.match(mail?.text ?? '', /6-digit code/);
assert.match(mail?.html ?? '', /<a href="https:\/\/cure\.example\/"[^>]*>Open the site<\/a>/);
assert.match(mail?.html ?? '', /type exactly this one: <strong>olga@example\.com<\/strong>/);
assert.equal(inviteMessage('a<b@x.co', { name: '<i>', email: 'e@x.co' }, 'https://h').html.includes('<i>'), false, 'names are escaped');

// The list: waiting until she signs in, then signed in.
const list = await invites();
assert.equal(list.emailReady, true);
assert.deepEqual(
  list.invites.map((i) => [i.email, i.status, i.invitedBy, i.sentCount]),
  [['olga@example.com', 'waiting', 'boss@example.com', 1]],
);
await call('olga@example.com', 'GET', '/api/me');
assert.equal((await invites()).invites[0]?.status, 'signed_in');

// A second paste of the same address soon after sends nothing; after the cooldown it sends again. Resend works by id.
await post('pia@example.com');
assert.equal(sent.length, 2);
assert.deepEqual(((await post('pia@example.com')).data as InviteResult).skipped, [{ email: 'pia@example.com', why: 'too_soon' }]);
const piaId = (await invites()).invites.find((i) => i.email === 'pia@example.com')?.id;
assert.deepEqual(
  ((await call('boss@example.com', 'POST', `/api/admin/invites/${piaId}/resend`, {})).data as InviteResult).skipped.length,
  1,
);
assert.equal(sent.length, 2);
clock = new Date(clock.getTime() + RESEND_MS + 1000);
assert.deepEqual(((await call('boss@example.com', 'POST', `/api/admin/invites/${piaId}/resend`, {})).data as InviteResult).sent, [
  'pia@example.com',
]);
assert.equal(sent.length, 3);
assert.equal((await call('boss@example.com', 'POST', '/api/admin/invites/9999/resend', {})).status, 404);

// Removing an invite: gone from the list, audited, and a second try finds nothing. Only a site admin may.
await post('rae@example.com');
const raeId = (await invites()).invites.find((i) => i.email === 'rae@example.com')?.id;
assert.equal((await call('anna@example.com', 'POST', `/api/admin/invites/${raeId}/remove`, {})).status, 403);
assert.equal((await call('boss@example.com', 'POST', `/api/admin/invites/${raeId}/remove`, {})).status, 200);
assert.equal(
  (await invites()).invites.some((i) => i.email === 'rae@example.com'),
  false,
);
assert.equal((await call('boss@example.com', 'POST', `/api/admin/invites/${raeId}/remove`, {})).status, 404);

// A failing mailer: nothing is lost, the invite shows as not sent, and a later try works at once.
failing = true;
const bad = (await post('quinn@example.com')).data as InviteResult;
assert.deepEqual([bad.sent, bad.failed], [[], ['quinn@example.com']]);
assert.equal((await invites()).invites.find((i) => i.email === 'quinn@example.com')?.status, 'not_sent');
failing = false;
assert.deepEqual(((await post('quinn@example.com')).data as InviteResult).sent, ['quinn@example.com']);
assert.equal((await invites()).invites.find((i) => i.email === 'quinn@example.com')?.status, 'waiting');

// Without a mailer, nothing can be sent and the page is told.
assert.equal((await call('boss@example.com', 'POST', '/api/admin/invites', { emails: 'ray@example.com' }, false)).status, 503);
assert.equal(((await call('boss@example.com', 'GET', '/api/admin/invites', undefined, false)).data as InviteList).emailReady, false);

// Every send is in the audit log, once, and the failed one is not.
const log = (await call('boss@example.com', 'GET', '/api/admin/audit?limit=200')).data as AuditEntry[];
const audited = log.filter((e) => e.action === 'invite.send').map((e) => (e.detail as { email: string }).email);
assert.deepEqual(audited.sort(), ['olga@example.com', 'pia@example.com', 'pia@example.com', 'quinn@example.com', 'rae@example.com']);
assert.deepEqual(
  log.filter((e) => e.action === 'invite.remove').map((e) => (e.detail as { email: string }).email),
  ['rae@example.com'],
);
console.log('test-invites: ok');
