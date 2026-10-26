// Checks the map: /api/map sends the open pool inside a box and nothing else (not the claimed, not the cured, not the unplaced), marks
// guesses, refuses a box that is not one, and says whether the basemap file is in place; and the Worker serves that file from its bucket, byte
// ranges included, only to someone signed in. Synthetic data only.
import assert from 'node:assert/strict';
import type { MapPins } from '../src/api.d.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { geocodeChunk } from '../worker/geocode.ts';
import type { TileBucket, TileObject } from '../worker/tiles.ts';
import { fakeCensus } from './lib/fake-census.ts';
import { type SheetPerson, sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { type Send, uploadCsv } from './lib/upload-test.ts';

console.warn = () => {};
console.error = () => {};

// A bucket of one file whose bytes are 0, 1, 2, ... (mod 256), that answers Range headers the way R2 does.
const FILE: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1000)).map((_, i) => i % 256);
let heldFile: Uint8Array<ArrayBuffer> | null = null;
let asked = 0;
const bucket: TileBucket = {
  head: async (key) => (key === 'ld8.pmtiles' && heldFile ? {} : null),
  get: async (key, { range }): Promise<TileObject | null> => {
    asked++;
    if (key !== 'ld8.pmtiles' || !heldFile) return null;
    const size = heldFile.length;
    const header = range.get('range');
    if (!header) return { body: new Blob([heldFile]).stream(), size, httpEtag: '"v1"' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    assert.ok(m, `a range header this test understands: ${header}`);
    if (m[1] === '') {
      const suffix = Number(m[2]);
      return { body: new Blob([heldFile.slice(size - suffix)]).stream(), size, httpEtag: '"v1"', range: { suffix } };
    }
    const offset = Number(m[1]);
    const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    return {
      body: new Blob([heldFile.slice(offset, end + 1)]).stream(),
      size,
      httpEtag: '"v1"',
      range: { offset, length: end - offset + 1 },
    };
  },
};

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

async function call(as: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...extra, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const verifier = { verify: async () => ({ ok: true as const, identity: { email: as, serviceToken: null, sub: as } }) };
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier, now: () => clock, fetcher: census.fetcher });
  return res;
}
const json = async (as: string, path: string) => {
  const res = await call(as, 'GET', path);
  return { status: res.status, data: (await res.json()) as unknown };
};
const sendAs =
  (as: string): Send =>
  async (method, path, body) => {
    const res = await call(as, method, path, body);
    return { status: res.status, data: (await res.json()) as unknown };
  };

// Over the fake Census's patch of the Phoenix area, with a few the geocoder cannot place (they get the middle of their ZIP).
const people: SheetPerson[] = [
  ...syntheticPeople(300),
  { first: 'Nora', last: 'Nowhere', address: '1 NOWHERE LN TEMPE, AZ 85281' },
  { first: 'Tia', last: 'Tied', address: '2 TIE ST MESA, AZ 85201' },
];
await uploadCsv(sendAs(admin), sheetCsv(people), { filename: 'day1.csv' });
for (let after = 0, next: number | null = 0; next !== null; after = next ?? 0) {
  next = (await geocodeChunk(db, admin, clock.toISOString(), after, census.fetcher)).next;
}
// Somebody the geocoder never ran for has no place at all.
sqlite
  .prepare(
    "UPDATE people SET lat = NULL, lon = NULL, geocode = NULL WHERE last_name = 'SYNTH-NOPLACE' OR id = (SELECT MIN(id) FROM people)",
  )
  .run();

const WHOLE = 'west=-113&south=33&east=-111&north=34';
const pins = async (query: string): Promise<MapPins> => {
  const r = await json(vera, `/api/map?${query}`);
  assert.equal(r.status, 200, `${query}: ${JSON.stringify(r.data)}`);
  return r.data as MapPins;
};

// --- the pins are the open, placed pool, at the places the database holds
const open = sqlite
  .prepare("SELECT id, lat, lon, approximate FROM people WHERE assigned_to IS NULL AND status != 'cured' AND lat IS NOT NULL ORDER BY id")
  .all() as { id: number; lat: number; lon: number; approximate: number }[];
assert.ok(open.length > 250, 'a pool to look at');
assert.ok(
  open.some((p) => p.approximate === 1),
  'with guesses in it',
);
const whole = await pins(WHOLE);
assert.equal(whole.more, false);
assert.deepEqual(
  [...whole.pins].sort((a, b) => a[0] - b[0]),
  open.map((p) => [p.id, p.lat, p.lon, p.approximate]),
  'every open, placed person once, with their place and whether it is a guess',
);
assert.equal(whole.tiles, false, 'no tile file is in place yet');

// a smaller box holds exactly the people inside it
const mid = { south: 33.4, north: 33.5, west: -112.1, east: -111.95 };
const small = await pins(`west=${mid.west}&south=${mid.south}&east=${mid.east}&north=${mid.north}`);
const inside = open.filter((p) => p.lat >= mid.south && p.lat <= mid.north && p.lon >= mid.west && p.lon <= mid.east);
assert.ok(inside.length > 0 && inside.length < open.length, 'a box that splits the pool');
assert.deepEqual(
  small.pins.map((p) => p[0]).sort((a, b) => a - b),
  inside.map((p) => p.id),
);

// claimed and cured people drop out
const claimed = open[0];
const cured = open[1];
assert.ok(claimed && cured);
assert.equal((await call(vera, 'POST', `/api/people/${claimed.id}/claim`, {})).status, 200);
sqlite.prepare("UPDATE people SET status = 'cured' WHERE id = ?").run(cured.id);
const after = await pins(WHOLE);
assert.equal(after.pins.length, open.length - 2);
assert.ok(!after.pins.some((p) => p[0] === claimed.id || p[0] === cured.id), 'neither the claimed nor the cured is on the map');

// what is sent is only ids and places: no names, addresses or phones
assert.doesNotMatch(JSON.stringify(after).replace(/[\d.,[\]{}":\-a-z]/g, ''), /./, 'only numbers and the flags around them');

// --- the filters Find people has narrow the pins the same way
const idsOf = (m: MapPins): number[] => m.pins.map((p) => p[0]).sort((x, y) => x - y);
const placedOpen = "assigned_to IS NULL AND status != 'cured' AND lat IS NOT NULL";
const sqlIds = (where: string, ...binds: string[]): number[] =>
  sqlite
    .prepare(`SELECT id FROM people WHERE ${placedOpen} AND ${where} ORDER BY id`)
    .all(...binds)
    .map((r) => Number(r.id));
const common = (column: string): string =>
  String(
    sqlite
      .prepare(
        `SELECT ${column} AS v FROM people WHERE ${placedOpen} AND ${column} != '' GROUP BY ${column} ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get()?.v,
  );
const aCity = common('city');
const aParty = common('party');
const aPrecinct = common('precinct');
const aLast = String(sqlite.prepare(`SELECT last_name AS v FROM people WHERE ${placedOpen} LIMIT 1`).get()?.v);
for (const [query, expected] of [
  [`city=${encodeURIComponent(aCity.toLowerCase())}`, sqlIds('city = ? COLLATE NOCASE', aCity)],
  [`party=${encodeURIComponent(aParty)}`, sqlIds('party = ?', aParty)],
  [`precinct=${encodeURIComponent(aPrecinct.toLowerCase())}`, sqlIds('precinct = ? COLLATE NOCASE', aPrecinct)],
  [`q=${encodeURIComponent(aLast)}`, sqlIds("(first_name || ' ' || last_name || ' ' || address) LIKE ?", `%${aLast}%`)],
  [`city=${encodeURIComponent(aCity)}&party=${encodeURIComponent(aParty)}`, sqlIds('city = ? COLLATE NOCASE AND party = ?', aCity, aParty)],
  ['city=nowhere', []],
] as const) {
  const got = idsOf(await pins(`${WHOLE}&${query}`));
  assert.deepEqual(got, expected, `the pins for ${query}`);
}
assert.ok(sqlIds('city = ? COLLATE NOCASE', aCity).length < open.length - 2, 'a city filter that leaves some out');

// a radius around the place the volunteer saved: the same people the list finds
assert.equal((await json('nina@example.com', `/api/map?${WHOLE}&miles=3`)).status, 400, 'a radius needs a saved place');
assert.equal((await call(vera, 'PUT', '/api/me/location', { lat: 33.45, lon: -112.07 })).status, 200);
const listed = new Set<number>();
for (let offset = 0; ; offset += 100) {
  const page = (await json(vera, `/api/people?miles=3&limit=100&offset=${offset}`)).data as { people: { id: number }[]; hasMore: boolean };
  for (const p of page.people) listed.add(p.id);
  if (!page.hasMore) break;
}
const nearby = idsOf(await pins(`${WHOLE}&miles=3`));
assert.deepEqual(
  nearby,
  [...listed].filter((id) => sqlIds('id = ?', String(id)).length === 1).sort((x, y) => x - y),
  'the pins within 3 miles are the placed people the list finds within 3 miles',
);
assert.ok(nearby.length > 0 && nearby.length < open.length - 2, 'a radius that leaves some out');
assert.equal((await json(vera, `/api/map?${WHOLE}&miles=500`)).status, 400, 'a radius that is too big');

// --- a box that is not a box
for (const query of [
  '',
  'west=-113&south=33&east=-111',
  'west=a&south=33&east=-111&north=34',
  'west=-111&south=33&east=-113&north=34',
  'west=-113&south=34&east=-111&north=33',
  'west=-113&south=33&east=-111&north=70',
  'west=2&south=33&east=3&north=34',
])
  assert.equal((await json(vera, `/api/map?${query}`)).status, 400, query);

// --- the basemap file
assert.equal((await call(vera, 'GET', '/tiles/ld8.pmtiles')).status, 404, 'no bucket bound: nothing to serve');
env.TILES = bucket;
assert.equal((await call(vera, 'GET', '/tiles/ld8.pmtiles')).status, 404, 'a bucket with no file in it');
assert.equal((await pins(WHOLE)).tiles, false);
heldFile = FILE;
assert.equal((await pins(WHOLE)).tiles, true, 'the map is told when the file is there');

const whole2 = await call(vera, 'GET', '/tiles/ld8.pmtiles');
assert.equal(whole2.status, 200);
assert.equal(whole2.headers.get('accept-ranges'), 'bytes');
assert.equal(whole2.headers.get('etag'), '"v1"');
assert.match(whole2.headers.get('cache-control') ?? '', /^private/, 'behind Access, so not for shared caches');
assert.deepEqual(new Uint8Array(await whole2.arrayBuffer()), FILE);

const part = await call(vera, 'GET', '/tiles/ld8.pmtiles', undefined, { range: 'bytes=10-19' });
assert.equal(part.status, 206);
assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
assert.equal(part.headers.get('content-length'), '10');
assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

const tail = await call(vera, 'GET', '/tiles/ld8.pmtiles', undefined, { range: 'bytes=-5' });
assert.equal(tail.status, 206);
assert.equal(tail.headers.get('content-range'), 'bytes 995-999/1000');
assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [227, 228, 229, 230, 231]);

const open2 = await call(vera, 'GET', '/tiles/ld8.pmtiles', undefined, { range: 'bytes=990-' });
assert.equal(open2.headers.get('content-range'), 'bytes 990-999/1000');

assert.equal((await call(vera, 'POST', '/tiles/ld8.pmtiles', {})).status, 405);
assert.equal((await call(vera, 'GET', '/tiles/other.pmtiles')).status, 200, 'any other path is just an asset');

// Not signed in: Access's check comes first, so the file is not served.
const before = asked;
const stranger = await handle(new Request('https://cure.example/tiles/ld8.pmtiles'), env);
assert.equal(stranger.status, 403);
assert.equal(asked, before, 'the bucket was not even asked');

console.log('test-map: ok');
