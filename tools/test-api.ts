// Checks the Worker's request handling (worker/app.ts, api.ts, uploads.ts) on a SQLite database with the real migration: who may do
// what, claims that cannot collide, the upload lifecycle (cured, still uncured, reappeared), the admin tools and the audit log.
import assert from 'node:assert/strict';
import type { AdminStats, AuditEntry, Me, Person, PersonDetail, UploadPreview, Volunteer } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { type SheetPerson, sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

// The Worker logs refusals and errors; the tests make some on purpose, so keep the log quiet and look at it when it matters.
const logged: string[] = [];
console.warn = (...a: unknown[]) => logged.push(a.join(' '));
console.error = (...a: unknown[]) => logged.push(a.join(' '));

const sqlite = migratedDb();
const assetCalls: string[] = [];
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'Admin@Example.com, second@example.com',
  DB: sqliteD1(sqlite),
  ASSETS: {
    fetch: async (req) => {
      assetCalls.push(new URL(req.url).pathname);
      return new Response('asset', { status: 200 });
    },
  },
};

// The clock: each test step says what time it is, in UTC. 2026-10-23 05:00 UTC is still the 22nd in Arizona (UTC-7)...
let clock = new Date('2026-10-23T12:00:00Z');
const advance = (hours: number) => {
  clock = new Date(clock.getTime() + hours * 3_600_000);
};

const verifierFor = (email: string | null): AccessVerifier => ({
  verify: async () =>
    email === null ? { ok: false, reason: 'no token' } : { ok: true, identity: { email, serviceToken: null, sub: email } },
});

async function call(as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier: verifierFor(as), now: () => clock });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}

async function ok<T>(as: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await call(as, method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} as ${as}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data as T;
}

const admin = 'admin@example.com';
const vera = 'vera@example.com';
const walt = 'walt@example.com';

// --- access
assert.equal((await call(null, 'GET', '/api/me')).status, 403, 'no Access token');
assert.equal((await call(null, 'GET', '/')).status, 403);
assert.equal(
  (
    await handle(new Request('https://cure.example/api/me'), env, {
      verifier: { verify: async () => ({ ok: true, identity: { email: null, serviceToken: 'bot', sub: 'bot' } }) },
    })
  ).status,
  403,
  'a service token is not a volunteer',
);

// --- people to work with
const base = syntheticPeople(30);
const csv = (people: SheetPerson[]) => sheetCsv(people);

assert.equal((await call(vera, 'POST', '/api/admin/uploads/preview', { csv: csv(base) })).status, 403, 'volunteers cannot upload');
assert.equal((await call(vera, 'GET', '/api/admin/stats')).status, 403);
assert.equal((await call(vera, 'GET', '/admin/')).status, 403, 'nor open the admin pages');
assert.equal((await call(admin, 'GET', '/admin/')).status, 200);
assert.deepEqual(assetCalls, ['/admin/'], 'only the admin got as far as the assets');
assert.equal((await call(vera, 'GET', '/')).status, 200);

// --- me
const me = await ok<Me>(vera, 'GET', '/api/me');
assert.deepEqual([me.email, me.name, me.isAdmin], [vera, '', false]);
assert.equal((await ok<Me>(admin, 'GET', '/api/me')).isAdmin, true, 'the admin list ignores case and spaces');
assert.equal((await ok<Me>('second@example.com', 'GET', '/api/me')).isAdmin, true);
assert.equal((await ok<Me>(vera, 'PUT', '/api/me', { name: '  Vera Vale ' })).name, 'Vera Vale');
assert.equal((await call(vera, 'PUT', '/api/me', { name: '' })).status, 400);
await ok(walt, 'GET', '/api/me');
await ok(walt, 'PUT', '/api/me', { name: 'Walt' });
const volunteers = await ok<Volunteer[]>(vera, 'GET', '/api/volunteers');
assert.deepEqual(volunteers.map((v) => v.name || v.email).sort(), ['Vera Vale', 'Walt', admin, 'second@example.com'].sort());
const vid = (email: string) => volunteers.find((v) => v.email === email)?.id ?? assert.fail(email);

// --- requests are checked
assert.equal((await call(vera, 'POST', '/api/people/1/claim', undefined)).status, 415, 'POST needs JSON');
assert.equal((await call(vera, 'POST', '/api/people/1/claim', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
assert.equal((await call(vera, 'GET', '/api/nothing')).status, 404);
assert.equal((await call(vera, 'DELETE', '/api/people')).status, 405);
assert.equal((await call(vera, 'PUT', '/api/people/abc')).status, 404);

// --- upload: preview changes nothing, apply does
const preview = await ok<UploadPreview>(admin, 'POST', '/api/admin/uploads/preview', { csv: csv(base) });
assert.deepEqual([preview.added, preview.updated, preview.cured], [30, 0, 0]);
assert.equal((await ok<Person[]>(vera, 'GET', '/api/people')).length, 0, 'a preview writes nothing');
const bad = await call(admin, 'POST', '/api/admin/uploads/preview', { csv: 'FIRST,LAST\nA,B\n' });
assert.equal(bad.status, 422);
assert.match((bad.data as { error: string }).error, /ADDRESS/);

const first = await ok<UploadPreview & { id: number }>(admin, 'POST', '/api/admin/uploads', { csv: csv(base), filename: 'day1.csv' });
assert.equal(first.id, 1);
const people = await ok<Person[]>(vera, 'GET', '/api/people');
assert.equal(people.length, 30);
assert.ok(people.every((p) => p.status === 'needs_contact' && p.assignedTo === null && p.flag === null));
const p1 = people[0] ?? assert.fail('no people');
assert.equal(p1.city !== '', true);
assert.equal(p1.daysUncured, 22, 'days from the sheet date (10/01/2026) to today in Arizona (10/23)');

// The date in Arizona, not UTC: 2026-10-24 03:00 UTC is still the 23rd in Phoenix.
advance(15);
assert.equal((await ok<Person[]>(vera, 'GET', '/api/people'))[0]?.daysUncured, 22);
advance(-15);

// --- claims
const claimed = await ok<Person>(vera, 'POST', `/api/people/${p1.id}/claim`, {});
assert.equal(claimed.assignedTo, vid(vera));
const again = await ok<Person>(vera, 'POST', `/api/people/${p1.id}/claim`, {});
assert.equal(again.assignedTo, vid(vera), 'claiming your own person again is fine');
const lost = await call(walt, 'POST', `/api/people/${p1.id}/claim`, {});
assert.equal(lost.status, 409);
assert.match((lost.data as { error: string }).error, /Vera Vale/);
assert.equal((await call(walt, 'POST', '/api/people/9999/claim', {})).status, 404);

// Two volunteers claim the same person at once: exactly one wins.
const p2 = people[1] ?? assert.fail('no second person');
const race = await Promise.all([
  call(vera, 'POST', `/api/people/${p2.id}/claim`, {}),
  call(walt, 'POST', `/api/people/${p2.id}/claim`, {}),
]);
assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);

// --- release, status, notes: the assignee or an admin
assert.equal((await call(walt, 'POST', `/api/people/${p1.id}/release`, {})).status, 403);
assert.equal((await call(walt, 'POST', `/api/people/${p1.id}/status`, { status: 'contacted' })).status, 403);
assert.equal((await call(walt, 'POST', `/api/people/${p1.id}/notes`, { body: 'hi' })).status, 403);
assert.equal((await call(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'cured' })).status, 400, 'only an upload cures');
assert.equal((await call(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'contacted', method: 'pigeon' })).status, 400);

const vm = await ok<Person>(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'left_voicemail', method: 'call' });
assert.deepEqual([vm.status, vm.contactMethod], ['left_voicemail', 'call']);
const note = await ok<{ id: number; body: string }>(vera, 'POST', `/api/people/${p1.id}/notes`, { body: 'Left a message, try after 5.' });
assert.equal(note.body, 'Left a message, try after 5.');
assert.equal((await call(vera, 'POST', `/api/people/${p1.id}/notes`, { body: '   ' })).status, 400);
await ok(admin, 'POST', `/api/people/${p1.id}/notes`, { body: 'Admin note.' });
const detail = await ok<PersonDetail>(walt, 'GET', `/api/people/${p1.id}`);
assert.deepEqual(
  detail.notes.map((n) => [n.body, n.volunteerName]),
  [
    ['Admin note.', admin],
    ['Left a message, try after 5.', 'Vera Vale'],
  ],
  'everyone sees the notes, newest first',
);
assert.equal(detail.person.notesCount, 2);
assert.deepEqual(
  detail.history.map((h) => h.action),
  ['note', 'note', 'status', 'claim'],
);

const winner = race[0]?.status === 200 ? vera : walt;
const released = await ok<Person>(winner, 'POST', `/api/people/${p2.id}/release`, {});
assert.equal(released.assignedTo, null);
assert.equal((await ok<Person>(admin, 'POST', `/api/people/${p2.id}/claim`, {})).assignedTo, vid(admin));
assert.equal((await ok<Person>(admin, 'POST', `/api/people/${p2.id}/release`, {})).assignedTo, null, 'an admin can release anyone');

// --- the second day: p1 contacted by Vera (a day ago), p3 contacted since the last upload, p4 never listed again
const [, , p3, p4, p5] = people;
assert.ok(p3 && p4 && p5);
for (const p of [p3, p4]) await ok(vera, 'POST', `/api/people/${p.id}/claim`, {});
await ok(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'contacted' });
await ok(vera, 'POST', `/api/people/${p3.id}/status`, { status: 'contacted' });
await ok(vera, 'POST', `/api/people/${p4.id}/status`, { status: 'contacted' });
await ok(walt, 'POST', `/api/people/${p5.id}/claim`, {});
await ok(walt, 'POST', `/api/people/${p5.id}/status`, { status: 'left_voicemail' });

advance(24);
// Day 2: p4 and p5 are no longer on the sheet (cured); p1 is still there; a new person is.
const day2 = base
  .filter((_, i) => i !== 3 && i !== 4)
  .concat([{ first: 'Newt', last: 'Newman', address: '5 W NEW ST TEMPE, AZ 85281', precinct: 'ASU WEST' }]);
const partial = await call(admin, 'POST', '/api/admin/uploads', { csv: csv(day2.slice(0, 5)) });
assert.equal(partial.status, 409, 'a file that would cure nearly everyone needs a yes');
assert.equal((await ok<Person[]>(vera, 'GET', '/api/people')).filter((p) => p.status === 'cured').length, 0, 'and changed nothing');
const up2 = await ok<UploadPreview & { id: number }>(admin, 'POST', '/api/admin/uploads', { csv: csv(day2), filename: 'day2.csv' });
assert.deepEqual(
  [up2.added, up2.updated, up2.cured, up2.stillUncured, up2.reappeared],
  [1, 28, 2, 0, 0],
  'p1 was contacted after the day 1 upload: not flagged yet',
);

const after2 = await ok<Person[]>(vera, 'GET', '/api/people');
const byId = (id: number) => after2.find((p) => p.id === id) ?? assert.fail(`person ${id}`);
assert.equal(byId(p4.id).status, 'cured');
assert.equal(byId(p4.id).assignedTo, vid(vera), 'a cured person keeps their volunteer');
assert.equal(byId(p5.id).status, 'cured');
assert.equal(byId(p1.id).status, 'contacted');
assert.equal((await call(vera, 'POST', `/api/people/${p4.id}/status`, { status: 'needs_contact' })).status, 409);
assert.equal((await call(vera, 'POST', `/api/people/${p4.id}/claim`, {})).status, 409);
assert.equal((await call(admin, 'POST', `/api/admin/people/${p4.id}/assign`, { volunteerId: vid(walt) })).status, 409);

// Day 3: p1 and p3 have now been listed by two uploads since they were marked contacted: past the grace of one
advance(24);
const up3 = await ok<UploadPreview & { id: number }>(admin, 'POST', '/api/admin/uploads', { csv: csv(day2), filename: 'day3.csv' });
assert.deepEqual([up3.added, up3.cured, up3.stillUncured], [0, 0, 2]);
const after3 = await ok<Person[]>(vera, 'GET', '/api/people');
const p1c = after3.find((p) => p.id === p1.id) ?? assert.fail('p1');
assert.deepEqual(
  [p1c.status, p1c.flag, p1c.assignedTo],
  ['needs_contact', 'still_uncured', vid(vera)],
  'back to needs contact, with the same volunteer',
);

// Day 4: p4 shows up again
advance(24);
const day4 = day2.concat([base[3] ?? assert.fail('base 3')]);
const up4 = await ok<UploadPreview>(admin, 'POST', '/api/admin/uploads', { csv: csv(day4) });
assert.deepEqual([up4.reappeared, up4.added], [1, 0]);
const p4b = (await ok<Person[]>(vera, 'GET', '/api/people')).find((p) => p.id === p4.id) ?? assert.fail('p4');
assert.deepEqual([p4b.status, p4b.flag, p4b.assignedTo], ['needs_contact', 'reappeared', vid(vera)]);

// --- the admin panel
const stats = await ok<AdminStats>(admin, 'GET', '/api/admin/stats');
assert.equal(stats.totals.flagged, 3);
assert.equal(stats.totals.cured, 1, 'only p5 is cured now');
assert.equal(stats.flagged.length, 3);
assert.equal(stats.lastUpload?.id, 4);
const veraStats = stats.volunteers.find((v) => v.email === vera) ?? assert.fail('vera stats');
assert.equal(veraStats.assigned, 3, 'p1, p3 and p4');
assert.equal(veraStats.flagged, 3);
// 31 people were ever listed and p5 is cured, so 30 are open; Vera has p1, p3 and p4 of them.
assert.equal(stats.totals.unassigned, 27, 'open people nobody has claimed');

// Acting on a flagged person answers the flag; an admin can dismiss one too.
const answered = await ok<Person>(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'left_voicemail' });
assert.equal(answered.flag, null);
assert.equal((await ok<Person>(admin, 'POST', `/api/admin/people/${p3.id}/dismiss-flag`, {})).flag, null);
assert.equal((await ok<AdminStats>(admin, 'GET', '/api/admin/stats')).totals.flagged, 1);

// Moving people: one at a time, and everyone at once.
assert.equal((await ok<Person>(admin, 'POST', `/api/admin/people/${p3.id}/assign`, { volunteerId: vid(walt) })).assignedTo, vid(walt));
assert.equal((await call(admin, 'POST', `/api/admin/people/${p3.id}/assign`, { volunteerId: 9999 })).status, 404);
assert.equal((await call(vera, 'POST', `/api/admin/people/${p3.id}/assign`, { volunteerId: vid(vera) })).status, 403);
const moved = await ok<{ moved: number }>(admin, 'POST', `/api/admin/volunteers/${vid(vera)}/reassign`, { volunteerId: vid(walt) });
assert.equal(moved.moved, 2, "p1 and p4 were still Vera's");
assert.equal((await call(admin, 'POST', `/api/admin/volunteers/${vid(vera)}/reassign`, { volunteerId: vid(vera) })).status, 400);
assert.equal((await ok<Person[]>(vera, 'GET', '/api/people')).filter((p) => p.assignedTo === vid(vera) && p.status !== 'cured').length, 0);

// --- the audit log records all of it
const log = await ok<AuditEntry[]>(admin, 'GET', '/api/admin/audit?limit=200');
const actions = new Set(log.map((e) => e.action));
for (const a of [
  'volunteer.join',
  'volunteer.rename',
  'claim',
  'release',
  'status',
  'note',
  'upload',
  'import.cured',
  'import.still_uncured',
  'import.reappeared',
  'assign',
  'flag.dismiss',
  'reassign',
]) {
  assert.ok(actions.has(a), `the audit log has ${a}`);
}
assert.ok(
  log.every((e, i) => i === 0 || (log[i - 1]?.id ?? 0) > e.id),
  'newest first',
);
const page = await ok<AuditEntry[]>(admin, 'GET', `/api/admin/audit?limit=5&before=${log[4]?.id}`);
assert.equal(page[0]?.id, log[5]?.id, 'paging by id');
const personLog = await ok<AuditEntry[]>(admin, 'GET', `/api/admin/audit?person=${p4.id}`);
assert.ok(personLog.length > 0 && personLog.every((e) => e.personId === p4.id));
assert.ok(personLog[0]?.personName, "entries carry the person's name");
const uploads = await ok<{ id: number }[]>(admin, 'GET', '/api/admin/uploads');
assert.deepEqual(
  uploads.map((u) => u.id),
  [4, 3, 2, 1],
);

// --- a failed upload leaves nothing behind: make the last statement of the batch fail, and check that none of the others stuck
const count = (table: string) => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const [peopleBefore, uploadsBefore, auditBefore] = [count('people'), count('uploads'), count('audit')];
sqlite.exec("CREATE TRIGGER fail_upload BEFORE INSERT ON audit WHEN NEW.action = 'upload' BEGIN SELECT RAISE(ABORT, 'boom'); END");
const failed = await call(admin, 'POST', '/api/admin/uploads', {
  csv: csv(day4.concat([{ first: 'Zed', last: 'Zimmer', address: '8 W ELM ST MESA, AZ 85201' }])),
});
sqlite.exec('DROP TRIGGER fail_upload');
assert.equal(failed.status, 500);
assert.ok(
  logged.some((l) => l.includes('boom')),
  'the failure was logged',
);
assert.deepEqual([count('people'), count('uploads'), count('audit')], [peopleBefore, uploadsBefore, auditBefore]);

// --- the grace period: how many uploads a person marked contacted may stay on the list before it is an unsuccessful cure
assert.equal((await call(vera, 'PUT', '/api/admin/settings', { graceCycles: 0 })).status, 403, 'only admins change it');
assert.equal((await call(vera, 'GET', '/api/admin/settings')).status, 403);
assert.deepEqual(await ok(admin, 'GET', '/api/admin/settings'), { graceCycles: 1 }, 'one cycle of grace until an admin says otherwise');
for (const bad of [-1, 31, 1.5, null, '2']) {
  assert.equal((await call(admin, 'PUT', '/api/admin/settings', { graceCycles: bad })).status, 400, `graceCycles ${bad}`);
}

const fresh =
  (await ok<Person[]>(vera, 'GET', '/api/people')).find((p) => p.assignedTo === null && p.status === 'needs_contact') ??
  assert.fail('an open person');
await ok(vera, 'POST', `/api/people/${fresh.id}/claim`, {});
await ok(vera, 'POST', `/api/people/${fresh.id}/status`, { status: 'contacted' });
advance(24);
const withGrace = await ok<UploadPreview>(admin, 'POST', '/api/admin/uploads/preview', { csv: csv(day4) });
assert.equal(withGrace.stillUncured, 0, 'the first upload after the call is within a grace of one');

assert.deepEqual(await ok(admin, 'PUT', '/api/admin/settings', { graceCycles: 0 }), { graceCycles: 0 });
assert.deepEqual(await ok(admin, 'GET', '/api/admin/settings'), { graceCycles: 0 });
const noGrace = await ok<UploadPreview>(admin, 'POST', '/api/admin/uploads/preview', { csv: csv(day4) });
assert.equal(noGrace.stillUncured, 1, 'with no grace it is an unsuccessful cure at once');
await ok(admin, 'POST', '/api/admin/uploads', { csv: csv(day4) });
const unsuccessful = (await ok<Person[]>(vera, 'GET', '/api/people')).find((p) => p.id === fresh.id) ?? assert.fail('fresh');
assert.deepEqual([unsuccessful.status, unsuccessful.flag, unsuccessful.assignedTo], ['needs_contact', 'still_uncured', vid(vera)]);
const settingsLog = (await ok<AuditEntry[]>(admin, 'GET', '/api/admin/audit?limit=200')).find((e) => e.action === 'settings');
assert.deepEqual(settingsLog?.detail, { graceCycles: { from: 1, to: 0 } });

console.log('test-api: ok');
