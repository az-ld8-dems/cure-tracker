// Checks phone numbers entered by hand (worker/phones.ts, GET /api/admin/phones/missing, POST /api/admin/people/:id/phone, and the way an
// upload treats them): the list, who may enter one, that a number from the sheet is never changed here, that the audit log says who and not
// the number, and that a sheet with no phone keeps an entered one while a sheet with a phone replaces it. Synthetic people only.
import assert from 'node:assert/strict';
import type { AuditEntry, Me, MissingPhonePage } from '../src/api.d.ts';
import { type IncomingPerson, KEY_VERSION, normalizeKey, splitAddress } from '../src/sheet.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { normalizePhone } from '../worker/phones.ts';
import { finishStage, stageRows, startStage } from '../worker/uploads.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

assert.equal(normalizePhone('(480) 555-0123'), '480-555-0123');
assert.equal(normalizePhone('+1 480.555.0123'), '480-555-0123');
assert.equal(normalizePhone('4805550123'), '480-555-0123');
for (const bad of ['', '555-0123', '1234567890', '480-155-0123', '480-555-01234', 'call mom']) assert.equal(normalizePhone(bad), null, bad);

const sqlite = migratedDb();
const db = sqliteD1(sqlite);
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'boss@example.com',
  ALLOW_RESET: 'true',
  DB: db,
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
};
const NOW = '2026-10-28T12:00:00.000Z';
const verifierFor = (email: string): AccessVerifier => ({
  verify: async () => ({ ok: true, identity: { email, serviceToken: null, sub: email } }),
});
async function call(as: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier: verifierFor(as), now: () => new Date(NOW) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}
const me = async (email: string): Promise<number> => ((await call(email, 'GET', '/api/me')).data as Me).id;

// Three people: Pat has no phone (Alma), Quin has one from the sheet (Alma), Rae has none (Cairo).
const sheetPerson = (first: string, last: string, n: number, precinct: string, phone: string): IncomingPerson => {
  const address = `${100 + n} E MAIN ST TEMPE, AZ 85281`;
  return {
    key: normalizeKey(first, last, address),
    firstName: first,
    middleName: '',
    lastName: last,
    party: 'DEM',
    legdist: '8',
    reasonCode: 'NO ID',
    phone,
    address,
    city: splitAddress(address).city,
    zip: '85281',
    precinct,
    statusDate: '2026-10-20',
  };
};
const people = [
  sheetPerson('Pat', 'Pending', 1, 'Alma', ''),
  sheetPerson('Quin', 'Quoted', 2, 'Alma', '602-555-0101'),
  sheetPerson('Rae', 'Remote', 3, 'Cairo', ''),
];
async function upload(sheet: IncomingPerson[]): Promise<void> {
  const { token } = await startStage(db, 'boss@example.com', NOW, {
    filename: 'x.csv',
    keyVersion: KEY_VERSION,
    expected: sheet.length,
    rows: sheet.length,
    skippedOtherDistrict: 0,
    skippedInvalid: 0,
    duplicates: 0,
    warnings: [],
    cities: [],
    columns: { headers: [], sample: [], choices: [], ready: true },
    used: {},
  });
  await stageRows(db, token, sheet);
  await finishStage(db, token, { now: NOW, actor: 'boss@example.com', force: true });
}
await upload(people);
const idOf = (last: string): number => Number(sqlite.prepare('SELECT id FROM people WHERE last_name = ?').get(last)?.id);
const phoneOf = (last: string) => sqlite.prepare('SELECT phone, phone_by FROM people WHERE last_name = ?').get(last);
const [pat, quin, rae] = [idOf('Pending'), idOf('Quoted'), idOf('Remote')];

await me('boss@example.com');
const anna = await me('anna@example.com'); // organizes Alma
await me('dora@example.com'); // a plain volunteer
sqlite.prepare("INSERT INTO organizers (volunteer_id, precinct, granted_by, granted_at) VALUES (?, 'Alma', 'x', ?)").run(anna, NOW);

// The list: people with no phone. A plain volunteer cannot see it; an organizer sees their precincts' people.
assert.equal((await call('dora@example.com', 'GET', '/api/admin/phones/missing')).status, 403);
const all = (await call('boss@example.com', 'GET', '/api/admin/phones/missing')).data as MissingPhonePage;
assert.deepEqual(
  all.people.map((p) => p.name),
  ['Pat Pending', 'Rae Remote'],
);
assert.equal(all.total, 2);
const mine = (await call('anna@example.com', 'GET', '/api/admin/phones/missing')).data as MissingPhonePage;
assert.deepEqual(
  mine.people.map((p) => p.name),
  ['Pat Pending'],
);
const found = (await call('boss@example.com', 'GET', '/api/admin/phones/missing?q=remote')).data as MissingPhonePage;
assert.deepEqual(
  found.people.map((p) => p.name),
  ['Rae Remote'],
);
assert.equal((await call('boss@example.com', 'GET', '/api/admin/phones/missing?after=-1')).status, 400);

// Entering a number: formatted like the sheet's, marked with who entered it.
const set = (as: string, id: number, phone: unknown) => call(as, 'POST', `/api/admin/people/${id}/phone`, { phone });
assert.equal((await set('dora@example.com', pat, '480-555-0123')).status, 403);
assert.equal((await set('boss@example.com', pat, '555-0123')).status, 400);
assert.equal((await set('anna@example.com', rae, '480-555-0123')).status, 403, 'outside their precincts');
assert.equal((await set('anna@example.com', pat, '(480) 555-0123')).status, 200);
assert.deepEqual({ ...phoneOf('Pending') }, { phone: '480-555-0123', phone_by: 'anna@example.com' });
assert.equal((await set('boss@example.com', quin, '480-555-0199')).status, 409, 'a number from the sheet is not changed here');
assert.equal((await call('boss@example.com', 'POST', `/api/admin/people/${quin}/phone`, { clear: true })).status, 409);
assert.deepEqual({ ...phoneOf('Quoted') }, { phone: '602-555-0101', phone_by: null });

// An entered number stays on the list, so it can be corrected.
const afterSet = (await call('boss@example.com', 'GET', '/api/admin/phones/missing')).data as MissingPhonePage;
assert.deepEqual(
  afterSet.people.map((p) => [p.name, p.phone, p.byHand]),
  [
    ['Pat Pending', '480-555-0123', true],
    ['Rae Remote', '', false],
  ],
);
assert.equal((await set('boss@example.com', pat, '480-555-0456')).status, 200);
assert.equal(phoneOf('Pending')?.phone, '480-555-0456');

// An upload: a sheet with no phone for Pat keeps the entered one; a sheet with a phone replaces it and it is the sheet's from then on.
await upload(people);
assert.deepEqual({ ...phoneOf('Pending') }, { phone: '480-555-0456', phone_by: 'boss@example.com' });
await upload([sheetPerson('Pat', 'Pending', 1, 'Alma', '602-555-0999'), people[1] as IncomingPerson, people[2] as IncomingPerson]);
assert.deepEqual({ ...phoneOf('Pending') }, { phone: '602-555-0999', phone_by: null });
assert.equal((await set('boss@example.com', pat, '480-555-0123')).status, 409, 'now it is the sheet’s');
// ...and the sheet dropping a number it had gives the person no phone (a number from the sheet is the sheet's to take back).
await upload(people);
assert.deepEqual({ ...phoneOf('Pending') }, { phone: '', phone_by: null });

// Taking an entered number away.
assert.equal((await set('boss@example.com', rae, '623-555-0100')).status, 200);
assert.equal((await call('boss@example.com', 'POST', `/api/admin/people/${rae}/phone`, { clear: true })).status, 200);
assert.deepEqual({ ...phoneOf('Remote') }, { phone: '', phone_by: null });

// The log says which person and who, never the number.
const log = (await call('boss@example.com', 'GET', '/api/admin/audit?limit=100')).data as AuditEntry[];
const rows = log.filter((e) => e.action === 'person.phone' || e.action === 'person.unphone');
assert.deepEqual(rows.map((e) => e.action).sort(), ['person.phone', 'person.phone', 'person.phone', 'person.unphone']);
assert.ok(
  rows.every((e) => !/\d{3}-\d{3}-\d{4}/.test(JSON.stringify(e))),
  'no number in the log',
);
console.log('test-phones: ok');
