// Checks the geocoding step (worker/geocode.ts, the admin route and its page numbers) against a stand-in for the Census geocoder
// (tools/lib/fake-census.ts): only an id and an address are sent, what comes back is stored, a run can be stopped and resumed, failures
// write nothing, an upload that changes an address sends that person again, and a change made while the Census was thinking is not
// overwritten. Synthetic data only.
import assert from 'node:assert/strict';
import type { AdminStats, GeocodeProgress } from '../src/api.d.ts';
import { parseCsv } from '../src/sheet.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { GEOCODE_CHUNK } from '../worker/geocode.ts';
import { fakeCensus } from './lib/fake-census.ts';
import { type SheetPerson, sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { type Send, uploadCsv } from './lib/upload-test.ts';

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
const census = fakeCensus();
const clock = new Date('2026-10-23T12:00:00Z');
const admin = 'admin@example.com';
const vera = 'vera@example.com';

async function call(as: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const verifier = { verify: async () => ({ ok: true as const, identity: { email: as, serviceToken: null, sub: as } }) };
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier, now: () => clock, fetcher: census.fetcher });
  return { status: res.status, data: (await res.json()) as unknown };
}
const sendAs =
  (as: string): Send =>
  (method, path, body) =>
    call(as, method, path, body);
const stats = async () => (await call(admin, 'GET', '/api/admin/stats')).data as AdminStats;
const run = async (after = 0) => {
  const r = await call(admin, 'POST', '/api/admin/geocode', { after });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as GeocodeProgress;
};

// 450 people, with phones and names that must never leave, and three the geocoder cannot place or cannot decide about.
const base: SheetPerson[] = [
  ...syntheticPeople(447).map((p, i) => ({ ...p, phone: `602-555-01${String(i % 100).padStart(2, '0')}` })),
  { first: 'Nora', last: 'Nowhere', address: '1 NOWHERE LN TEMPE, AZ 85281', phone: '602-555-0150' },
  { first: 'Tia', last: 'Tied', address: '2 TIE ST MESA, AZ 85201', phone: '602-555-0151' },
  { first: 'Una', last: 'Unit', address: '3 E MAIN ST APT 4 PHOENIX, AZ 85018', phone: '602-555-0152' },
];
await uploadCsv(sendAs(admin), sheetCsv(base), { filename: 'day1.csv' });
const people = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people').get()?.n);
assert.equal(people, 450);

// --- only admins
assert.equal((await call(vera, 'POST', '/api/admin/geocode', { after: 0 })).status, 403);
assert.equal((await call(admin, 'POST', '/api/admin/geocode', { after: -1 })).status, 400);
assert.equal((await call(admin, 'POST', '/api/admin/geocode', { after: 'x' })).status, 400);
assert.equal(census.sent.length, 0, 'nothing was sent for those');

// --- what the admin is told before anything is sent: the next few lines, an id and an address
const before = await stats();
assert.deepEqual([before.geocode.waiting, before.geocode.matched, before.geocode.unmatched], [450, 0, 0]);
assert.equal(before.geocode.sample.length, 3);
for (const line of before.geocode.sample) assert.equal(parseCsv(line)[0]?.length, 5, `an id, street, city, state and ZIP: ${line}`);

// --- a run, a chunk at a time
const first = await run();
assert.deepEqual([first.sent, first.next === null], [GEOCODE_CHUNK, false], 'a full chunk goes on');
const second = await run(first.next ?? 0);
assert.equal(second.sent, GEOCODE_CHUNK);
const third = await run(second.next ?? 0);
assert.deepEqual([third.sent, third.next], [50, null], 'the last chunk ends it');
assert.equal(census.sent.length, 3);
assert.equal(first.matched + second.matched + third.matched + first.noMatch + second.noMatch + third.noMatch, 450, 'everyone was answered');
assert.equal(first.unanswered + second.unanswered + third.unanswered, 0);

// --- only an address leaves: five fields a line, no name, no phone, no note
for (const request of census.sent) {
  assert.equal(request.benchmark, 'Public_AR_Current');
  assert.ok(request.lines.length <= GEOCODE_CHUNK);
  for (const line of request.lines) {
    const fields = parseCsv(line)[0] ?? [];
    assert.equal(fields.length, 5, line);
    assert.equal(fields[3], 'AZ');
    assert.match(fields[0] ?? '', /^\d+$/);
    assert.doesNotMatch(line, /555-01|Nora|Tia|Una|Nowhere|Tied/, `no name or phone in ${line}`);
  }
}
const apt = census.sent.flatMap((r) => r.lines).find((l) => l.includes('MAIN ST APT 4'));
assert.ok(apt, 'a unit stays in the street line');
assert.equal(parseCsv(apt ?? '')[0]?.[2], 'Phoenix', 'and the city is the sheet’s city, not part of the street');

// --- what was stored
const after = await stats();
assert.deepEqual(
  [after.geocode.waiting, after.geocode.matched, after.geocode.unmatched],
  [0, 448, 2],
  'waiting, placed, and the two it could not place',
);
const one = sqlite.prepare("SELECT lat, lon, geocode, geocoded_at FROM people WHERE geocode = 'match' LIMIT 1").get();
assert.ok(
  Number(one?.lat) > 33 && Number(one?.lat) < 34 && Number(one?.lon) < -111 && Number(one?.lon) > -113,
  'longitude comes first in the Census answer',
);
assert.equal(one?.geocoded_at, clock.toISOString());
assert.deepEqual(
  sqlite
    .prepare("SELECT first_name, geocode, lat FROM people WHERE geocode != 'match' ORDER BY first_name")
    .all()
    .map((r) => [r.first_name, r.geocode, r.lat]),
  [
    ['Nora', 'no_match', null],
    ['Tia', 'tie', null],
  ],
);
const audits = sqlite
  .prepare("SELECT detail FROM audit WHERE action = 'geocode'")
  .all()
  .map((r) => JSON.parse(String(r.detail)));
assert.equal(audits.length, 3, 'each request is in the log');
assert.equal(
  audits.reduce((n, d) => n + d.sent, 0),
  450,
);

// --- nobody is sent twice
const again = await run();
assert.deepEqual([again.sent, again.next], [0, null]);
assert.equal(census.sent.length, 3, 'a second run sends nothing');

// --- a failure writes nothing, and a run goes on where it stopped
await uploadCsv(
  sendAs(admin),
  sheetCsv([
    ...base,
    { first: 'Wes', last: 'Wells', address: '9 W ELM ST TEMPE, AZ 85281' },
    { first: 'Zed', last: 'Zane', address: '10 W ELM ST TEMPE, AZ 85281' },
  ]),
  { filename: 'day2.csv' },
);
assert.equal((await stats()).geocode.waiting, 2, 'the two new people');
census.behavior.status = 503;
const busy = await call(admin, 'POST', '/api/admin/geocode', { after: 0 });
assert.equal(busy.status, 502);
assert.match((busy.data as { error: string }).error, /HTTP 503/);
census.behavior.status = 200;
census.behavior.throws = true;
const down = await call(admin, 'POST', '/api/admin/geocode', { after: 0 });
assert.equal(down.status, 502);
assert.match((down.data as { error: string }).error, /did not answer/);
census.behavior.throws = false;
assert.equal((await stats()).geocode.waiting, 2, 'failures stored nothing');
const resumed = await run();
assert.deepEqual([resumed.sent, resumed.matched], [2, 2]);

// --- someone cured before they were looked up is not sent: they are not on the list any more
const withCy = [
  ...base,
  { first: 'Wes', last: 'Wells', address: '9 W ELM ST TEMPE, AZ 85281' },
  { first: 'Zed', last: 'Zane', address: '10 W ELM ST TEMPE, AZ 85281' },
  { first: 'Cy', last: 'Cured', address: '12 W ELM ST TEMPE, AZ 85281' },
];
await uploadCsv(sendAs(admin), sheetCsv(withCy), { filename: 'day2b.csv' });
await uploadCsv(sendAs(admin), sheetCsv(withCy.slice(0, -1)), { filename: 'day2c.csv' });
assert.equal(sqlite.prepare("SELECT status FROM people WHERE first_name = 'Cy'").get()?.status, 'cured');
assert.equal((await stats()).geocode.waiting, 0, 'a cured person is not waiting');
assert.equal((await run()).sent, 0);
assert.ok(!census.sent.flatMap((r) => r.lines).some((l) => l.includes('12 W ELM')), 'and was never sent');

// --- an upload that changes an address sends that person again; one that does not, leaves them be
const moved = base.map((p) => (p.first === 'Una' ? { ...p, address: '3 E MAIN ST APT 4 TEMPE, AZ 85281' } : p));
await uploadCsv(
  sendAs(admin),
  sheetCsv([
    ...moved,
    { first: 'Wes', last: 'Wells', address: '9 W ELM ST TEMPE, AZ 85281' },
    { first: 'Zed', last: 'Zane', address: '10 W ELM ST TEMPE, AZ 85281' },
  ]),
  { filename: 'day3.csv' },
);
const una = sqlite.prepare("SELECT lat, geocode FROM people WHERE first_name = 'Una'").get();
assert.deepEqual([una?.lat, una?.geocode], [null, null], 'a new address clears the old coordinates');
assert.equal(
  Number(sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE geocode = 'match'").get()?.n),
  449,
  'everyone else keeps theirs',
);
const sentBefore = census.sent.length;
const moreRun = await run();
assert.equal(moreRun.sent, 1, 'only Una');
assert.equal(census.sent.length, sentBefore + 1);

// --- an address that changed while the Census was thinking is not overwritten with the old place
const racer = sqlite.prepare("SELECT id FROM people WHERE first_name = 'Wes'").get();
sqlite.prepare('UPDATE people SET geocode = NULL, lat = NULL, lon = NULL WHERE id = ?').run(Number(racer?.id));
census.behavior.during = () => {
  sqlite.prepare("UPDATE people SET address = '11 W ELM ST TEMPE, AZ 85281' WHERE id = ?").run(Number(racer?.id));
  census.behavior.during = null;
};
const raced = await run();
assert.equal(raced.sent, 1);
assert.equal(
  sqlite.prepare('SELECT geocode FROM people WHERE id = ?').get(Number(racer?.id))?.geocode,
  null,
  'the new address still waits to be looked up',
);

// --- the answers as the real Census writes them, including a row with no match, which has only three fields
const real = [
  '"1","4600 Silver Hill Rd, Washington, DC, 20233","Match","Exact","4600 SILVER HILL RD, WASHINGTON, DC, 20233","-76.92836638093,38.84505589808","657091557","L"',
  '"2","1 Nowhere Imaginary Blvd, Tempe, AZ, 85281","No_Match"',
].join('\n');
const rows = parseCsv(real);
assert.equal(rows[0]?.[5], '-76.92836638093,38.84505589808');
assert.equal(rows[1]?.length, 3);

console.log('test-geocode: ok');
