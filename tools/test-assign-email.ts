// Checks the email a volunteer gets when someone assigns them a voter (worker/mail.ts, the assign route in worker/api.ts): who is
// emailed, that no voter data is in it, that a burst of assignments sends one message, and that a failing mailer never fails the assignment.
import assert from 'node:assert/strict';
import type { Me } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { assignedHtml, FROM, type Mailer, THROTTLE_MS } from '../worker/mail.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

const sqlite = migratedDb();
const sent: { from: string; to: string; subject: string; text: string; html: string }[] = [];
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
for (const n of [1, 2, 3, 4]) {
  sqlite
    .prepare(
      `INSERT INTO people (key, first_name, last_name, precinct, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
       VALUES (?, ?, 'Person', 'Alma', ?, 1, 1, ?, ?)`,
    )
    .run(`k${n}`, `Secret${n}`, clock.toISOString(), clock.toISOString(), clock.toISOString());
}
const ids = sqlite
  .prepare('SELECT id FROM people ORDER BY id')
  .all()
  .map((r) => Number(r.id));
const idOf = async (email: string): Promise<number> => ((await call(email, 'GET', '/api/me')).data as Me).id;
const boss = await idOf('boss@example.com');
const vera = await idOf('vera@example.com');
const walt = await idOf('walt@example.com');
await call('boss@example.com', 'PUT', '/api/me', { name: 'Bea Boss' });
const assign = (as: string, person: number | undefined, to: number | null) =>
  call(as, 'POST', `/api/admin/people/${person}/assign`, { volunteerId: to });

// Assigning emails the volunteer, from the app's address, with who did it and where to look, and nothing about the voter.
assert.equal((await assign('boss@example.com', ids[0], vera)).status, 200);
assert.equal(sent.length, 1);
const mail = sent[0];
assert.equal(mail?.to, 'vera@example.com');
assert.equal(mail?.from, FROM);
assert.match(FROM, /<admin@azld8cures\.com>$/);
assert.match(mail?.text ?? '', /Bea Boss \(boss@example\.com\) assigned you a voter/);
assert.match(mail?.text ?? '', /https:\/\/cure\.example\//);
assert.doesNotMatch(`${mail?.subject}\n${mail?.text}\n${mail?.html}`, /Secret|Person|Alma/, 'no voter data in the email');
assert.match(mail?.html ?? '', /<a href="https:\/\/cure\.example\/"[^>]*>View my list<\/a>/, 'a clickable link');
assert.match(mail?.html ?? '', /Bea Boss \(boss@example\.com\)/);
assert.equal(assignedHtml('<b>"x"</b>', 'https://a/?a=1&b=2').includes('<b>'), false, 'names are escaped');

// A burst sends one email; after the window, the next assignment sends another.
assert.equal((await assign('boss@example.com', ids[1], vera)).status, 200);
assert.equal(sent.length, 1, 'within the window: no second email');
clock = new Date(clock.getTime() + THROTTLE_MS + 1000);
assert.equal((await assign('boss@example.com', ids[2], vera)).status, 200);
assert.equal(sent.length, 2);

// Nobody is emailed for taking a person themselves, for being given someone they already have, for the pool, or when there is no mailer.
assert.equal((await assign('boss@example.com', ids[3], boss)).status, 200);
assert.equal((await assign('boss@example.com', ids[2], vera)).status, 200);
assert.equal((await assign('boss@example.com', ids[2], null)).status, 200);
assert.equal(sent.length, 2);
assert.equal((await call('boss@example.com', 'POST', `/api/admin/people/${ids[2]}/assign`, { volunteerId: walt }, false)).status, 200);
assert.equal(sent.length, 2, 'no mailer, no email, and the assignment still works');

// A mailer that fails does not fail the assignment, and the next assignment tries again.
failing = true;
assert.equal((await assign('boss@example.com', ids[0], walt)).status, 200);
assert.equal(sent.length, 2);
failing = false;
assert.equal((await assign('boss@example.com', ids[1], walt)).status, 200);
assert.equal(sent.length, 3, 'the failed send did not use up the window');
assert.equal(sent[2]?.to, 'walt@example.com');

// Only organizers can assign at all.
assert.equal((await assign('vera@example.com', ids[3], walt)).status, 403);
console.log('test-assign-email: ok');
