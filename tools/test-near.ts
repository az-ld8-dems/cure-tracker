// Checks "near me": a volunteer saves a rounded place (from their device or the middle of a ZIP), and Find people can then show who is within
// some miles, nearest first. Every distance is checked against an independent great-circle calculation, and so is who is left out. Also: a
// saved place is only ever the volunteer's own and never in the log, the questions that need a place are refused without one, claimed people
// drop out, people with only the middle of their ZIP are marked as a guess, and the database answers from the (lat, lon) index. Synthetic
// data only.
import assert from 'node:assert/strict';
import type { Me, PeoplePage } from '../src/api.d.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { geocodeChunk } from '../worker/geocode.ts';
import { nearSql } from '../worker/near.ts';
import { fakeCensus } from './lib/fake-census.ts';
import { type SheetPerson, sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { type Send, uploadCsv } from './lib/upload-test.ts';

console.warn = () => {};
console.error = () => {};

const sqlite = migratedDb();
const db = sqliteD1(sqlite);
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'admin@example.com',
  ALLOW_RESET: 'false',
  DB: db,
  ASSETS: { fetch: async () => new Response('asset') },
};
const census = fakeCensus();
const clock = new Date('2026-10-23T12:00:00Z');
const admin = 'admin@example.com';
const vera = 'vera@example.com';
const walt = 'walt@example.com';

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
const page = async (as: string, query: string): Promise<PeoplePage> => {
  const r = await call(as, 'GET', `/api/people${query}`);
  assert.equal(r.status, 200, `${query}: ${JSON.stringify(r.data)}`);
  return r.data as PeoplePage;
};
// Every page of a question, put together (a page is at most 200).
const allOf = async (as: string, query: string) => {
  const out: PeoplePage['people'] = [];
  for (let offset = 0; ; offset += 200) {
    const got = await page(as, `${query}&limit=200&offset=${offset}`);
    out.push(...got.people);
    if (!got.hasMore) return out;
  }
};
const putPlace = (as: string, body: unknown) => call(as, 'PUT', '/api/me/location', body);
const meOf = async (as: string) => (await call(as, 'GET', '/api/me')).data as Me;

// Miles between two points on the globe, worked out here a different way from the Worker's SQL (the spherical law of cosines), so it is an
// independent check of it.
const miles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const rad = Math.PI / 180;
  const cos =
    Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return Math.acos(Math.min(1, cos)) * 3958.8;
};

// 800 people over the fake Census's patch of the Phoenix area (about 17 by 27 miles), a few the geocoder cannot place (they get the middle of
// their ZIP), all geocoded.
const base: SheetPerson[] = [
  ...syntheticPeople(796),
  { first: 'Nora', last: 'Nowhere', address: '1 NOWHERE LN TEMPE, AZ 85281' },
  { first: 'Tia', last: 'Tied', address: '2 TIE ST MESA, AZ 85201' },
  { first: 'Una', last: 'Unit', address: '3 NOWHERE ST PHOENIX, AZ 85018' },
  { first: 'Val', last: 'Valley', address: '4 TIE RD SCOTTSDALE, AZ 85251' },
];
await uploadCsv(sendAs(admin), sheetCsv(base), { filename: 'day1.csv' });
for (let after = 0, next: number | null = 0; next !== null; after = next ?? 0) {
  next = (await geocodeChunk(db, admin, clock.toISOString(), after, census.fetcher)).next;
}
const placed = sqlite.prepare('SELECT COUNT(*) AS n FROM people WHERE lat IS NOT NULL').get();
assert.equal(Number(placed?.n), 800, 'everyone has a place, 4 of them a guess');

// --- saving a place
assert.equal((await meOf(vera)).location, null, 'nothing is saved at first');
for (const bad of [
  {},
  { lat: 'x', lon: 1 },
  { lat: 33.4 },
  { lat: 80, lon: -112 },
  { lat: 33.4, lon: 112 },
  { zip: 'abcde' },
  { zip: '85' },
  { zip: '99999' },
  { clear: 'yes' },
  'near',
])
  assert.equal((await putPlace(vera, bad)).status, 400, JSON.stringify(bad));
assert.equal((await meOf(vera)).location, null, 'none of those saved anything');

const saved = (await putPlace(vera, { lat: 33.456789, lon: -112.0149 })).data as { location: { lat: number; lon: number } };
assert.deepEqual(
  { lat: saved.location.lat, lon: saved.location.lon },
  { lat: 33.46, lon: -112.01 },
  'rounded to 0.01 degrees, about 0.7 mile, before it is stored',
);
assert.deepEqual(
  sqlite.prepare('SELECT home_lat AS lat, home_lon AS lon FROM volunteers WHERE email = ?').get(vera) && {
    ...sqlite.prepare('SELECT home_lat AS lat, home_lon AS lon FROM volunteers WHERE email = ?').get(vera),
  },
  { lat: 33.46, lon: -112.01 },
  'and that is what the database holds',
);
const mine = (await meOf(vera)).location;
assert.deepEqual({ lat: mine?.lat, lon: mine?.lon }, { lat: 33.46, lon: -112.01 });
assert.equal((await meOf(walt)).location, null, 'someone else sees nothing of it');
assert.deepEqual(
  Object.keys(((await call(vera, 'GET', '/api/volunteers')).data as object[])[0] ?? {}).sort(),
  ['email', 'id', 'name'],
  'the volunteer list has no places',
);
const statsText = JSON.stringify((await call(admin, 'GET', '/api/admin/stats')).data);
assert.doesNotMatch(statsText, /home_|"location"|33\.46/, 'an admin does not see it either');
const logText = JSON.stringify(sqlite.prepare("SELECT action, detail FROM audit WHERE action LIKE 'location.%'").all());
assert.match(logText, /location\.set/);
assert.doesNotMatch(logText, /33\.4|112\.0/, 'the log says it was saved, never where');

// by the middle of a ZIP
const byZip = (await putPlace(walt, { zip: '85018' })).data as { location: { lat: number; lon: number } };
const middle = sqlite.prepare("SELECT AVG(lat) AS lat, AVG(lon) AS lon FROM people WHERE zip = '85018' AND geocode = 'match'").get();
assert.ok(
  Math.abs(byZip.location.lat - Number(middle?.lat)) <= 0.005 && Math.abs(byZip.location.lon - Number(middle?.lon)) <= 0.005,
  'the middle of the people placed there, rounded',
);
assert.match(
  String(sqlite.prepare("SELECT detail FROM audit WHERE action = 'location.set' ORDER BY id DESC LIMIT 1").get()?.detail),
  /"via":"zip"/,
);

// --- who is near
await putPlace(vera, { lat: 33.46, lon: -112.01 });
const home = { lat: 33.46, lon: -112.01 };
const everyone = sqlite
  .prepare("SELECT id, lat, lon, approximate FROM people WHERE lat IS NOT NULL AND assigned_to IS NULL AND status != 'cured'")
  .all()
  .map((r) => ({
    id: Number(r.id),
    lat: Number(r.lat),
    lon: Number(r.lon),
    approximate: Number(r.approximate) === 1,
    away: miles(home, { lat: Number(r.lat), lon: Number(r.lon) }),
  }));
// where that is in words: the town and ZIP of the nearest person waiting
const nearest = [...everyone].sort((a, b) => a.away - b.away)[0] ?? assert.fail('someone nearby');
const nearestRow = sqlite.prepare('SELECT city, zip FROM people WHERE id = ?').get(nearest.id);
const inWords = `${nearestRow?.city} ${nearestRow?.zip}`;
assert.equal((await meOf(vera)).location?.near, inWords, 'the page can say where you are');
assert.deepEqual(
  ((await putPlace(vera, { lat: 33.46, lon: -112.01 })).data as { location: { near: string } }).location.near,
  inWords,
  'and so does saving it',
);
assert.match(inWords, /^[A-Za-z ]+ \d{5}$/);
// a place with no one waiting within 25 miles has no words, but is still saved
const empty = (await putPlace(walt, { lat: 36.5, lon: -112.0 })).data as { location: { lat: number; near: string | null } };
assert.deepEqual([empty.location.lat, empty.location.near], [36.5, null]);
await putPlace(walt, { zip: '85018' });
for (const radius of [1, 3, 5, 10]) {
  const got = { people: await allOf(vera, `?miles=${radius}&sort=distance`) };
  const gotIds = new Set(got.people.map((p) => p.id));
  // Anyone inside is in, anyone outside is out: the same sphere, so only rounding in the last decimals can differ.
  for (const p of everyone) {
    if (p.away <= radius - 1e-6) assert.ok(gotIds.has(p.id), `within ${radius} miles but missing: ${p.away.toFixed(3)} away`);
    if (p.away >= radius + 1e-6) assert.ok(!gotIds.has(p.id), `beyond ${radius} miles but listed: ${p.away.toFixed(3)} away`);
  }
  const ds = got.people.map((p) => p.distanceMiles ?? -1);
  assert.deepEqual(
    ds,
    [...ds].sort((a, b) => a - b),
    `nearest first within ${radius} miles`,
  );
  for (const p of got.people) {
    const truth = everyone.find((e) => e.id === p.id)?.away ?? Number.NaN;
    assert.ok(
      Math.abs((p.distanceMiles ?? 0) - truth) <= 0.0501,
      `the distance shown for ${p.id} is ${p.distanceMiles}, really ${truth.toFixed(3)}`,
    );
  }
  assert.ok(got.people.length > 0 || radius === 1, 'there is someone to find');
}
assert.ok((await allOf(vera, '?miles=10')).length > (await allOf(vera, '?miles=3')).length, 'a wider search finds more');

// the guess is marked, and sorts where its ZIP's middle is
const guesses = await allOf(vera, '?miles=25&sort=distance');
assert.equal(guesses.length, 800, 'everyone is within 25 miles of the middle of this patch');
assert.equal(guesses.filter((p) => p.approximate).length, 4, 'the four with the middle of their ZIP are marked');
assert.ok(
  guesses.filter((p) => !p.approximate).every((p) => p.approximate === false),
  'everyone else is marked exact',
);
// other filters work along with it, and other sorts
const tempe = await page(vera, '?miles=25&city=Tempe&limit=200');
assert.ok(tempe.people.length > 0 && tempe.people.every((p) => p.city === 'Tempe' && (p.distanceMiles ?? 99) <= 25));
const byDays = await page(vera, '?miles=10&limit=200');
assert.ok(
  byDays.people.every((p) => p.distanceMiles !== undefined),
  'the distance comes with any sort',
);
const far = await page(vera, '?miles=10&sort=distance&dir=desc&limit=200');
assert.deepEqual(
  far.people.map((p) => p.distanceMiles),
  [...far.people.map((p) => p.distanceMiles)].sort((a, b) => (b ?? 0) - (a ?? 0)),
  'and farthest first',
);
// pages
const firstTen = await page(vera, '?miles=10&sort=distance&limit=10');
assert.equal(firstTen.hasMore, true);
const nextTen = await page(vera, '?miles=10&sort=distance&limit=10&offset=10');
assert.ok((nextTen.people[0]?.distanceMiles ?? 0) >= (firstTen.people.at(-1)?.distanceMiles ?? 99), 'the next page goes on from the last');

// claimed people leave the search
const closest = firstTen.people[0] ?? assert.fail('someone close');
assert.equal((await call(vera, 'POST', `/api/people/${closest.id}/claim`, {})).status, 200);
assert.ok(
  !(await page(vera, '?miles=10&sort=distance&limit=200')).people.some((p) => p.id === closest.id),
  'a claimed person is not in the pool',
);
// a person with no place is not in a distance search, but is in the pool
const noPlace = Number(sqlite.prepare('SELECT id FROM people WHERE lat IS NOT NULL LIMIT 1 OFFSET 7').get()?.id);
sqlite.prepare('UPDATE people SET lat = NULL, lon = NULL WHERE id = ?').run(noPlace);
assert.ok(!(await allOf(vera, '?miles=100')).some((p) => p.id === noPlace));
assert.ok((await page(vera, '?limit=200&sort=name')).people.length > 0);

// --- what needs a place is refused without one, and what does not make sense is refused
assert.equal((await call(walt, 'GET', '/api/people?miles=5')).status, 200, 'walt has a place (his ZIP)');
assert.equal((await call(admin, 'GET', '/api/people?miles=5')).status, 400, 'an admin who has not saved a place');
assert.equal((await call(admin, 'GET', '/api/people?sort=distance')).status, 400);
for (const bad of ['?miles=0', '?miles=0.1', '?miles=101', '?miles=x', '?sort=distance', '?scope=mine&miles=5']) {
  assert.equal((await call(vera, 'GET', `/api/people${bad}`)).status, 400, bad);
}
assert.equal((await call(vera, 'GET', '/api/people?scope=mine')).status, 200, 'and my own list still works');
assert.equal((await call(vera, 'GET', '/api/people?scope=all&miles=5')).status, 403, 'and a volunteer still cannot list everyone');
await putPlace(admin, { lat: 33.46, lon: -112.01 });
assert.equal((await call(admin, 'GET', '/api/people?scope=all&miles=5')).status, 400, 'distance is for the pool only, even for an admin');
await putPlace(admin, { clear: true });

// --- clearing it
assert.deepEqual(((await putPlace(vera, { clear: true })).data as { location: unknown }).location, null);
assert.equal((await meOf(vera)).location, null);
assert.equal(sqlite.prepare('SELECT home_lat AS v FROM volunteers WHERE email = ?').get(vera)?.v, null, 'gone from the database too');
assert.equal((await call(vera, 'GET', '/api/people?miles=5')).status, 400, 'a search needs one again');
assert.match(String(sqlite.prepare("SELECT action FROM audit WHERE action = 'location.clear'").get()?.action), /location\.clear/);

// --- the database reads a band of the map, from the index, and sorts nothing it does not have to
const nearby = nearSql(home, 5);
const plan = sqlite
  .prepare(
    `EXPLAIN QUERY PLAN SELECT p.id, ${nearby.away} AS away FROM people p WHERE p.assigned_to IS NULL AND p.status != 'cured' AND ${nearby.where} ORDER BY away, p.id LIMIT 51`,
  )
  .all()
  .map((r) => String(r.detail))
  .join(' | ');
assert.match(plan, /people_pool_place \(lat>\? AND lat<\?\)|people_pool_place/, `the (lat, lon) index is used: ${plan}`);

console.log('test-near: ok');
