// Checks the CSV of people volunteers have worked on (worker/export.ts and GET /api/admin/export/worked.csv): who is in it, what it holds,
// that an organizer gets only their precincts, that a plain volunteer is refused, and that a cell cannot become a spreadsheet formula (a note's cell always starts with its date).
import assert from 'node:assert/strict';
import type { AuditEntry, Me } from '../src/api.d.ts';
import type { AccessVerifier } from '../worker/access.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { csvField } from '../worker/export.ts';
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
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    text: await res.text(),
  };
}
const me = async (email: string): Promise<number> => (JSON.parse((await call(email, 'GET', '/api/me')).text) as Me).id;

assert.equal(csvField('plain'), '"plain"');
assert.equal(csvField('say "hi"'), '"say ""hi"""');
assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
assert.equal(csvField('-1+1'), '"\'-1+1"');

const boss = await me('boss@example.com');
const anna = await me('anna@example.com'); // organizes Alma
const dora = await me('dora@example.com'); // a plain volunteer
sqlite.prepare("INSERT INTO organizers (volunteer_id, precinct, granted_by, granted_at) VALUES (?, 'Alma', 'x', ?)").run(anna, NOW);
sqlite
  .prepare(
    "INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (1, 'x', 'x.csv', ?, 0, 0, 0, 0, 0)",
  )
  .run(NOW);
let n = 0;
const person = (first: string, middle: string, last: string, precinct: string, status: string): number => {
  n += 1;
  return Number(
    sqlite
      .prepare(
        `INSERT INTO people (key, first_name, middle_name, last_name, precinct, status, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?) RETURNING id`,
      )
      .get(`k${n}`, first, middle, last, precinct, status, NOW, NOW, NOW)?.id,
  );
};
const note = (personId: number, by: number, body: string, at: string): void => {
  sqlite.prepare('INSERT INTO notes (person_id, volunteer_id, body, created_at) VALUES (?, ?, ?, ?)').run(personId, by, body, at);
};
sqlite.prepare("UPDATE volunteers SET name = 'Dora Doe' WHERE id = ?").run(dora);

const untouched = person('Una', '', 'Untouched', 'Alma', 'needs_contact'); // nothing done: left out
const left = person('Lee', 'M', 'Message', 'Alma', 'left_voicemail'); // a status, no notes, held by Dora
const noted = person('Nora', '', 'Noted', 'Alma', 'needs_contact'); // notes, still needs contact
const done = person('Cora', '', 'Cured', 'Alma', 'cured'); // cured: left out
const other = person('Olga', '', 'Other', 'Cairo', 'contacted'); // another precinct
note(noted, dora, 'Wrong number, try email', '2026-10-20T09:00:00.000Z');
note(noted, boss, '=1+1 and "quoted"\nsecond line', '2026-10-21T09:00:00.000Z');
note(done, dora, 'Cured already', '2026-10-19T09:00:00.000Z');
sqlite.prepare('UPDATE people SET assigned_to = ? WHERE id = ?').run(dora, left);
sqlite.prepare('UPDATE people SET assigned_to = ? WHERE id = ?').run(boss, other);
assert.ok(untouched);

// A plain volunteer cannot download it.
assert.equal((await call('dora@example.com', 'GET', '/api/admin/export/worked.csv')).status, 403);

// A site admin gets everything worked on, sorted by last name, as an attachment.
const all = await call('boss@example.com', 'GET', '/api/admin/export/worked.csv');
assert.equal(all.status, 200);
assert.equal(all.type, 'text/csv; charset=utf-8');
assert.match(all.disposition ?? '', /^attachment; filename="/);
assert.equal(
  all.text,
  [
    'Name,Status,Volunteer,Notes',
    '"Lee M Message","Left a message","Dora Doe",""',
    '"Nora Noted","Needs to be contacted","","2026-10-20 Dora Doe: Wrong number, try email\n2026-10-21 boss@example.com: =1+1 and ""quoted""\nsecond line"',
    '"Olga Other","Contacted","boss@example.com",""',
    '',
  ].join('\r\n'),
);
assert.ok(!all.text.includes('Cora'));
assert.ok(!all.text.includes('Untouched'));

// An organizer gets only their precincts.
const mine = (await call('anna@example.com', 'GET', '/api/admin/export/worked.csv')).text;
assert.ok(mine.includes('Nora Noted') && mine.includes('Lee M Message'));
assert.ok(!mine.includes('Olga'));

// Each download is in the audit log.
const log = JSON.parse((await call('boss@example.com', 'GET', '/api/admin/audit?limit=50')).text) as AuditEntry[];
assert.deepEqual(
  log.filter((e) => e.action === 'export.worked').map((e) => [e.actor, (e.detail as { people: number }).people]),
  [
    ['anna@example.com', 2],
    ['boss@example.com', 3],
  ],
);
console.log('test-export: ok');
