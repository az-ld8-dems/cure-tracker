// Checks precinct organizers (worker/organizers.ts, and the routes in worker/api.ts that use them): what a volunteer with some precincts,
// all precincts or none may do, that site admins keep everything, and that every grant and move is audited.
import assert from 'node:assert/strict';
import type { AdminStats, AuditEntry, Me, OrganizerGrant, OrganizerList, PeoplePage, Person } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

console.warn = () => {};
console.error = () => {};

const sqlite = migratedDb();
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'boss@example.com',
  ALLOW_RESET: 'true',
  DB: sqliteD1(sqlite),
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
};
const NOW = '2026-10-23T12:00:00.000Z';
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

// Synthetic people in three precincts and one with none; the upload the schema wants first.
sqlite
  .prepare(
    "INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (1, 'x', 'x.csv', ?, 0, 0, 0, 0, 0)",
  )
  .run(NOW);
const precincts = ['101', '102', '205', ''];
for (const [i, precinct] of precincts.entries()) {
  for (const n of [1, 2]) {
    sqlite
      .prepare(
        `INSERT INTO people (key, first_name, last_name, precinct, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(`k${i}${n}`, `Test${i}${n}`, 'Person', precinct, NOW, NOW, NOW);
  }
}
const idsIn = (precinct: string): number[] =>
  sqlite
    .prepare('SELECT id FROM people WHERE precinct = ? ORDER BY id')
    .all(precinct)
    .map((r) => Number(r.id));
const assignedTo = (id: number): number | null => {
  const v = sqlite.prepare('SELECT assigned_to AS a FROM people WHERE id = ?').get(id)?.a;
  return v === null || v === undefined ? null : Number(v);
};

const volunteer = async (email: string): Promise<number> => ((await call(email, 'GET', '/api/me')).data as Me).id;
const boss = await volunteer('boss@example.com');
const anna = await volunteer('anna@example.com'); // organizes 101
const carl = await volunteer('carl@example.com'); // organizes everything
const dora = await volunteer('dora@example.com'); // a plain volunteer
const eve = await volunteer('eve@example.com'); // a recipient of moves

// A plain volunteer is nothing special: no admin pages, no admin routes, no scope.
assert.equal(((await call('dora@example.com', 'GET', '/api/me')).data as Me).organizes, null);
assert.equal((await call('dora@example.com', 'GET', '/admin/')).status, 403);
assert.equal((await call('dora@example.com', 'GET', '/api/admin/stats')).status, 403);
assert.equal((await call('dora@example.com', 'GET', '/api/people?scope=all')).status, 403);
assert.equal((await call('dora@example.com', 'PUT', `/api/admin/volunteers/${dora}/organizer`, { all: true, precincts: [] })).status, 403);

// Only a site admin grants, and the input is checked.
assert.equal((await call('anna@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, { all: true, precincts: [] })).status, 403);
assert.equal((await call('boss@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, { all: 'yes', precincts: [] })).status, 400);
assert.equal(
  (await call('boss@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, { all: false, precincts: ['*'] })).status,
  400,
);
assert.equal(
  (await call('boss@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, { all: false, precincts: [''] })).status,
  400,
);
assert.equal(
  (await call('boss@example.com', 'PUT', `/api/admin/volunteers/999/organizer`, { all: false, precincts: ['101'] })).status,
  404,
);
const granted = await call('boss@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, {
  all: false,
  precincts: [' 101 ', '101'],
});
assert.deepEqual(granted.data as OrganizerGrant, { volunteerId: anna, all: false, precincts: ['101'] });
assert.equal(
  (await call('boss@example.com', 'PUT', `/api/admin/volunteers/${carl}/organizer`, { all: true, precincts: ['205'] })).status,
  200,
);
const list = (await call('boss@example.com', 'GET', '/api/admin/organizers')).data as OrganizerList;
assert.deepEqual(list.grants, [
  { volunteerId: anna, all: false, precincts: ['101'] },
  { volunteerId: carl, all: true, precincts: [] },
]);
assert.deepEqual(list.precincts, ['101', '102', '205']);

// The organizer is let into the admin pages and the organizer routes, and told what they organize.
assert.deepEqual(((await call('anna@example.com', 'GET', '/api/me')).data as Me).organizes, { all: false, precincts: ['101'] });
assert.equal((await call('anna@example.com', 'GET', '/admin/')).status, 200);
// ...but not the site admin's: uploads, the geocoder, the audit log, settings, reset, grants.
for (const [method, path] of [
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/uploads'],
  ['GET', '/api/admin/settings'],
  ['POST', '/api/admin/reset'],
  ['POST', '/api/admin/geocode'],
  ['GET', '/api/admin/organizers'],
  ['POST', '/api/admin/uploads/stage'],
] as const)
  assert.equal((await call('anna@example.com', method, path, method === 'GET' ? undefined : {})).status, 403, `${method} ${path}`);

// People found: an organizer sees their precincts and the ones with no precinct, nobody else's.
const found = (await call('anna@example.com', 'GET', '/api/people?scope=all&limit=100')).data as PeoplePage;
assert.deepEqual(new Set(found.people.map((p: Person) => p.precinct)), new Set(['101', '']));
assert.equal(((await call('carl@example.com', 'GET', '/api/people?scope=all&limit=100')).data as PeoplePage).people.length, 8);

// Moving: inside the precincts, and the blank one, yes; outside, no, and nothing changes.
const [in101] = idsIn('101');
const [in102] = idsIn('102');
const [blank] = idsIn('');
if (in101 === undefined || in102 === undefined || blank === undefined) throw new Error('no people');
const move = (as: string, id: number, to: number | null) => call(as, 'POST', `/api/admin/people/${id}/assign`, { volunteerId: to });
assert.equal((await move('anna@example.com', in101, eve)).status, 200);
assert.equal(assignedTo(in101), eve);
assert.equal((await move('anna@example.com', blank, eve)).status, 200);
assert.equal((await move('anna@example.com', in102, eve)).status, 403);
assert.equal(assignedTo(in102), null);
assert.equal((await move('dora@example.com', in101, dora)).status, 403);
assert.equal((await move('carl@example.com', in102, eve)).status, 200);
assert.equal((await move('boss@example.com', idsIn('205')[0] ?? 0, eve)).status, 200);

// Flags: an organizer clears them only in their precincts.
sqlite.prepare("UPDATE people SET flag = 'reappeared' WHERE id IN (?, ?)").run(in101, in102);
assert.equal((await call('anna@example.com', 'POST', `/api/admin/people/${in102}/dismiss-flag`, {})).status, 403);
assert.equal((await call('anna@example.com', 'POST', `/api/admin/people/${in101}/dismiss-flag`, {})).status, 200);

// The numbers an organizer sees are their own: flagged people, volunteers' counts, and nothing about uploads.
sqlite.prepare("UPDATE people SET flag = 'reappeared' WHERE id = ?").run(in101);
const stats = (await call('anna@example.com', 'GET', '/api/admin/stats')).data as AdminStats;
assert.deepEqual(
  stats.flagged.map((p) => p.id),
  [in101],
);
assert.equal(stats.lastUpload, null);
assert.equal(stats.volunteers.find((v) => v.id === eve)?.assigned, 2); // in101 and the blank one, not the other two
assert.equal(
  ((await call('boss@example.com', 'GET', '/api/admin/stats')).data as AdminStats).volunteers.find((v) => v.id === eve)?.assigned,
  4,
);

// Moving everyone a volunteer has: an organizer moves only the people of their precincts.
const reassign = await call('anna@example.com', 'POST', `/api/admin/volunteers/${eve}/reassign`, { volunteerId: dora });
assert.deepEqual(reassign.data, { moved: 2 });
assert.equal(assignedTo(in101), dora);
assert.equal(assignedTo(in102), eve);

// Taking the grant away makes them a plain volunteer again, at once.
assert.equal((await call('boss@example.com', 'PUT', `/api/admin/volunteers/${anna}/organizer`, { all: false, precincts: [] })).status, 200);
assert.equal(((await call('anna@example.com', 'GET', '/api/me')).data as Me).organizes, null);
assert.equal((await call('anna@example.com', 'GET', '/admin/')).status, 403);
assert.equal((await move('anna@example.com', in101, eve)).status, 403);

// A site admin always organizes everything, with or without a grant row.
assert.deepEqual(((await call('boss@example.com', 'GET', '/api/me')).data as Me).organizes, { all: true, precincts: [] });
assert.equal(boss > 0, true);

// Every grant and move is in the audit log.
const log = (await call('boss@example.com', 'GET', '/api/admin/audit?limit=200')).data as AuditEntry[];
const actions = log.map((e) => e.action);
assert.equal(actions.filter((a) => a === 'organizer.set').length, 3);
assert.equal(actions.filter((a) => a === 'assign').length, 4);
assert.ok(actions.includes('reassign'));
assert.ok(actions.includes('flag.dismiss'));
console.log('test-organizers: ok');
