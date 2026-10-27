// Checks migration 0012 (more contact methods) on a database that already holds people, as production does: the migrations before it are
// applied, synthetic rows go in, then 0012 runs the way wrangler runs it, in one transaction with foreign keys on. Every row, note and index
// must survive, the foreign keys must still hold, and the new methods must be accepted while an unknown one is still refused.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = new URL('../db/migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const last = '0012_contact_methods.sql';
assert.equal(files.at(-1), last, 'this test is about the newest migration; update it when another follows');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
for (const f of files.filter((n) => n < last)) db.exec(readFileSync(new URL(f, dir), 'utf8'));

db.exec(`INSERT INTO volunteers (id, email, name, created_at, last_seen_at) VALUES (1, 'vera@example.com', 'Vera Vale', 't', 't')`);
db.exec(
  `INSERT INTO uploads (id, uploaded_by, created_at, rows, added, cured, still_uncured, reappeared) VALUES (1, 'a@example.com', 't', 3, 3, 0, 0, 0)`,
);
const person = db.prepare(
  `INSERT INTO people (key, first_name, last_name, address, status, status_changed_at, contact_method, assigned_to, lat, lon, approximate,
     first_upload_id, last_upload_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 't', ?, ?, ?, ?, ?, 1, 1, 't', 't')`,
);
person.run('ada|test|1 test st', 'Ada', 'Test', '1 Test St', 'contacted', 'in_person', 1, 33.5, -112.1, 0);
person.run('bo|test|2 test st', 'Bo', 'Test', '2 Test St', 'left_voicemail', 'call', null, null, null, 1);
person.run('cy|test|3 test st', 'Cy', 'Test', '3 Test St', 'needs_contact', null, null, 33.6, -112.2, 0);
db.exec(`INSERT INTO notes (person_id, volunteer_id, body, created_at) VALUES (1, 1, 'Left a flyer.', 't'), (3, 1, 'No answer.', 't')`);

const dump = (sql: string) =>
  db
    .prepare(sql)
    .all()
    .map((r) => ({ ...r }));
const notesBefore = dump('SELECT * FROM notes ORDER BY id');
const before = dump('SELECT * FROM people ORDER BY id');
const indexesBefore = dump(
  `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'people' AND sql IS NOT NULL ORDER BY name`,
);
const notesIndexBefore = dump(`SELECT sql FROM sqlite_master WHERE name = 'notes' OR name = 'notes_person'`);
const columnsBefore = dump('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(\'people\')');

db.exec('BEGIN');
db.exec(readFileSync(new URL(last, dir), 'utf8'));
db.exec('COMMIT');

assert.deepEqual(dump('SELECT * FROM people ORDER BY id'), before, 'every person is as they were');
assert.deepEqual(dump('SELECT * FROM notes ORDER BY id'), notesBefore, 'the notes are still there');
assert.deepEqual(dump('PRAGMA foreign_key_check'), [], 'and still point at real people');
assert.deepEqual(
  dump(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'people' AND sql IS NOT NULL ORDER BY name`),
  indexesBefore,
  'the indexes are rebuilt as they were',
);
assert.deepEqual(
  dump('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(\'people\')'),
  columnsBefore,
  'the columns are the same',
);
assert.deepEqual(
  dump(`SELECT sql FROM sqlite_master WHERE name = 'notes' OR name = 'notes_person'`),
  notesIndexBefore,
  'notes and its index are as they were',
);
assert.equal(dump(`SELECT name FROM sqlite_master WHERE name IN ('people_new', 'notes_aside')`).length, 0, 'no leftover table');

const set = (id: number, method: string) => db.prepare('UPDATE people SET contact_method = ? WHERE id = ?').run(method, id);
for (const m of ['call', 'text', 'call_and_text', 'voicemail_and_text', 'email', 'in_person', 'in_person_other', 'in_person_door', 'other'])
  set(1, m);
assert.throws(() => set(1, 'carrier_pigeon'), /CHECK constraint/, 'an unknown method is still refused');
assert.throws(
  () => db.prepare(`INSERT INTO notes (person_id, volunteer_id, body, created_at) VALUES (99, 1, 'x', 't')`).run(),
  /FOREIGN KEY/,
  'foreign keys are enforced',
);

console.log('test-migration-methods: ok');
