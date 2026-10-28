// Checks telling volunteers about the people assigned to them (worker/mail.ts, the notice routes in worker/api.ts): assigning sends nothing,
// the admin page lists who is waiting to be told, one press sends one email for the whole batch (no voter data in it), the marks clear only
// for what the email covered, an organizer sees and sends only their own precincts, and a failing mailer loses nothing.
import assert from 'node:assert/strict';
import type { AuditEntry, Me, NoticeList, NoticeResult } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { assignedHtml, FROM, type Mailer } from '../worker/mail.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

const sqlite = migratedDb();
const sent: Parameters<Mailer['send']>[0][] = [];
let failing = false;
const mailer: Mailer = {
  send: async (message) => {
    if (failing) throw new Error('mail is down');
    sent.push(message);
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
let clock = new Date('2026-10-23T12:00:00.000Z');
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

sqlite
  .prepare(
    "INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (1, 'x', 'x.csv', ?, 0, 0, 0, 0, 0)",
  )
  .run(clock.toISOString());
// Six people: four in Alma, one in Cairo, one cured in Alma.
const precincts = ['Alma', 'Alma', 'Alma', 'Alma', 'Cairo', 'Alma'];
for (const [i, precinct] of precincts.entries()) {
  sqlite
    .prepare(
      `INSERT INTO people (key, first_name, last_name, precinct, status, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
       VALUES (?, ?, 'Person', ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      `k${i}`,
      `Secret${i}`,
      precinct,
      i === 5 ? 'cured' : 'needs_contact',
      clock.toISOString(),
      clock.toISOString(),
      clock.toISOString(),
    );
}
const ids = sqlite
  .prepare('SELECT id FROM people ORDER BY id')
  .all()
  .map((r) => Number(r.id));
const idOf = async (email: string): Promise<number> => ((await call(email, 'GET', '/api/me')).data as Me).id;
const boss = await idOf('boss@example.com');
const vera = await idOf('vera@example.com');
const walt = await idOf('walt@example.com');
const olive = await idOf('olive@example.com');
await call('boss@example.com', 'PUT', '/api/me', { name: 'Bea Boss' });
// Olive organizes Alma only.
assert.equal(
  (await call('boss@example.com', 'PUT', `/api/admin/volunteers/${olive}/organizer`, { all: false, precincts: ['Alma'] })).status,
  200,
);
const assign = (as: string, person: number | undefined, to: number | null) =>
  call(as, 'POST', `/api/admin/people/${person}/assign`, { volunteerId: to });
const notices = async (as = 'boss@example.com') => (await call(as, 'GET', '/api/admin/notices')).data as NoticeList;
const notify = (as: string, who: number, withMailer = true) => call(as, 'POST', `/api/admin/volunteers/${who}/notify`, {}, withMailer);

// Assigning sends nothing; it only marks the people, and the page lists the volunteers to tell.
assert.equal((await assign('boss@example.com', ids[0], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[1], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[2], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[4], walt)).status, 200);
assert.equal(sent.length, 0, 'assigning does not email');
let list = await notices();
assert.equal(list.emailReady, true);
assert.deepEqual(
  list.notices.map((n) => [n.volunteerId, n.pending, n.lastEmailedAt]),
  [
    [vera, 3, null],
    [walt, 1, null],
  ],
);

// Marks come off when a person is not really a new arrival: yourself, the pool, the same volunteer again, a claim, a release.
assert.equal((await assign('boss@example.com', ids[3], boss)).status, 200);
assert.equal((await assign('boss@example.com', ids[1], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[2], null)).status, 200);
list = await notices();
assert.deepEqual(
  list.notices.map((n) => [n.volunteerId, n.pending]),
  [
    [vera, 2],
    [walt, 1],
  ],
  'the pool pick left the list; giving Vera someone she has changes nothing',
);

// An organizer sees and sends only their own precincts: Olive can tell Vera about Alma, and has nothing to say about Cairo.
assert.deepEqual(
  (await notices('olive@example.com')).notices.map((n) => [n.volunteerId, n.pending]),
  [[vera, 2]],
);
assert.equal((await notify('olive@example.com', walt)).status, 200);
assert.deepEqual((await call('olive@example.com', 'POST', `/api/admin/volunteers/${walt}/notify`, {})).data, { sent: false, count: 0 });
assert.equal(sent.length, 0);
assert.equal((await call('vera@example.com', 'GET', '/api/admin/notices')).status, 403);
assert.equal((await notify('vera@example.com', walt)).status, 403);

// One press, one email for the batch, from the app, replying to the sender, with the count and no voter data.
assert.deepEqual((await notify('boss@example.com', vera)).data as NoticeResult, { sent: true, count: 2 });
assert.equal(sent.length, 1);
const mail = sent[0];
assert.equal(mail?.to, 'vera@example.com');
assert.equal(mail?.from, FROM);
assert.equal(mail?.replyTo, 'boss@example.com');
assert.equal(mail?.subject, 'You have 2 new voters to contact');
assert.match(mail?.text ?? '', /Bea Boss \(boss@example\.com\) assigned you 2 voters/);
assert.match(mail?.text ?? '', /https:\/\/cure\.example\//);
assert.doesNotMatch(`${mail?.subject}\n${mail?.text}\n${mail?.html}`, /Secret|Person|Alma/, 'no voter data in the email');
assert.match(mail?.html ?? '', /<a href="https:\/\/cure\.example\/"[^>]*>View my list<\/a>/);
assert.match(mail?.html ?? '', /Or type this address into your browser: https:\/\/cure\.example\//);
assert.equal(assignedHtml('<b>"x"</b>', 'https://a/?a=1&b=2', 1).includes('<b>'), false, 'names are escaped');

// It is not sent twice: the marks are gone, and the list shows who was emailed when.
assert.deepEqual((await notify('boss@example.com', vera)).data, { sent: false, count: 0 });
assert.equal(sent.length, 1);
assert.deepEqual(
  (await notices()).notices.map((n) => [n.volunteerId, n.pending]),
  [[walt, 1]],
);
// A person assigned afterwards makes a new notice, singular this time, and the last emailed time is kept.
clock = new Date(clock.getTime() + 3_600_000);
assert.equal((await assign('boss@example.com', ids[2], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[3], vera)).status, 200);
assert.equal((await call('vera@example.com', 'POST', `/api/people/${ids[3]}/release`, {})).status, 200);
const again = (await notices()).notices.find((n) => n.volunteerId === vera);
assert.deepEqual([again?.pending, again?.lastEmailedAt], [1, '2026-10-23T12:00:00.000Z']);
assert.equal((await notify('boss@example.com', vera)).status, 200);
assert.equal(sent[1]?.subject, 'You have a new voter to contact');

// A failing mailer loses nothing: the marks stay and the send can be tried again. No mailer at all is a clear refusal.
failing = true;
assert.equal((await notify('boss@example.com', walt)).status, 502);
assert.equal((await notices()).notices.find((n) => n.volunteerId === walt)?.pending, 1);
failing = false;
assert.equal((await notify('boss@example.com', walt, false)).status, 503);
assert.equal(((await call('boss@example.com', 'GET', '/api/admin/notices', undefined, false)).data as NoticeList).emailReady, false);
assert.deepEqual((await notify('boss@example.com', walt)).data, { sent: true, count: 1 });
assert.equal(sent.length, 3);

// A cured person is not counted, and sends are audited.
sqlite.prepare('UPDATE people SET notify_pending = 1, assigned_to = ? WHERE id = ?').run(walt, ids[5] ?? 0);
assert.deepEqual((await notify('boss@example.com', walt)).data, { sent: false, count: 0 });
const log = (await call('boss@example.com', 'GET', '/api/admin/audit?limit=200')).data as AuditEntry[];
assert.deepEqual(
  log
    .filter((e) => e.action === 'notify.send')
    .map((e) => (e.detail as { volunteer: number; count: number }).count)
    .sort(),
  [1, 1, 2],
);
console.log('test-assign-email: ok');
