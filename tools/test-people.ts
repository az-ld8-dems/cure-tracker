// Checks GET /api/people, the one list the pages read: its scopes and who may use them, the filters, the sort, the paging, and that the
// database answers the common ones from an index. Synthetic data on the real migrations, as in test-api.ts.
import assert from 'node:assert/strict';
import type { PeoplePage } from '../src/api.d.ts';
import { KEY_VERSION } from '../src/sheet.ts';
import { finishSheet, mergeAndPlan } from '../src/upload.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { previewCsv, requestOver, type Send, uploadCsv } from './lib/upload-test.ts';

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
  return { status: res.status, data: (await res.json()) as unknown };
}
const sendAs =
  (as: string): Send =>
  (method, path, body) =>
    call(as, method, path, body);
async function page(as: string, query: string): Promise<PeoplePage> {
  const r = await call(as, 'GET', `/api/people${query}`);
  assert.equal(r.status, 200, `${query}: ${JSON.stringify(r.data)}`);
  return r.data as PeoplePage;
}

const admin = 'admin@example.com';
const vera = 'vera@example.com';
// 120 people in 12 precincts, in the stock sheet's five cities, with status dates spread over twenty days.
const sheet = syntheticPeople(120).map((p, i) => ({ ...p, precinct: `PRECINCT ${String(i % 12).padStart(2, '0')}` }));
await uploadCsv(sendAs(admin), sheetCsv(sheet), { filename: 'day1.csv' });

// --- the pool is the default, a page at a time
const first = await page(vera, '');
assert.equal(first.people.length, 50, 'a page is 50 unless the page asks for more');
assert.equal(first.hasMore, true);
assert.equal((await page(vera, '?limit=200')).hasMore, false, 'the last page says so');
assert.equal((await page(vera, '?limit=120')).hasMore, false, 'a page that is exactly everyone has no more');
assert.equal((await page(vera, '?limit=119')).hasMore, true);
assert.equal(first.facets, undefined, 'facets only when asked for');
const days = first.people.map((p) => p.daysUncured ?? -1);
assert.deepEqual(
  days,
  [...days].sort((a, b) => b - a),
  'longest uncured first',
);

const seen = new Set<number>();
for (let offset = 0; offset < 120; offset += 40) {
  for (const p of (await page(vera, `?limit=40&offset=${offset}`)).people) seen.add(p.id);
}
assert.equal(seen.size, 120, 'pages neither repeat nor skip anyone');
assert.equal((await page(vera, '?offset=500')).people.length, 0, 'past the end is an empty page');

// --- filters
const withFacets = await page(vera, '?facets=1');
assert.equal(withFacets.facets?.precincts.length, 12);
assert.deepEqual(withFacets.facets?.parties, ['DEM', 'IND', 'REP']);
assert.ok(withFacets.facets?.cities.includes('Tempe'));

const tempe = await page(vera, '?city=tempe&limit=200');
assert.equal(tempe.people.length, 24, 'a city matches whole, in any case');
assert.ok(tempe.people.every((p) => p.city === 'Tempe'));
const precinct = await page(vera, '?precinct=precinct%2003&limit=200');
assert.equal(precinct.people.length, 10, 'a precinct matches whole, in any case');
assert.equal((await page(vera, '?precinct=cinct%2003')).people.length, 0, 'not part of one');
assert.equal(
  (await page(vera, '?party=IND&limit=200')).people.every((p) => p.party === 'IND'),
  true,
);
const named = await page(vera, `?q=${encodeURIComponent(sheet[7]?.last ?? '')}`);
assert.ok(
  named.people.some((p) => p.lastName === sheet[7]?.last),
  'search finds a last name',
);
assert.equal((await page(vera, '?q=%25')).people.length, 0, 'a % in the search is not a wildcard');
assert.equal((await page(vera, '?q=_')).people.length, 0, 'nor is an _');
const phone = sheet.find((p) => p.phone)?.phone ?? '';
assert.equal((await page(vera, `?q=${phone}`)).people.length, 0, 'a volunteer cannot search by phone');
assert.equal((await page(admin, `?scope=all&q=${phone}`)).people.length, 1, 'an admin can');

// --- sorting
const byName = (await page(vera, '?sort=name&limit=200')).people.map((p) => p.lastName.toLowerCase());
assert.deepEqual(byName, [...byName].sort(), 'by last name');
const byPrecinct = (await page(vera, '?sort=precinct&limit=200')).people.map((p) => p.precinct);
assert.deepEqual(byPrecinct, [...byPrecinct].sort(), 'by precinct');

// the other direction is the exact reverse
const names = (await page(vera, '?sort=name&limit=200')).people.map((p) => p.id);
const namesBack = (await page(vera, '?sort=name&dir=desc&limit=200')).people.map((p) => p.id);
assert.deepEqual(namesBack, [...names].reverse(), 'dir=desc reverses the name sort');
const newest = (await page(vera, '?dir=desc&limit=200')).people.map((p) => p.daysUncured ?? -1);
assert.deepEqual(
  newest,
  [...newest].sort((a, b) => a - b),
  'newest first when the days sort is reversed',
);

// --- scopes: claimed people leave the pool and show under mine, and everyone is for admins
const claimed = first.people.slice(0, 3);
for (const p of claimed) assert.equal((await call(vera, 'POST', `/api/people/${p.id}/claim`, {})).status, 200);
const afterClaim = await page(vera, '?limit=200');
assert.equal(afterClaim.people.length, 117);
assert.ok(afterClaim.people.every((p) => !claimed.some((c) => c.id === p.id)));
const mine = await page(vera, '?scope=mine');
assert.deepEqual(mine.people.map((p) => p.id).sort(), claimed.map((p) => p.id).sort());
assert.equal((await page(admin, '?scope=mine')).people.length, 0, 'mine is the caller only');
assert.equal((await page(admin, '?scope=all&limit=200')).people.length, 120);
assert.equal((await call(vera, 'GET', '/api/people?scope=all')).status, 403, 'volunteers cannot list everyone');

// --- bad questions are refused
for (const bad of [
  '?scope=nobody',
  '?sort=password',
  '?dir=sideways',
  '?limit=0',
  '?limit=201',
  '?limit=x',
  '?offset=-1',
  `?q=${'x'.repeat(101)}`,
]) {
  assert.equal((await call(vera, 'GET', `/api/people${bad}`)).status, 400, bad);
}
assert.equal((await call(vera, 'GET', '/api/people?scope=mine&limit=1000')).status, 200, 'mine may ask for a thousand');

// --- the database answers the common questions from an index
const plan = (sql: string): string =>
  sqlite
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(' | ');
const pool = "p.assigned_to IS NULL AND p.status != 'cured'";
const poolPlan = plan(`SELECT p.id FROM people p WHERE ${pool} ORDER BY COALESCE(p.status_date, '9999-12-31'), p.id LIMIT 50`);
assert.match(poolPlan, /people_pool/);
assert.doesNotMatch(poolPlan, /TEMP B-TREE/, 'the default pool page is read in index order, with no sort');
assert.match(plan("SELECT p.id FROM people p WHERE p.assigned_to = 3 AND p.status != 'cured'"), /people_mine/);
assert.match(
  plan("SELECT p.id FROM people p WHERE p.flag IS NOT NULL AND p.status != 'cured' ORDER BY p.status_changed_at DESC, p.id"),
  /people_flagged/,
);

// the filters and the other sorts read an index too, in index order
const filtered = (where: string, order: string) => plan(`SELECT p.id FROM people p WHERE ${pool} AND ${where} ORDER BY ${order} LIMIT 51`);
const DAYS = "COALESCE(p.status_date, '9999-12-31'), p.id";
for (const [name, where, order, index] of [
  ['a city', 'p.city COLLATE NOCASE = ?', DAYS, 'people_pool_city'],
  ['a precinct', 'p.precinct COLLATE NOCASE = ?', DAYS, 'people_pool_precinct'],
  ['the precinct sort', 'p.party = ?', `p.precinct COLLATE NOCASE, ${DAYS}`, 'people_pool_precinct'],
  ['the name sort', 'p.party = ?', 'p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE, p.id', 'people_pool_name'],
] as const) {
  const p = filtered(where, order);
  assert.match(p, new RegExp(index), `${name} uses ${index}: ${p}`);
  assert.doesNotMatch(p, /TEMP B-TREE/, `${name} needs no sort: ${p}`);
}

// --- the filters' values are stored by the upload, not found by scanning
const stored = JSON.parse(String(sqlite.prepare("SELECT value FROM settings WHERE key = 'facets'").get()?.value));
assert.equal(stored.precincts.length, 12);
assert.deepEqual(withFacets.facets, stored, 'a page reads what the upload stored');
sqlite.prepare("DELETE FROM settings WHERE key = 'facets'").run();
assert.equal((await page(vera, '?facets=1')).facets?.precincts.length, 12, 'missing, they are worked out once');
assert.ok(sqlite.prepare("SELECT 1 FROM settings WHERE key = 'facets'").get(), 'and stored');

// --- an upload writes only the people who changed
const upload2 = await uploadCsv(sendAs(admin), sheetCsv(sheet), { filename: 'day2.csv' });
assert.deepEqual([upload2.added, upload2.cured, upload2.updated], [0, 0, 120], 'the same sheet: everyone is known');
assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people WHERE last_upload_id = 2').get()?.n), 0, 'and nobody was rewritten');
const moved = sheet.map((p, i) => (i === 5 ? { ...p, precinct: 'PRECINCT 99' } : p));
await uploadCsv(sendAs(admin), sheetCsv(moved), { filename: 'day3.csv' });
assert.equal(
  Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people WHERE last_upload_id = 3').get()?.n),
  1,
  'a changed precinct rewrites that one person',
);

// --- a corrected record: marked as the same person, the upload updates them and keeps their notes, volunteer and status
const subject = (await page(vera, '?limit=200')).people[0] ?? assert.fail('someone in the pool');
await call(vera, 'POST', `/api/people/${subject.id}/claim`, {});
await call(vera, 'POST', `/api/people/${subject.id}/notes`, { body: 'Prefers texts.' });
await call(vera, 'POST', `/api/people/${subject.id}/status`, { status: 'left_voicemail' });
const sameAsSubject = (p: (typeof sheet)[number]) =>
  `${p.first} ${p.last}`.toLowerCase() === `${subject.firstName} ${subject.lastName}`.toLowerCase();
const corrected = moved.map((p) => (sameAsSubject(p) ? { ...p, last: `${p.last}son` } : p));
assert.ok(
  corrected.some((p) => p.last.endsWith('son')),
  'the subject is on the sheet',
);
const request = requestOver(sendAs(admin));
const staged = await previewCsv(sendAs(admin), sheetCsv(corrected), { filename: 'day4.csv' });
assert.deepEqual(
  [staged.added, staged.cured, staged.possibleMatchCount],
  [1, 1, 1],
  'a corrected last name is one person gone and one new',
);
const pair = staged.possibleMatches[0] ?? assert.fail('the pair');
assert.equal(pair.kind, 'surname', 'same first name and address, another last name');
assert.equal(pair.existing.id, subject.id);
assert.equal(pair.merged, false);

// the checks the API makes
const mergeCall = (token: string, merges: unknown) => call(admin, 'POST', '/api/admin/uploads/stage/merges', { token, merges });
const someoneElse = (await page(vera, '?limit=3')).people.find((p) => p.id !== subject.id) ?? assert.fail('another person');
assert.equal(
  (await mergeCall(staged.token, [{ id: someoneElse.id, key: pair.incoming.key }])).status,
  400,
  'two people who do not look alike',
);
assert.equal(
  (await mergeCall(staged.token, [{ id: pair.existing.id, key: 'NOBODY|HERE|1 A ST' }])).status,
  400,
  'a person who is not on the sheet',
);
assert.equal(
  (
    await mergeCall(staged.token, [
      { id: pair.existing.id, key: pair.incoming.key },
      { id: pair.existing.id, key: pair.incoming.key },
    ])
  ).status,
  400,
  'one person twice',
);
assert.equal((await mergeCall(staged.token, [{ id: 'x', key: pair.incoming.key }])).status, 400);
assert.equal((await mergeCall(staged.token, 'all')).status, 400);
assert.equal((await mergeCall('nope', [])).status, 409, 'not the current upload');
assert.equal((await call(vera, 'POST', '/api/admin/uploads/stage/merges', { token: staged.token, merges: [] })).status, 403);
assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM upload_merges').get()?.n), 0, 'none of those stuck');

// marking them
const merged = await mergeAndPlan(staged.token, [{ id: pair.existing.id, key: pair.incoming.key }], request);
assert.deepEqual([merged.added, merged.cured, merged.updated], [0, 0, 120], 'nobody is cured or added');
assert.equal(merged.possibleMatches[0]?.merged, true, 'the list still shows the pair, marked');
assert.equal(
  merged.warnings.some((w) => /look like someone who disappeared/.test(w)),
  false,
  'nothing is left to check',
);
const unmarked = await mergeAndPlan(staged.token, [], request);
assert.deepEqual([unmarked.added, unmarked.cured], [1, 1], 'unmarking puts it back');
await mergeAndPlan(staged.token, [{ id: pair.existing.id, key: pair.incoming.key }], request);

const done = await finishSheet(staged.token, false, request);
assert.deepEqual([done.added, done.cured], [0, 0]);
const after = await call(vera, 'GET', `/api/people/${subject.id}`);
const person2 = after.data as {
  person: { id: number; lastName: string; assignedTo: number | null; status: string };
  notes: { body: string }[];
};
assert.equal(person2.person.id, subject.id, 'the same record');
assert.equal(person2.person.lastName.toLowerCase().endsWith('son'), true, 'with the corrected name');
assert.notEqual(person2.person.assignedTo, null, 'with their volunteer');
assert.equal(person2.person.status, 'left_voicemail', 'and their status');
assert.deepEqual(
  person2.notes.map((n) => n.body),
  ['Prefers texts.'],
  'and their notes',
);
assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people').get()?.n), 120, 'nobody was added');
assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE status = 'cured'").get()?.n), 0, 'nobody was cured');
const mergedLog = sqlite.prepare("SELECT person_id, detail FROM audit WHERE action = 'import.merged'").get();
assert.equal(Number(mergedLog?.person_id), subject.id);
assert.equal(JSON.parse(String(mergedLog?.detail)).was.name.toLowerCase(), `${subject.firstName} ${subject.lastName}`.toLowerCase());
assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM upload_merges').get()?.n), 0, 'the marks are cleared');

// --- the same person, written two ways in two dumps, is the same person
const unitSheet = (address: string) => sheetCsv([{ first: 'Una', last: 'Unit', address, precinct: 'ARCADIA' }]);
await uploadCsv(sendAs(admin), unitSheet('1 E MAIN ST APT 2129 TEMPE, AZ 85281'), { filename: 'u1.csv', force: true });
const apt = sqlite.prepare("SELECT id FROM people WHERE last_name = 'Unit'").get();
const again2 = await uploadCsv(sendAs(admin), unitSheet('1 East Main Street 2129 Tempe, AZ 85281-0001'), {
  filename: 'u2.csv',
  force: true,
});
assert.deepEqual(
  [again2.added, again2.cured, again2.updated],
  [0, 0, 1],
  'the unit word, the spelled-out street and the ZIP+4 make no new person',
);
assert.equal(Number(sqlite.prepare("SELECT id FROM people WHERE last_name = 'Unit'").get()?.id), Number(apt?.id), 'the same record');

// --- the way people are matched is versioned: after it changes, the page says so before everyone looks new
assert.equal(
  sqlite.prepare("SELECT value FROM settings WHERE key = 'key_version'").get()?.value,
  String(KEY_VERSION),
  'an upload records it',
);
const quiet = await previewCsv(sendAs(admin), unitSheet('1 E MAIN ST 2129'));
assert.equal(
  quiet.warnings.some((w) => /way people are matched/.test(w)),
  false,
);
sqlite.prepare("UPDATE settings SET value = '1' WHERE key = 'key_version'").run();
const loud = await previewCsv(sendAs(admin), unitSheet('1 E MAIN ST 2129'));
assert.match(loud.warnings[0] ?? '', /way people are matched changed/, 'the old keys are not the new keys');
const stale = await call(admin, 'POST', '/api/admin/uploads/stage', {
  filename: 'x',
  keyVersion: KEY_VERSION - 1,
  expected: 1,
  rows: 1,
  skippedOtherDistrict: 0,
  skippedInvalid: 0,
  duplicates: 0,
  warnings: [],
  cities: [],
  columns: loud.columns,
  used: {},
});
assert.equal(stale.status, 409, `a page from before the change is told to reload: ${JSON.stringify(stale.data)}`);
sqlite.exec('DELETE FROM notes');
sqlite.exec('DELETE FROM people');
const empty = await previewCsv(sendAs(admin), unitSheet('1 E MAIN ST 2129'));
assert.equal(
  empty.warnings.some((w) => /way people are matched/.test(w)),
  false,
  'with nobody here there is nothing to mismatch',
);

console.log('test-people: ok');
