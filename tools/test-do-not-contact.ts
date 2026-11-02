// Checks "do not contact": a voter who asked is off every list at once, nobody can claim or be given them, an upload (a changed row, a cure,
// a return to the sheet) never clears it, and only an organizer takes it off. Synthetic data on the real migrations, as in test-api.ts.
import assert from 'node:assert/strict';
import type { AdminStats, PeoplePage, Person, PersonDetail } from '../src/api.d.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { previewCsv, type Send, uploadCsv } from './lib/upload-test.ts';

console.warn = () => {};
console.error = () => {};

const sqlite = migratedDb();
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'admin@example.com',
  ALLOW_RESET: 'false',
  DB: sqliteD1(sqlite),
  ASSETS: { fetch: async () => new Response('asset') },
};
const clock = new Date('2026-10-23T12:00:00Z');

async function call(as: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const verifier = { verify: async () => ({ ok: true as const, identity: { email: as, serviceToken: null, sub: as } }) };
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier, now: () => clock });
  return { status: res.status, data: (await res.json().catch(() => null)) as unknown };
}
async function ok<T>(as: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await call(as, method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} as ${as}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data as T;
}
const sendAs =
  (as: string): Send =>
  (method, path, body) =>
    call(as, method, path, body);

const admin = 'admin@example.com';
const vera = 'vera@example.com';
const walt = 'walt@example.com';
const sheet = syntheticPeople(12);
await uploadCsv(sendAs(admin), sheetCsv(sheet), { filename: 'day1.csv' });

const pool = async (as = walt): Promise<Person[]> => (await ok<PeoplePage>(as, 'GET', '/api/people?limit=200')).people;
const everyone = async (): Promise<Person[]> => (await ok<PeoplePage>(admin, 'GET', '/api/people?scope=all&limit=200')).people;
const stats = (as = admin) => ok<AdminStats>(as, 'GET', '/api/admin/stats');

const [first, second, third] = await pool();
assert.ok(first && second && third);
assert.equal((await pool()).length, 12);
assert.equal(first.doNotContact, false);

// --- marking: the person's volunteer, an admin or an organizer; nobody else
await ok(vera, 'POST', `/api/people/${first.id}/claim`, {});
await ok(vera, 'POST', `/api/people/${first.id}/status`, { status: 'contacted', method: 'call' });
await ok(vera, 'POST', `/api/people/${first.id}/notes`, { body: 'Asked us to stop calling.' });
assert.equal((await call(walt, 'POST', `/api/people/${first.id}/do-not-contact`, {})).status, 403, 'not their volunteer');
const marked = await ok<Person>(vera, 'POST', `/api/people/${first.id}/do-not-contact`, {});
assert.equal(marked.doNotContact, true);
assert.equal(marked.assignedTo, null, 'they leave the volunteer’s list');
assert.equal(marked.status, 'needs_contact', 'no longer counts as contacted, so an upload cannot call it an unsuccessful cure');

assert.equal((await pool()).length, 11, 'out of the pool');
assert.ok(!(await pool()).some((p) => p.id === first.id));
assert.equal((await ok<PeoplePage>(vera, 'GET', '/api/people?scope=mine')).people.length, 0, 'and out of the volunteer’s list');
assert.equal((await call(walt, 'POST', `/api/people/${first.id}/claim`, {})).status, 409, 'nobody can claim them');
assert.equal(
  (await call(admin, 'POST', `/api/admin/people/${first.id}/assign`, { volunteerId: 1 })).status,
  409,
  'nobody can be given them',
);
assert.equal((await call(admin, 'POST', `/api/people/${first.id}/status`, { status: 'contacted' })).status, 409, 'not even an admin');
assert.equal((await ok<PersonDetail>(walt, 'GET', `/api/people/${first.id}`)).notes.length, 1, 'the notes stay');
assert.equal((await everyone()).find((p) => p.id === first.id)?.doNotContact, true, 'an admin searching still finds them, marked');

const before = await stats();
assert.equal(before.totals.doNotContact, 1);
assert.equal(before.totals.unassigned, 11, 'they are in no other count');
assert.equal(before.totals.needsContact, 11);

// an admin marks anyone, and marking twice changes nothing
await ok(admin, 'POST', `/api/people/${second.id}/do-not-contact`, {});
await ok(admin, 'POST', `/api/people/${second.id}/do-not-contact`, {});
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'person.do_not_contact'").get()?.n, 2, 'one audit row each');
assert.equal((await stats()).totals.doNotContact, 2);

// --- the admin list, and who may take someone off it
assert.deepEqual((await ok<Person[]>(admin, 'GET', '/api/admin/do-not-contact')).map((p) => p.id).sort(), [first.id, second.id].sort());
assert.equal((await call(walt, 'GET', '/api/admin/do-not-contact')).status, 403, 'a plain volunteer does not see the list');
assert.equal((await call(walt, 'POST', `/api/admin/people/${first.id}/allow-contact`, {})).status, 403);

// --- uploads never clear it
const changed = sheet.map((p, i) => (i < 3 ? { ...p, phone: '602-555-0100', reason: 'NO SIGNATURE' } : p));
await uploadCsv(sendAs(admin), sheetCsv(changed), { filename: 'day2.csv' });
assert.equal((await everyone()).find((p) => p.id === first.id)?.doNotContact, true, 'a changed row');
// Cured (gone from the sheet), then back on it: reopened and flagged, still asked not to be contacted.
const withoutFirst = sheet.filter((_, i) => i !== 0 && i !== 1);
await uploadCsv(sendAs(admin), sheetCsv(withoutFirst), { filename: 'day3.csv' });
assert.equal((await everyone()).find((p) => p.id === first.id)?.status, 'cured');
await uploadCsv(sendAs(admin), sheetCsv(sheet), { filename: 'day4.csv' });
const back = (await everyone()).find((p) => p.id === first.id);
assert.equal(back?.status, 'needs_contact', 'reopened by the upload');
assert.equal(back?.doNotContact, true, 'but still asked not to be contacted');
assert.equal((await pool()).length, 10, 'and not in the pool');
assert.equal((await stats()).flagged.length, 0, 'not on the list of people to look at again');
assert.equal((await stats()).totals.flagged, 0);

// The same name at another address is a new person: the preview says so, and nothing is held back.
const [asker] = sheet;
assert.ok(asker);
const moved = [...sheet, { ...asker, address: '1 Nowhere Lane Phoenix AZ 85001' }];
const preview = await previewCsv(sendAs(admin), sheetCsv(moved), { filename: 'day5.csv' });
assert.ok(
  preview.warnings.some((w) => /same name as someone on the do-not-contact list/.test(w)),
  `a warning for the same name: ${JSON.stringify(preview.warnings)}`,
);
const calm = await previewCsv(sendAs(admin), sheetCsv(sheet), { filename: 'day5.csv' });
assert.ok(!calm.warnings.some((w) => /do-not-contact/.test(w)), `and none without one: ${JSON.stringify(calm.warnings)}`);

// --- the export leaves them out
await ok(vera, 'POST', `/api/people/${third.id}/claim`, {});
await ok(vera, 'POST', `/api/people/${third.id}/notes`, { body: 'Will call back.' });
const csv = await (async () => {
  const verifier = { verify: async () => ({ ok: true as const, identity: { email: admin, serviceToken: null, sub: admin } }) };
  const res = await handle(new Request('https://cure.example/api/admin/export/worked.csv'), env, { verifier, now: () => clock });
  return res.text();
})();
assert.ok(csv.includes('Will call back.'));
assert.ok(!csv.includes('Asked us to stop calling.'), 'their notes are not exported');

// --- an organizer takes it off, and they are back in the pool
const allowed = await ok<Person>(admin, 'POST', `/api/admin/people/${first.id}/allow-contact`, {});
assert.equal(allowed.doNotContact, false);
assert.ok(
  (await pool()).some((p) => p.id === first.id),
  'back in the pool',
);
assert.equal((await stats()).totals.doNotContact, 1);
await ok(walt, 'POST', `/api/people/${first.id}/claim`, {});
const actions = sqlite.prepare("SELECT action FROM audit WHERE person_id = ? AND action LIKE 'person.%' ORDER BY id").all(first.id);
assert.deepEqual(
  actions.map((a) => a.action),
  ['person.do_not_contact', 'person.allow_contact'],
);

// --- the geocoder is never sent their address
const waiting = await ok<AdminStats>(admin, 'GET', '/api/admin/stats');
assert.ok(!waiting.geocode.sample.join('\n').includes(asker.address) || asker.address === '', 'sample has no one who asked');

console.log('test-do-not-contact: ok');
