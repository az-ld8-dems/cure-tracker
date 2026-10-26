// Checks the geocoding step (worker/geocode.ts, the admin route and its page numbers) against a stand-in for the Census geocoder
// (tools/lib/fake-census.ts): only an id and an address are sent, what comes back is stored, a run can be stopped and resumed, failures
// write nothing, an upload that changes an address sends that person again, and a change made while the Census was thinking is not
// overwritten. Synthetic data only.
import assert from 'node:assert/strict';
import type { AdminStats, GeocodeProgress, UnplacedPage } from '../src/api.d.ts';
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

// 452 people, with phones and names that must never leave, and four the geocoder cannot place or cannot decide about: two in ZIPs where
// plenty of others are placed, and one in a ZIP where only one other is placed, so a middle would be that person's house.
const base: SheetPerson[] = [
  ...syntheticPeople(447).map((p, i) => ({ ...p, phone: `602-555-01${String(i % 100).padStart(2, '0')}` })),
  { first: 'Nora', last: 'Nowhere', address: '1 NOWHERE LN TEMPE, AZ 85281', phone: '602-555-0150' },
  { first: 'Tia', last: 'Tied', address: '2 TIE ST MESA, AZ 85201', phone: '602-555-0151' },
  { first: 'Una', last: 'Unit', address: '3 E MAIN ST APT 4 PHOENIX, AZ 85018', phone: '602-555-0152' },
  { first: 'Lou', last: 'Lost', address: '4 NOWHERE RD PRESCOTT, AZ 85999', phone: '602-555-0153' },
  { first: 'Pat', last: 'Placed', address: '7 W ELM ST PRESCOTT, AZ 85999', phone: '602-555-0154' },
];
await uploadCsv(sendAs(admin), sheetCsv(base), { filename: 'day1.csv' });
const people = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people').get()?.n);
assert.equal(people, 452);

// --- only admins
assert.equal((await call(vera, 'POST', '/api/admin/geocode', { after: 0 })).status, 403);
assert.equal((await call(admin, 'POST', '/api/admin/geocode', { after: -1 })).status, 400);
assert.equal((await call(admin, 'POST', '/api/admin/geocode', { after: 'x' })).status, 400);
assert.equal(census.sent.length, 0, 'nothing was sent for those');

// --- what the admin is told before anything is sent: the next few lines, an id and an address
const before = await stats();
assert.deepEqual([before.geocode.waiting, before.geocode.matched, before.geocode.approximate, before.geocode.unmatched], [452, 0, 0, 0]);
assert.equal(before.geocode.sample.length, 3);
for (const line of before.geocode.sample) assert.equal(parseCsv(line)[0]?.length, 5, `an id, street, city, state and ZIP: ${line}`);

// --- a run, a chunk at a time
const first = await run();
assert.deepEqual([first.sent, first.next === null], [GEOCODE_CHUNK, false], 'a full chunk goes on');
const second = await run(first.next ?? 0);
assert.equal(second.sent, GEOCODE_CHUNK);
const third = await run(second.next ?? 0);
assert.deepEqual([third.sent, third.next], [52, null], 'the last chunk ends it');
assert.deepEqual(
  [first.approximated, second.approximated, third.approximated],
  [0, 0, 2],
  'at the end, the two in busy ZIPs get the middle of their ZIP',
);
assert.equal(census.sent.length, 3);
assert.equal(first.matched + second.matched + third.matched + first.noMatch + second.noMatch + third.noMatch, 452, 'everyone was answered');
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
    assert.doesNotMatch(line, /555-01|Nora|Tia|Una|Lou|Nowhere|Tied|Lost/, `no name or phone in ${line}`);
  }
}
const apt = census.sent.flatMap((r) => r.lines).find((l) => parseCsv(l)[0]?.[1] === '3 E MAIN ST');
assert.ok(apt, 'the apartment is sent without its APT 4: the Census ignores a unit it understands and can fail on one it does not');
assert.equal(parseCsv(apt ?? '')[0]?.[2], 'Phoenix', 'and the city is the sheet’s city, not part of the street');

// --- what was stored
const after = await stats();
assert.deepEqual(
  [after.geocode.waiting, after.geocode.matched, after.geocode.approximate, after.geocode.unmatched],
  [0, 449, 2, 3],
  'waiting, placed exactly, placed roughly, and the three the geocoder could not place',
);
const one = sqlite.prepare("SELECT lat, lon, geocode, geocoded_at, approximate FROM people WHERE geocode = 'match' LIMIT 1").get();
assert.ok(
  Number(one?.lat) > 33 && Number(one?.lat) < 34 && Number(one?.lon) < -111 && Number(one?.lon) > -113,
  'longitude comes first in the Census answer',
);
assert.equal(one?.geocoded_at, clock.toISOString());
assert.equal(one?.approximate, 0);
// The two in busy ZIPs sit at the middle of their ZIP (the average of the people the geocoder placed there); the third stays unplaced.
const middleOf = (zip: string) =>
  sqlite.prepare("SELECT AVG(lat) AS lat, AVG(lon) AS lon FROM people WHERE zip = ? AND geocode = 'match'").get(zip);
const placeOf = (first: string) => sqlite.prepare('SELECT geocode, lat, lon, approximate FROM people WHERE first_name = ?').get(first);
for (const [first, zip, why] of [
  ['Nora', '85281', 'no_match'],
  ['Tia', '85201', 'tie'],
] as const) {
  const place = placeOf(first);
  const middle = middleOf(zip);
  assert.equal(place?.geocode, why, `${first} is still marked as the geocoder said`);
  assert.equal(place?.approximate, 1, `${first} is approximate`);
  assert.ok(
    Math.abs(Number(place?.lat) - Number(middle?.lat)) < 1e-9 && Math.abs(Number(place?.lon) - Number(middle?.lon)) < 1e-9,
    `${first} is at the middle of ${zip}`,
  );
}
assert.deepEqual(
  [placeOf('Lou')?.geocode, placeOf('Lou')?.lat, placeOf('Lou')?.approximate],
  ['no_match', null, 0],
  'one placed person in its ZIP is not enough for a middle: not placed at all',
);
const audits = sqlite
  .prepare("SELECT detail FROM audit WHERE action = 'geocode'")
  .all()
  .map((r) => JSON.parse(String(r.detail)));
assert.equal(audits.length, 3, 'each request is in the log');
assert.equal(
  audits.reduce((n, d) => n + d.sent, 0),
  452,
);

// --- nobody is sent twice
const again = await run();
assert.deepEqual([again.sent, again.next], [0, null]);
assert.equal(census.sent.length, 3, 'a second run sends nothing');

// --- the list an admin looks the unplaced up from
assert.equal((await call(vera, 'GET', '/api/admin/geocode/unplaced')).status, 403);
assert.equal((await call(admin, 'GET', '/api/admin/geocode/unplaced?after=-1')).status, 400);
const list = (await call(admin, 'GET', '/api/admin/geocode/unplaced')).data as UnplacedPage;
assert.deepEqual(
  list.people.map((p) => [p.name, p.reason, p.approximate]),
  [
    ['Lou Lost', 'no_match', false],
    ['Nora Nowhere', 'no_match', true],
    ['Tia Tied', 'tie', true],
  ],
  'in id order, with what they have for now',
);
assert.equal(list.people.find((p) => p.name === 'Nora Nowhere')?.address, '1 NOWHERE LN TEMPE, AZ 85281');
assert.equal(list.next, null);
// more than a page: 50 at a time, each page starting where the last ended
sqlite.exec("UPDATE people SET geocode = 'no_match' WHERE id <= 120 AND geocode = 'match'");
const page1 = (await call(admin, 'GET', '/api/admin/geocode/unplaced')).data as UnplacedPage;
const page2 = (await call(admin, 'GET', `/api/admin/geocode/unplaced?after=${page1.next}`)).data as UnplacedPage;
const page3 = (await call(admin, 'GET', `/api/admin/geocode/unplaced?after=${page2.next}`)).data as UnplacedPage;
assert.deepEqual([page1.people.length, page2.people.length, page1.next === null, page3.next], [50, 50, false, null]);
assert.equal(
  new Set([...page1.people, ...page2.people, ...page3.people].map((p) => p.id)).size,
  page1.people.length + page2.people.length + page3.people.length,
  'no one twice',
);
sqlite.exec("UPDATE people SET geocode = 'match' WHERE id <= 120 AND geocode = 'no_match' AND approximate = 0 AND lat IS NOT NULL");

// --- looking the unplaced up again: still unplaced, they keep the middle of their ZIP; found, they get the place
const guess = placeOf('Nora');
const asked = census.sent.length;
const stillNot = await call(admin, 'POST', '/api/admin/geocode', { after: 0, retry: true });
assert.equal(stillNot.status, 200);
assert.deepEqual(
  [(stillNot.data as GeocodeProgress).sent, (stillNot.data as GeocodeProgress).matched],
  [3, 0],
  'only the unplaced are sent again',
);
assert.equal(census.sent.length, asked + 1);
assert.deepEqual(placeOf('Nora'), guess, 'a miss does not take the guess away');
census.behavior.matchEverything = true;
const found = (await call(admin, 'POST', '/api/admin/geocode', { after: 0, retry: true })).data as GeocodeProgress;
census.behavior.matchEverything = false;
assert.deepEqual([found.sent, found.matched], [3, 3]);
const nora = placeOf('Nora');
assert.deepEqual([nora?.geocode, nora?.approximate], ['match', 0], 'found: placed exactly now');
assert.notEqual(nora?.lat, guess?.lat, 'at the place the geocoder found, not the middle of the ZIP');
const settled = (await stats()).geocode;
assert.deepEqual([settled.matched, settled.approximate, settled.unmatched], [452, 0, 0]);
assert.match(
  String(sqlite.prepare("SELECT detail FROM audit WHERE action = 'geocode' ORDER BY id DESC LIMIT 1").get()?.detail),
  /"retry":true/,
  'the log says it was a retry',
);
// put them back as they were for what follows
sqlite
  .prepare("UPDATE people SET geocode = 'no_match', lat = ?, lon = ?, approximate = 1 WHERE first_name = 'Nora'")
  .run(Number(guess?.lat), Number(guess?.lon));
sqlite.prepare("UPDATE people SET geocode = 'tie', lat = NULL, lon = NULL, approximate = 0 WHERE first_name = 'Tia'").run();
sqlite.prepare("UPDATE people SET geocode = 'no_match', lat = NULL, lon = NULL, approximate = 0 WHERE first_name = 'Lou'").run();

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
// Una moves, and so does Nora, who has the middle of her ZIP for now: the guess goes with the old address.
const moved = base.map((p) =>
  p.first === 'Una'
    ? { ...p, address: '3 E MAIN ST APT 4 TEMPE, AZ 85281' }
    : p.first === 'Nora'
      ? { ...p, address: '1 NOWHERE LN TEMPE, AZ 85282' }
      : p,
);
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
assert.deepEqual(
  Object.values(sqlite.prepare("SELECT lat, geocode, approximate FROM people WHERE first_name = 'Nora'").get() ?? {}),
  [null, null, 0],
  'a new address takes the guess away too: the person is waiting to be looked up again',
);
assert.deepEqual([una?.lat, una?.geocode], [null, null], 'a new address clears the old coordinates');
assert.equal(
  Number(sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE geocode = 'match'").get()?.n),
  450,
  'everyone else keeps theirs',
);
const sentBefore = census.sent.length;
const moreRun = await run();
assert.equal(moreRun.sent, 2, 'only Una and Nora, whose addresses changed');
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

// --- the second chance: the street without its unit, a non-exact match as a guess, and the street alone when the sheet's city and ZIP disagree
const fourth = [
  { first: 'Bo', last: 'Boundary', address: '10 BOUNDARY RD 109 TEMPE, AZ 85281' },
  { first: 'Far', last: 'Away', address: '20 FARAWAY ST TEMPE, AZ 85281' },
  { first: 'Nan', last: 'Nonexact', address: '30 NONEXACT AVE MESA, AZ 85201' },
  { first: 'Ula', last: 'Unit', address: '40 E MAIN ST 1105 TEMPE, AZ 85281' },
];
await uploadCsv(
  sendAs(admin),
  sheetCsv([
    ...moved,
    { first: 'Wes', last: 'Wells', address: '9 W ELM ST TEMPE, AZ 85281' },
    { first: 'Zed', last: 'Zane', address: '10 W ELM ST TEMPE, AZ 85281' },
    ...fourth,
  ]),
  { filename: 'day4.csv' },
);
const sentBefore4 = census.sent.length;
await run();
const firstLines = census.sent.slice(sentBefore4).flatMap((r) => r.lines);
const lineOf = (lines: string[], needle: string) => lines.find((l) => l.includes(needle)) ?? assert.fail(`no line with ${needle}`);
assert.equal(parseCsv(lineOf(firstLines, '"40 E MAIN'))[0]?.[1], '40 E MAIN ST', 'a unit written as a bare number is not sent');
assert.equal(parseCsv(lineOf(firstLines, 'BOUNDARY'))[0]?.[1], '10 BOUNDARY RD', 'nor a unit after the street type, whatever it is');
assert.ok(!firstLines.some((l) => /b",/.test(l.split(',')[0] ?? '') || /^\d+b,/.test(l)), 'a first lookup sends one line a person');
assert.deepEqual(
  [
    placeOf('Ula')?.geocode,
    placeOf('Ula')?.approximate,
    placeOf('Nan')?.geocode,
    placeOf('Nan')?.approximate,
    placeOf('Bo')?.geocode,
    placeOf('Far')?.geocode,
  ],
  ['match', 0, 'match', 1, 'no_match', 'no_match'],
  'an exact match is exact, a non-exact one is a guess, and a street that only fits without the sheet’s city and ZIP is not found yet',
);
const guessed = await stats();
assert.ok(guessed.geocode.approximate >= 3, 'the non-exact match counts as placed roughly, with the two at the middle of their ZIP');
assert.equal(
  Number(sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE first_name = 'Nan' AND geocode = 'match' AND approximate = 1").get()?.n),
  1,
);
const middle85281 = sqlite
  .prepare("SELECT AVG(lat) AS lat, AVG(lon) AS lon FROM people WHERE zip = '85281' AND geocode = 'match' AND approximate = 0")
  .get();
census.behavior.boundaryPoint = { lat: Number(middle85281?.lat) + 0.02, lon: Number(middle85281?.lon) };
const unplacedBefore = Number(
  sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE status != 'cured' AND geocode IN ('no_match', 'tie')").get()?.n,
);
const sentBefore5 = census.sent.length;
const twice = await call(admin, 'POST', '/api/admin/geocode', { after: 0, retry: true });
assert.equal(twice.status, 200);
const retryLines = census.sent.slice(sentBefore5).flatMap((r) => r.lines);
assert.equal(
  retryLines.length,
  unplacedBefore * 2,
  'a retry sends each unplaced person twice: with the sheet’s city and ZIP, and the street alone',
);
assert.equal(
  lineOf(retryLines, 'BOUNDARY RD",""').split(',').slice(1).join(','),
  '"10 BOUNDARY RD","",AZ,""',
  'the street alone: no city, no ZIP',
);
assert.match(lineOf(retryLines, 'BOUNDARY RD",""'), /^\d+b,/, 'with the person’s id and a b');
const rescuedBo = placeOf('Bo');
assert.deepEqual([rescuedBo?.geocode, rescuedBo?.approximate], ['match', 0], 'found by the street alone, near their ZIP: placed');
assert.ok(Math.abs(Number(rescuedBo?.lat) - (Number(middle85281?.lat) + 0.02)) < 1e-9, 'where the Census put it');
assert.deepEqual(
  [placeOf('Far')?.geocode, placeOf('Far')?.approximate],
  ['no_match', 1],
  'found in another town: not believed, so still only the middle of its ZIP',
);
assert.notEqual(placeOf('Far')?.lat, 35.2);
// With no middle for the ZIP to check against, a street found alone is not believed either.
sqlite.prepare("UPDATE people SET zip = '85999' WHERE first_name = 'Bo'").run();
sqlite.prepare("UPDATE people SET geocode = 'no_match', lat = NULL, lon = NULL, approximate = 0 WHERE first_name = 'Bo'").run();
await call(admin, 'POST', '/api/admin/geocode', { after: 0, retry: true });
assert.equal(placeOf('Bo')?.geocode, 'no_match', 'a ZIP with fewer than five placed people has no middle to check against');

// --- the answers as the real Census writes them, including a row with no match, which has only three fields
const real = [
  '"1","4600 Silver Hill Rd, Washington, DC, 20233","Match","Exact","4600 SILVER HILL RD, WASHINGTON, DC, 20233","-76.92836638093,38.84505589808","657091557","L"',
  '"2","1 Nowhere Imaginary Blvd, Tempe, AZ, 85281","No_Match"',
].join('\n');
const rows = parseCsv(real);
assert.equal(rows[0]?.[5], '-76.92836638093,38.84505589808');
assert.equal(rows[1]?.length, 3);

console.log('test-geocode: ok');
