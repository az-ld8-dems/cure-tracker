// Checks the Worker's request handling (worker/app.ts, api.ts, uploads.ts) on a SQLite database with the real migration: who may do
// what, claims that cannot collide, the upload lifecycle (cured, still uncured, reappeared), the admin tools and the audit log.
import assert from 'node:assert/strict';
import type { AdminSettings, AdminStats, AuditEntry, Me, PeoplePage, Person, PersonDetail, ResetResult, Volunteer } from '../src/api.d.ts';
import { describeColumns, ImportError, KEY_VERSION } from '../src/sheet.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { type SheetPerson, sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { previewCsv, type Send, uploadCsv } from './lib/upload-test.ts';

// The Worker logs refusals and errors; the tests make some on purpose, so keep the log quiet and look at it when it matters.
const logged: string[] = [];
console.warn = (...a: unknown[]) => logged.push(a.join(' '));
console.error = (...a: unknown[]) => logged.push(a.join(' '));

const sqlite = migratedDb();
const count = (table: string): number => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const assetCalls: string[] = [];
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: 'Admin@Example.com, second@example.com',
  ALLOW_RESET: 'true',
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

// Everyone, as an admin sees them: the pages of GET /api/people?scope=all, put together and put in id order.
async function everyone(): Promise<Person[]> {
  const out: Person[] = [];
  for (;;) {
    const page = await ok<PeoplePage>(admin, 'GET', `/api/people?scope=all&limit=200&offset=${out.length}`);
    out.push(...page.people);
    if (!page.hasMore) return out.sort((a, b) => a.id - b.id);
  }
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
// The upload as the admin page does it (src/upload.ts), as whoever.
const sendAs =
  (as: string): Send =>
  (method, path, body) =>
    call(as, method, path, body);

for (const [method, path] of [
  ['GET', '/api/admin/uploads/columns'],
  ['POST', '/api/admin/uploads/stage'],
  ['POST', '/api/admin/uploads/stage/rows'],
  ['POST', '/api/admin/uploads/stage/plan'],
  ['POST', '/api/admin/uploads/stage/finish'],
] as const)
  assert.equal((await call(vera, method, path, method === 'GET' ? undefined : {})).status, 403, `volunteers cannot ${path}`);
assert.equal((await call(vera, 'GET', '/api/admin/stats')).status, 403);
assert.equal((await call(vera, 'GET', '/admin/')).status, 403, 'nor open the admin pages');
assert.equal((await call(admin, 'GET', '/admin/')).status, 200);
assert.deepEqual(assetCalls, ['/admin/'], 'only the admin got as far as the assets');
assert.equal((await call(vera, 'GET', '/')).status, 200);

// Without the ADMIN_EMAILS secret nobody is an admin: the pages and the API stay closed to everyone, the listed admin included.
{
  const noSecret = { ...env, ADMIN_EMAILS: undefined };
  const get = async (path: string) =>
    handle(new Request(`https://cure.example${path}`), noSecret, { verifier: verifierFor(admin), now: () => clock });
  assert.equal(((await (await get('/api/me')).json()) as Me).isAdmin, false);
  assert.equal((await get('/api/admin/stats')).status, 403);
  assert.equal((await get('/admin/')).status, 403);
}

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

// --- upload: sending and previewing change no one, finishing does
const preview = await previewCsv(sendAs(admin), csv(base));
assert.deepEqual([preview.added, preview.updated, preview.cured], [30, 0, 0]);
assert.equal((await everyone()).length, 0, 'a preview writes no one');
assert.equal(count('upload_rows'), 30, 'but the people wait in the staging table');
await assert.rejects(
  previewCsv(sendAs(admin), 'FIRST,LAST\nA,B\n'),
  (e) => e instanceof ImportError && /ADDRESS/.test(e.message),
  'a file that cannot be read stops in the browser',
);
assert.equal(preview.columns.ready, true);
assert.equal(preview.columns.choices.find((c) => c.field === 'precinct')?.header, 'PRECINCT_NAME');

// --- columns: the state may rename or reorder them, so an admin can say which is which
const renamed = csv(base).replace(
  'FIRST,MID,LAST,STATUSDATE,PARTY,LEGDIST,REASONCODE,PHONE,ADDRESS,PRECINCT_NAME',
  'Given,MID,Family,STATUSDATE,PARTY,LEGDIST,REASONCODE,PHONE,ADDRESS,Area',
);
await assert.rejects(previewCsv(sendAs(admin), renamed), ImportError, 'renamed names are not guessed');
const saved = await ok<Record<string, string>>(admin, 'GET', '/api/admin/uploads/columns');
assert.deepEqual(saved, {}, 'nothing is saved before the first upload');
const map = describeColumns(renamed, saved);
assert.equal(map.ready, false);
assert.deepEqual(
  map.choices.filter((c) => c.required && c.header === null).map((c) => c.field),
  ['first', 'last'],
);
const viaPick = await previewCsv(sendAs(admin), renamed, { picked: { first: 'Given', last: 'Family', precinct: 'Area' } });
assert.deepEqual([viaPick.added, viaPick.columns.ready], [30, true], 'with the columns chosen, the file reads');
assert.equal(viaPick.columns.choices.find((c) => c.field === 'precinct')?.header, 'Area');
assert.equal((await everyone()).length, 0, 'none of that wrote anyone');

// --- the Worker checks what the browser sends
const goodStart = {
  filename: 'x.csv',
  keyVersion: KEY_VERSION,
  expected: 1,
  rows: 1,
  skippedOtherDistrict: 0,
  skippedInvalid: 0,
  duplicates: 0,
  warnings: [],
  cities: [],
  columns: viaPick.columns,
  used: {},
};
for (const bad of [
  { keyVersion: 'two' },
  { expected: 0 },
  { expected: 'many' },
  { warnings: 'no' },
  { cities: [{ city: 1 }] },
  { columns: {} },
  { used: { shoe: 'A' } },
  { used: [] },
])
  assert.equal((await call(admin, 'POST', '/api/admin/uploads/stage', { ...goodStart, ...bad })).status, 400, JSON.stringify(bad));
const started = (await call(admin, 'POST', '/api/admin/uploads/stage', goodStart)).data as { token: string; chunk: number };
assert.equal(started.chunk, 100);
assert.equal(count('upload_rows'), 0, 'starting another upload drops what the last one left');
const person = (over: object = {}) => ({
  key: 'BO|ROE|1 E MAIN ST TEMPE AZ 85281',
  firstName: 'Bo',
  middleName: '',
  lastName: 'Roe',
  party: '',
  legdist: '',
  reasonCode: '',
  phone: '',
  address: '1 E MAIN ST TEMPE, AZ 85281',
  city: 'Tempe',
  zip: '85281',
  precinct: '',
  statusDate: null,
  ...over,
});
const rows = (token: string, list: unknown) => call(admin, 'POST', '/api/admin/uploads/stage/rows', { token, rows: list });
for (const bad of [
  [],
  'x',
  Array.from({ length: 201 }, () => person()),
  [person({ key: 'no pipes' })],
  [person({ key: 'a|b|c|d' })],
  [person({ firstName: 3 })],
  [person({ phone: 'x'.repeat(501) })],
  [person({ statusDate: '10/21/2026' })],
  [null],
])
  assert.equal((await rows(started.token, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
assert.equal((await rows('nope', [person()])).status, 409, 'rows for an upload that is not the current one');
assert.equal((await rows(started.token, [person()])).status, 200);
assert.equal((await rows(started.token, [person()])).status, 200, 'a repeated request changes nothing');
assert.equal(count('upload_rows'), 1);
assert.equal((await call(admin, 'POST', '/api/admin/uploads/stage/plan', { token: 'nope' })).status, 409);
assert.equal((await call(admin, 'POST', '/api/admin/uploads/stage/finish', { token: 'nope' })).status, 409);
const twoExpected = (await call(admin, 'POST', '/api/admin/uploads/stage', { ...goodStart, expected: 2 })).data as { token: string };
await rows(twoExpected.token, [person()]);
assert.equal(
  (await call(admin, 'POST', '/api/admin/uploads/stage/plan', { token: twoExpected.token })).status,
  409,
  'one of two people arrived',
);
assert.equal(
  (await call(admin, 'POST', '/api/admin/uploads/stage/finish', { token: twoExpected.token })).status,
  409,
  'and nothing is applied',
);
assert.equal((await rows(started.token, [person()])).status, 409, 'the first upload was replaced by the second');
assert.equal((await everyone()).length, 0);

const first = await uploadCsv(sendAs(admin), csv(base), { filename: 'day1.csv' });
assert.equal(first.id, 1);
assert.deepEqual(
  JSON.parse(String(sqlite.prepare("SELECT value FROM settings WHERE key = 'column_map'").get()?.value)).first,
  'FIRST',
  'the columns used are remembered',
);
assert.equal(
  JSON.parse(String(sqlite.prepare("SELECT detail FROM audit WHERE action = 'upload'").get()?.detail)).columns.precinct,
  'PRECINCT_NAME',
  'and the audit row says which',
);
// The people in the order of the sheet: the upload gives ids in key order, not sheet order.
const everyoneNow = await everyone();
const people = base.map(
  (b) => everyoneNow.find((p) => p.firstName === b.first && p.lastName === b.last) ?? assert.fail(`${b.first} ${b.last}`),
);
assert.equal(people.length, everyoneNow.length);
assert.equal(people.length, 30);
assert.ok(people.every((p) => p.status === 'needs_contact' && p.assignedTo === null && p.flag === null));
const p1 = people[0] ?? assert.fail('no people');
assert.equal(p1.city !== '', true);
assert.equal(p1.daysUncured, 22, 'days from the sheet date (10/01/2026) to today in Arizona (10/23)');

// The date in Arizona, not UTC: 2026-10-24 03:00 UTC is still the 23rd in Phoenix.
advance(15);
assert.equal((await everyone())[0]?.daysUncured, 22);
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
for (const m of ['call_and_text', 'voicemail_and_text', 'in_person', 'in_person_cured', 'in_person_other', 'in_person_door']) {
  const said = await ok<Person>(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'left_voicemail', method: m });
  assert.equal(said.contactMethod, m, `${m} is a way to have reached someone`);
}
await ok(vera, 'POST', `/api/people/${p1.id}/status`, { status: 'left_voicemail', method: 'call' });

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
const vmUnsaid = await ok<Person>(walt, 'POST', `/api/people/${p5.id}/status`, { status: 'left_voicemail' });
assert.equal(vmUnsaid.contactMethod, 'call', 'a voicemail with no method said is a phone call');

advance(24);
// Day 2: p4 and p5 are no longer on the sheet (cured); p1 is still there; a new person is.
const day2 = base
  .filter((_, i) => i !== 3 && i !== 4)
  .concat([{ first: 'Newt', last: 'Newman', address: '5 W NEW ST TEMPE, AZ 85281', precinct: 'ASU WEST' }]);
const small = await previewCsv(sendAs(admin), csv(day2.slice(0, 5)));
assert.equal(small.looksPartial, true);
const partial = await call(admin, 'POST', '/api/admin/uploads/stage/finish', { token: small.token });
assert.equal(partial.status, 409, 'a file that would cure nearly everyone needs a yes');
assert.deepEqual((partial.data as { problems: string[] }).problems, ['Send force: true to upload it anyway.']);
assert.equal((await everyone()).filter((p) => p.status === 'cured').length, 0, 'and changed nothing');
const up2 = await uploadCsv(sendAs(admin), csv(day2), { filename: 'day2.csv' });
assert.deepEqual(
  [up2.added, up2.updated, up2.cured, up2.stillUncured, up2.reappeared],
  [1, 28, 2, 0, 0],
  'p1 was contacted after the day 1 upload: not flagged yet',
);

const after2 = await everyone();
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
const up3 = await uploadCsv(sendAs(admin), csv(day2), { filename: 'day3.csv' });
assert.deepEqual([up3.added, up3.cured, up3.stillUncured], [0, 0, 2]);
const after3 = await everyone();
const p1c = after3.find((p) => p.id === p1.id) ?? assert.fail('p1');
assert.deepEqual(
  [p1c.status, p1c.flag, p1c.assignedTo],
  ['needs_contact', 'still_uncured', vid(vera)],
  'back to needs contact, with the same volunteer',
);

// Day 4: p4 shows up again
advance(24);
const day4 = day2.concat([base[3] ?? assert.fail('base 3')]);
const up4 = await uploadCsv(sendAs(admin), csv(day4));
assert.deepEqual([up4.reappeared, up4.added], [1, 0]);
const p4b = (await everyone()).find((p) => p.id === p4.id) ?? assert.fail('p4');
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
assert.equal((await everyone()).filter((p) => p.assignedTo === vid(vera) && p.status !== 'cured').length, 0);

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
const toFail = await previewCsv(sendAs(admin), csv(day4.concat([{ first: 'Zed', last: 'Zimmer', address: '8 W ELM ST MESA, AZ 85201' }])));
const [peopleBefore, uploadsBefore, auditBefore, stagedBefore] = [count('people'), count('uploads'), count('audit'), count('upload_rows')];
sqlite.exec("CREATE TRIGGER fail_upload BEFORE INSERT ON audit WHEN NEW.action = 'upload' BEGIN SELECT RAISE(ABORT, 'boom'); END");
const failed = await call(admin, 'POST', '/api/admin/uploads/stage/finish', { token: toFail.token });
sqlite.exec('DROP TRIGGER fail_upload');
assert.equal(failed.status, 500);
assert.ok(
  logged.some((l) => l.includes('boom')),
  'the failure was logged',
);
assert.deepEqual(
  [count('people'), count('uploads'), count('audit'), count('upload_rows')],
  [peopleBefore, uploadsBefore, auditBefore, stagedBefore],
  'and the staged sheet is still there to try again',
);

// --- the grace period: how many uploads a person marked contacted may stay on the list before it is an unsuccessful cure
assert.equal((await call(vera, 'PUT', '/api/admin/settings', { graceCycles: 0 })).status, 403, 'only admins change it');
assert.equal((await call(vera, 'GET', '/api/admin/settings')).status, 403);
assert.deepEqual(
  await ok(admin, 'GET', '/api/admin/settings'),
  { graceCycles: 1, resetEnabled: true },
  'one cycle of grace until an admin says otherwise',
);
for (const bad of [-1, 31, 1.5, null, '2']) {
  assert.equal((await call(admin, 'PUT', '/api/admin/settings', { graceCycles: bad })).status, 400, `graceCycles ${bad}`);
}

const fresh = (await everyone()).find((p) => p.assignedTo === null && p.status === 'needs_contact') ?? assert.fail('an open person');
await ok(vera, 'POST', `/api/people/${fresh.id}/claim`, {});
await ok(vera, 'POST', `/api/people/${fresh.id}/status`, { status: 'contacted' });
advance(24);
const withGrace = await previewCsv(sendAs(admin), csv(day4));
assert.equal(withGrace.stillUncured, 0, 'the first upload after the call is within a grace of one');

assert.deepEqual(await ok(admin, 'PUT', '/api/admin/settings', { graceCycles: 0 }), { graceCycles: 0, resetEnabled: true });
assert.deepEqual(await ok(admin, 'GET', '/api/admin/settings'), { graceCycles: 0, resetEnabled: true });
const noGrace = await previewCsv(sendAs(admin), csv(day4));
assert.equal(noGrace.stillUncured, 1, 'with no grace it is an unsuccessful cure at once');
await uploadCsv(sendAs(admin), csv(day4));
const unsuccessful = (await everyone()).find((p) => p.id === fresh.id) ?? assert.fail('fresh');
assert.deepEqual([unsuccessful.status, unsuccessful.flag, unsuccessful.assignedTo], ['needs_contact', 'still_uncured', vid(vera)]);
const settingsLog = (await ok<AuditEntry[]>(admin, 'GET', '/api/admin/audit?limit=200')).find((e) => e.action === 'settings');
assert.deepEqual(settingsLog?.detail, { graceCycles: { from: 1, to: 0 } });

// --- being seen costs a write at most every few minutes, and never stops a page from loading
const seenAt = () => String(sqlite.prepare('SELECT last_seen_at AS t FROM volunteers WHERE email = ?').get(vera)?.t);
await ok(vera, 'GET', '/api/me');
const first_seen = seenAt();
advance(0.05); // three minutes
await ok(vera, 'GET', '/api/me');
assert.equal(seenAt(), first_seen, 'seen again within five minutes: no write');
advance(0.1); // nine minutes since
await ok(vera, 'GET', '/api/me');
assert.notEqual(seenAt(), first_seen, 'after five minutes it is recorded');
// The database refuses writes (the free plan's daily limit): the page still loads, and so do the lists.
sqlite.exec("CREATE TRIGGER no_writes BEFORE UPDATE ON volunteers BEGIN SELECT RAISE(ABORT, 'daily write limit'); END");
advance(0.2);
assert.equal((await call(vera, 'GET', '/api/me')).status, 200, 'who is signed in comes back although the write fails');
assert.equal((await call(vera, 'GET', '/api/people')).status, 200);
sqlite.exec('DROP TRIGGER no_writes');

// --- reset: delete every voter, to start over after trying the tool with test data
const confirmReset = { confirm: 'delete all voters' };
assert.equal((await call(vera, 'POST', '/api/admin/reset', confirmReset)).status, 403, 'only admins');
assert.equal((await call(admin, 'POST', '/api/admin/reset', {})).status, 400, 'the request has to say what it is');
assert.equal((await call(admin, 'POST', '/api/admin/reset', { confirm: 'yes' })).status, 400);
env.ALLOW_RESET = 'false';
assert.equal((await call(admin, 'POST', '/api/admin/reset', confirmReset)).status, 403, 'a deployment can turn it off');
assert.equal((await ok<AdminSettings>(admin, 'GET', '/api/admin/settings')).resetEnabled, false);
env.ALLOW_RESET = 'true';
assert.equal((await ok<AdminSettings>(admin, 'GET', '/api/admin/settings')).resetEnabled, true);
const [peopleN, notesN, uploadsN] = [count('people'), count('notes'), count('uploads')];
assert.ok(peopleN > 0 && notesN > 0 && uploadsN > 0, 'there is something to delete');
const volunteersBefore = count('volunteers');
const wiped = await ok<ResetResult>(admin, 'POST', '/api/admin/reset', confirmReset);
assert.deepEqual(wiped.deleted, { people: peopleN, notes: notesN, uploads: uploadsN });
assert.deepEqual([count('people'), count('notes'), count('uploads')], [0, 0, 0]);
assert.equal(count('volunteers'), volunteersBefore, 'volunteers stay');
assert.deepEqual(await ok(admin, 'GET', '/api/admin/settings'), { graceCycles: 0, resetEnabled: true }, 'so do the settings');
assert.deepEqual(await everyone(), []);
const afterReset = await ok<AdminStats>(admin, 'GET', '/api/admin/stats');
assert.deepEqual([afterReset.totals.unassigned, afterReset.totals.cured, afterReset.lastUpload], [0, 0, null]);
const resetLog = (await ok<AuditEntry[]>(admin, 'GET', '/api/admin/audit?limit=5'))[0];
assert.deepEqual([resetLog?.action, resetLog?.actor, resetLog?.detail], ['reset', admin, wiped.deleted], 'the log keeps what happened');
const fresh2 = await uploadCsv(sendAs(admin), csv(base));
assert.deepEqual([fresh2.id, fresh2.added], [1, 30], 'a new upload starts over');

console.log('test-api: ok');
