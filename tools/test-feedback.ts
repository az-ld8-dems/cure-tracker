// Checks the feedback route (POST /api/feedback): the message is emailed to the site's address with the sender in reply-to, nothing from it
// reaches the audit log, one a minute per person, and a missing or failing mailer is said plainly.
import assert from 'node:assert/strict';
import type { AuditEntry } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { FEEDBACK_TO, type Mailer } from '../worker/mail.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

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
  ALLOW_RESET: 'true',
  DB: sqliteD1(sqlite),
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  EMAIL: mailer,
};
let clock = new Date('2026-10-28T12:00:00.000Z');
const verifierFor = (email: string): AccessVerifier => ({
  verify: async () => ({ ok: true, identity: { email, serviceToken: null, sub: email } }),
});
async function call(as: string, method: string, path: string, body?: unknown, withMail = true) {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const e = withMail ? env : { ...env, EMAIL: undefined };
  const res = await handle(new Request(`https://cure.example${path}`, init), e, { verifier: verifierFor(as), now: () => clock });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}
const fb = (as: string, message: unknown, withMail = true) => call(as, 'POST', '/api/feedback', { message, page: '/map/' }, withMail);

await call('dora@example.com', 'PUT', '/api/me', { name: 'Dora Doe' });

// An empty message is refused, and nothing is sent.
assert.equal((await fb('dora@example.com', '   ')).status, 400);
assert.equal((await fb('dora@example.com', 'x'.repeat(4001))).status, 400);
assert.equal(sent.length, 0);

// It goes to the site's address, with the sender and page in it, and replies go to the sender. Markup in it is escaped in the HTML.
assert.equal((await fb('dora@example.com', 'The <b>Claim</b> button did nothing')).status, 200);
assert.equal(sent.length, 1);
assert.equal(sent[0]?.to, FEEDBACK_TO);
assert.equal(sent[0]?.replyTo, 'dora@example.com');
assert.match(sent[0]?.subject ?? '', /Dora Doe/);
assert.match(sent[0]?.text ?? '', /Dora Doe \(dora@example.com\)/);
assert.match(sent[0]?.text ?? '', /Page: \/map\//);
assert.match(sent[0]?.html ?? '', /&lt;b&gt;Claim&lt;\/b&gt;/);
assert.ok(!(sent[0]?.html ?? '').includes('<b>Claim'));

// One a minute per person; someone else is not held up; after the minute it works again.
assert.equal((await fb('dora@example.com', 'again')).status, 429);
assert.equal((await fb('eve@example.com', 'from someone else')).status, 200);
assert.equal(sent.length, 2);
clock = new Date(clock.getTime() + 61_000);
assert.equal((await fb('dora@example.com', 'a minute later')).status, 200);

// A failing mailer: said plainly, and it does not count against the minute.
clock = new Date(clock.getTime() + 61_000);
failing = true;
assert.equal((await fb('dora@example.com', 'while mail is down')).status, 502);
failing = false;
assert.equal((await fb('dora@example.com', 'mail is back')).status, 200);

// No mailer at all: a clear refusal.
clock = new Date(clock.getTime() + 61_000);
assert.equal((await fb('dora@example.com', 'no mailer', false)).status, 503);

// The audit log says feedback was sent and never what it said.
const log = (await call('boss@example.com', 'GET', '/api/admin/audit?limit=100')).data as AuditEntry[];
const rows = log.filter((e) => e.action === 'feedback.send');
assert.equal(rows.length, 4);
assert.ok(rows.every((e) => JSON.stringify(e).includes('Claim') === false && JSON.stringify(e.detail) === '{}'));
console.log('test-feedback: ok');
