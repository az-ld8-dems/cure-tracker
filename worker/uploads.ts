// Takes in the state's sheet. The admin's browser reads the CSV (src/sheet.ts) and sends the people in small requests, because a free
// Worker has about 10 ms of CPU a request and parsing a large sheet takes far longer. Each request puts rows in upload_rows with one
// SQL statement; the preview and the upload then compare them with the people inside D1, as set operations, so the Worker does almost
// nothing however large the sheet. The upload applies everything in one batch (D1 runs a batch as a transaction), so a failed upload
// leaves no trace. tools/lib/plan.ts is the same rules written as plain functions, and tools/test-upload-sql.ts holds the two to the
// same answer. Only erasable TypeScript.
import type { ColumnPick, PossibleMatch, StageStart, StageStarted, UploadPreview, UploadRecord } from '../src/api.d.ts';
import type { IncomingPerson } from '../src/sheet.ts';
import { FIELDS } from '../src/sheet.ts';
import type { Db, Stmt } from './db.ts';

// People the Worker takes in one request. The Worker's CPU for a request is a JSON parse of this many rows and one statement, so it
// is kept small; the page asks for this many at a time.
export const STAGE_CHUNK = 100;
// The most the Worker will ever take in one request, whatever the page sends.
export const MAX_STAGE_ROWS = 200;
// The most people in one sheet.
export const MAX_STAGE_PEOPLE = 60_000;
export const MATCH_LIMIT = 25;
// Looking for corrected names compares every person who left with every person who arrived; past this many pairs it is skipped.
const MATCH_PAIRS_LIMIT = 1_000_000;

// The values the Find people filters offer: the cities, parties and precincts of everyone still open. They only change when an upload
// does, so the upload stores them (settings.facets) and a page reads one row instead of scanning the people.
interface Facets {
  cities: string[];
  parties: string[];
  precincts: string[];
}

const distinct = (values: string[]): string[] => [...new Set(values)].filter((v) => v !== '').sort();

function facetsOf(people: { city: string; party: string; precinct: string }[]): Facets {
  return {
    cities: distinct(people.map((p) => p.city)),
    parties: distinct(people.map((p) => p.party)),
    precincts: distinct(people.map((p) => p.precinct)),
  };
}

const saveFacets = (db: Db, facets: Facets): Stmt =>
  db
    .prepare("INSERT INTO settings (key, value) VALUES ('facets', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(facets));

// What the filters offer. Missing (before the first upload since this was added, or after a reset), it is worked out from the open people
// and stored, which costs one scan, once.
export async function savedFacets(db: Db): Promise<Facets> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'facets'").first<{ value: string }>();
  try {
    const raw: unknown = row ? JSON.parse(row.value) : null;
    if (typeof raw === 'object' && raw !== null) {
      const f = raw as Record<string, unknown>;
      const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
      if (strings(f.cities) && strings(f.parties) && strings(f.precincts))
        return { cities: f.cities, parties: f.parties, precincts: f.precincts };
    }
  } catch {
    // Damaged: work it out again.
  }
  const { results } = await db
    .prepare("SELECT DISTINCT city, party, precinct FROM people WHERE status != 'cured'")
    .all<{ city: string; party: string; precinct: string }>();
  const facets = facetsOf(results);
  if (results.length > 0) await saveFacets(db, facets).run();
  return facets;
}

// How many uploads a person marked contacted may stay on the list before it counts as an unsuccessful cure (the admins' setting).
export const DEFAULT_GRACE_CYCLES = 1;
export const MAX_GRACE_CYCLES = 30;

export async function graceCycles(db: Db): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'grace_cycles'").first<{ value: string }>();
  const n = row ? Number(row.value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_GRACE_CYCLES ? n : DEFAULT_GRACE_CYCLES;
}

// Which header of the sheet fed each field the last time an admin uploaded one. A header the file no longer has is ignored.
export async function savedColumns(db: Db): Promise<ColumnPick> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'column_map'").first<{ value: string }>();
  let raw: unknown = null;
  try {
    raw = row ? JSON.parse(row.value) : null;
  } catch {
    // A damaged setting is the same as none.
  }
  const saved: ColumnPick = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const f of FIELDS) {
      const v = (raw as Record<string, unknown>)[f.key];
      if (typeof v === 'string' && v !== '') saved[f.key] = v;
    }
  }
  return saved;
}

// Thrown when a request names an upload that is not the current one, or the upload is not whole.
export class StageError extends Error {}

// Thrown when the file looks like a partial export and the caller has not said to go ahead anyway.
export class PartialUploadError extends Error {}

interface StageRow {
  token: string;
  filename: string;
  started_by: string;
  expected: number;
  rows: number;
  skipped_other_district: number;
  skipped_invalid: number;
  duplicates: number;
  warnings: string;
  cities: string;
  columns: string;
  used: string;
}

async function readStage(db: Db, token: string): Promise<StageRow> {
  const row = await db.prepare('SELECT * FROM upload_stage WHERE id = 1').first<StageRow>();
  if (!row || row.token !== token) throw new StageError('This upload was replaced or has expired. Choose the file and check it again.');
  return row;
}

// Starts taking in a sheet. Whatever an earlier upload left behind is dropped.
export async function startStage(db: Db, actor: string, now: string, start: StageStart): Promise<StageStarted> {
  const token = crypto.randomUUID();
  await db.batch([
    db.prepare('DELETE FROM upload_rows'),
    db
      .prepare(
        `INSERT OR REPLACE INTO upload_stage
           (id, token, filename, started_by, started_at, expected, rows, skipped_other_district, skipped_invalid, duplicates, warnings, cities, columns, used)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        token,
        start.filename,
        actor,
        now,
        start.expected,
        start.rows,
        start.skippedOtherDistrict,
        start.skippedInvalid,
        start.duplicates,
        JSON.stringify(start.warnings),
        JSON.stringify(start.cities),
        JSON.stringify(start.columns),
        JSON.stringify(start.used),
      ),
    db
      .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)')
      .bind(now, actor, 'upload.stage', JSON.stringify({ filename: start.filename, people: start.expected })),
  ]);
  return { token, chunk: STAGE_CHUNK };
}

// Puts some of the sheet's people in upload_rows. Sending a row again replaces it, so a request can be repeated. A request for an
// upload that is no longer the current one stores nothing.
export async function stageRows(db: Db, token: string, rows: IncomingPerson[]): Promise<number> {
  const res = await db
    .prepare(
      `INSERT OR REPLACE INTO upload_rows
         (key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct, status_date)
       SELECT json_extract(value, '$.key'), json_extract(value, '$.firstName'), json_extract(value, '$.middleName'),
         json_extract(value, '$.lastName'), json_extract(value, '$.party'), json_extract(value, '$.legdist'),
         json_extract(value, '$.reasonCode'), json_extract(value, '$.phone'), json_extract(value, '$.address'),
         json_extract(value, '$.city'), json_extract(value, '$.zip'), json_extract(value, '$.precinct'), json_extract(value, '$.statusDate')
       FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM upload_stage WHERE token = ?2)`,
    )
    .bind(JSON.stringify(rows), token)
    .run();
  if (res.meta.changes === 0 && rows.length > 0)
    throw new StageError('This upload was replaced or has expired. Choose the file and check it again.');
  return rows.length;
}

// Is a person on the sheet? (p is a row of people.)
const ON_SHEET = 'EXISTS (SELECT 1 FROM upload_rows s WHERE s.key = p.key)';

interface Counts {
  staged: number;
  added: number;
  known: number;
  cured: number;
  reappeared: number;
  still_uncured: number;
  open_before: number;
}

// What the sheet would do, counted without changing anything. `grace` is the admins' setting.
async function countChanges(db: Db, grace: number): Promise<Counts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM upload_rows) AS staged,
         (SELECT COUNT(*) FROM upload_rows s WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.key = s.key)) AS added,
         (SELECT COUNT(*) FROM people p WHERE ${ON_SHEET}) AS known,
         (SELECT COUNT(*) FROM people p WHERE p.status != 'cured' AND NOT ${ON_SHEET}) AS cured,
         (SELECT COUNT(*) FROM people p WHERE p.status = 'cured' AND ${ON_SHEET}) AS reappeared,
         (SELECT COUNT(*) FROM people p WHERE p.status = 'contacted' AND p.contacted_cycles + 1 > ?1 AND ${ON_SHEET}) AS still_uncured,
         (SELECT COUNT(*) FROM people WHERE status != 'cured') AS open_before`,
    )
    .bind(grace)
    .first<Counts>();
  if (!row) throw new Error('no counts');
  return row;
}

// A key is "first|last|address", each part with only letters, digits and spaces. These cut out "last|address" and "first|last".
const LAST_ADDRESS = (key: string) => `substr(${key}, instr(${key}, '|') + 1)`;
const FIRST_LAST = (key: string) => `substr(${key}, 1, instr(${key}, '|') + instr(${LAST_ADDRESS(key)}, '|') - 1)`;

// Someone who disappears while a similar person appears may be one person whose record was corrected, who would otherwise be cured and
// re-added as a stranger (losing their notes and volunteer). Only reported; nothing is merged.
const MATCHES = `
  WITH gone AS MATERIALIZED (
    SELECT p.id, p.first_name, p.last_name, p.address, ${LAST_ADDRESS('p.key')} AS last_address, ${FIRST_LAST('p.key')} AS first_last
    FROM people p WHERE p.status != 'cured' AND NOT ${ON_SHEET}),
  fresh AS MATERIALIZED (
    SELECT s.first_name, s.last_name, s.address, ${LAST_ADDRESS('s.key')} AS last_address, ${FIRST_LAST('s.key')} AS first_last
    FROM upload_rows s WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.key = s.key)),
  found AS (
    SELECT 'address' AS kind, g.id, g.first_name || ' ' || g.last_name AS existing_name, g.address AS existing_address,
      f.first_name || ' ' || f.last_name AS incoming_name, f.address AS incoming_address
    FROM fresh f JOIN gone g ON g.last_address = f.last_address
    UNION ALL
    SELECT 'moved', g.id, g.first_name || ' ' || g.last_name, g.address, f.first_name || ' ' || f.last_name, f.address
    FROM fresh f JOIN gone g ON g.first_last = f.first_last)`;

interface MatchRow {
  kind: PossibleMatch['kind'];
  id: number;
  existing_name: string;
  existing_address: string;
  incoming_name: string;
  incoming_address: string;
}

async function findMatches(db: Db, counts: Counts): Promise<{ matches: PossibleMatch[]; count: number; skipped: boolean }> {
  if (counts.cured === 0 || counts.added === 0) return { matches: [], count: 0, skipped: false };
  if (counts.cured * counts.added > MATCH_PAIRS_LIMIT) return { matches: [], count: 0, skipped: true };
  const total = await db.prepare(`${MATCHES} SELECT COUNT(*) AS n FROM found`).first<{ n: number }>();
  const { results } = await db.prepare(`${MATCHES} SELECT * FROM found LIMIT ?1`).bind(MATCH_LIMIT).all<MatchRow>();
  return {
    count: total?.n ?? 0,
    skipped: false,
    matches: results.map((r) => ({
      kind: r.kind,
      existing: { id: r.id, name: r.existing_name, address: r.existing_address },
      incoming: { name: r.incoming_name, address: r.incoming_address },
    })),
  };
}

function previewOf(stage: StageRow, counts: Counts, found: Awaited<ReturnType<typeof findMatches>>): UploadPreview {
  const looksPartial = counts.open_before >= 10 && counts.cured > counts.open_before / 2;
  const warnings: string[] = JSON.parse(stage.warnings);
  if (looksPartial) {
    warnings.push(
      `This file would cure ${counts.cured} of the ${counts.open_before} people still open. That looks like a partial export, not a day of progress.`,
    );
  }
  if (found.count > 0) {
    warnings.push(
      `${found.count} new ${found.count > 1 ? 'people look' : 'person looks'} like someone who disappeared from the sheet (a corrected name or a move). Check the list below.`,
    );
  }
  if (found.skipped) warnings.push('So many people changed that this check did not look for corrected names.');
  return {
    rows: stage.rows,
    skippedOtherDistrict: stage.skipped_other_district,
    skippedInvalid: stage.skipped_invalid,
    duplicates: stage.duplicates,
    added: counts.added,
    updated: counts.known,
    cured: counts.cured,
    stillUncured: counts.still_uncured,
    reappeared: counts.reappeared,
    openBefore: counts.open_before,
    looksPartial,
    warnings,
    possibleMatches: found.matches,
    possibleMatchCount: found.count,
    cities: JSON.parse(stage.cities),
    columns: JSON.parse(stage.columns),
  };
}

// What uploading the staged sheet would do. Changes nothing.
export async function planStage(db: Db, token: string): Promise<UploadPreview> {
  const stage = await readStage(db, token);
  const counts = await countChanges(db, await graceCycles(db));
  if (counts.staged !== stage.expected)
    throw new StageError(`Only ${counts.staged} of ${stage.expected} people have arrived. Check the file again.`);
  return previewOf(stage, counts, await findMatches(db, counts));
}

export interface ApplyOptions {
  now: string;
  actor: string;
  // Needed when the preview said the file looks partial.
  force: boolean;
}

// Applies the staged sheet.
//  - on the sheet, new: added, needs contact.
//  - on the sheet, known: details refreshed. A cured person who is back is reopened and flagged (reappeared).
//  - on the sheet, marked contacted: each upload that still lists them is one cycle. Once they have had more than `grace` of them they
//    are an unsuccessful cure: flagged (still_uncured), back to needs contact, with the same volunteer. The grace is for the state's
//    data being a day or two behind the phone calls.
//  - not on the sheet, not cured yet: cured. Assignment stays, so the volunteer keeps the credit.
// A known person the sheet leaves exactly as they are is not written: each row written costs a row for the table and one for every
// index, and a day's sheet is mostly the day before's.
export async function finishStage(db: Db, token: string, options: ApplyOptions): Promise<UploadPreview & { id: number }> {
  const { now, actor, force } = options;
  const stage = await readStage(db, token);
  const grace = await graceCycles(db);
  const counts = await countChanges(db, grace);
  if (counts.staged !== stage.expected)
    throw new StageError(`Only ${counts.staged} of ${stage.expected} people have arrived. Check the file again.`);
  const preview = previewOf(stage, counts, await findMatches(db, counts));
  if (preview.looksPartial && !force) throw new PartialUploadError(preview.warnings.join(' '));
  const last = await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM uploads').first<{ id: number }>();
  const id = (last?.id ?? 0) + 1;

  // Exceeded the grace: a contacted person this upload still lists, on their (grace + 1)th cycle.
  const exceeded = `people.status = 'contacted' AND people.contacted_cycles + 1 > ?1`;
  const fields = [
    'first_name',
    'middle_name',
    'last_name',
    'party',
    'legdist',
    'reason_code',
    'phone',
    'address',
    'city',
    'zip',
    'precinct',
  ];
  const statements: Stmt[] = [
    db
      .prepare(
        'INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        actor,
        stage.filename,
        now,
        stage.rows - stage.skipped_other_district - stage.skipped_invalid,
        counts.added,
        counts.cured,
        counts.still_uncured,
        counts.reappeared,
      ),
    // The log gets one row for each person the upload cured, flagged or reopened, written before the changes that would hide why.
    db
      .prepare(
        `INSERT INTO audit (at, actor, action, person_id, detail)
         SELECT ?1, ?2, 'import.reappeared', p.id, json_object('was', 'cured') FROM people p WHERE p.status = 'cured' AND ${ON_SHEET}`,
      )
      .bind(now, actor),
    db
      .prepare(
        `INSERT INTO audit (at, actor, action, person_id, detail)
         SELECT ?1, ?2, 'import.still_uncured', p.id, json_object('was', 'contacted', 'since', p.status_changed_at, 'graceCycles', ?3)
         FROM people p WHERE p.status = 'contacted' AND p.contacted_cycles + 1 > ?3 AND ${ON_SHEET}`,
      )
      .bind(now, actor, grace),
    db
      .prepare(
        `INSERT INTO audit (at, actor, action, person_id, detail)
         SELECT ?1, ?2, 'import.cured', p.id, json_object('upload', ?3) FROM people p WHERE p.status != 'cured' AND NOT ${ON_SHEET}`,
      )
      .bind(now, actor, id),
    // Known people: details refreshed from the sheet, and the contact status moved on as above.
    db
      .prepare(
        `UPDATE people SET
           ${fields.map((f) => `${f} = s.${f}`).join(', ')}, status_date = s.status_date,
           status = CASE WHEN people.status = 'cured' OR (${exceeded}) THEN 'needs_contact' ELSE people.status END,
           flag = CASE WHEN people.status = 'cured' THEN 'reappeared' WHEN ${exceeded} THEN 'still_uncured' ELSE people.flag END,
           status_changed_at = CASE WHEN people.status = 'cured' OR (${exceeded}) THEN ?2 ELSE people.status_changed_at END,
           contacted_cycles = CASE WHEN people.status = 'contacted' AND NOT (${exceeded}) THEN people.contacted_cycles + 1 ELSE 0 END,
           cured_at = NULL, last_upload_id = ?3, updated_at = ?2
         FROM upload_rows s
         WHERE people.key = s.key
           AND (people.status IN ('cured', 'contacted') OR people.contacted_cycles != 0
                OR ${[...fields, 'status_date'].map((f) => `people.${f} IS NOT s.${f}`).join(' OR ')})`,
      )
      .bind(grace, now, id),
    // People not on the sheet any more are cured.
    db
      .prepare(
        `UPDATE people SET status = 'cured', cured_at = ?1, status_changed_at = ?1, flag = NULL, updated_at = ?1
         WHERE status != 'cured' AND NOT EXISTS (SELECT 1 FROM upload_rows s WHERE s.key = people.key)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO people (key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct,
           status_date, status, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
         SELECT s.key, s.first_name, s.middle_name, s.last_name, s.party, s.legdist, s.reason_code, s.phone, s.address, s.city, s.zip,
           s.precinct, s.status_date, 'needs_contact', ?1, ?2, ?2, ?1, ?1
         FROM upload_rows s WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.key = s.key)`,
      )
      .bind(now, id),
    // Everyone on the sheet is open now, so the filters offer what the sheet has.
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('facets', json_object(
         'cities', json((SELECT json_group_array(city) FROM (SELECT DISTINCT city FROM upload_rows WHERE city != '' ORDER BY city))),
         'parties', json((SELECT json_group_array(party) FROM (SELECT DISTINCT party FROM upload_rows WHERE party != '' ORDER BY party))),
         'precincts', json((SELECT json_group_array(precinct) FROM (SELECT DISTINCT precinct FROM upload_rows WHERE precinct != '' ORDER BY precinct)))))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ),
    // The columns this upload read are what the next one starts from.
    db
      .prepare("INSERT INTO settings (key, value) VALUES ('column_map', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(stage.used),
    db.prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)').bind(
      now,
      actor,
      'upload',
      JSON.stringify({
        upload: id,
        filename: stage.filename,
        added: counts.added,
        cured: counts.cured,
        stillUncured: counts.still_uncured,
        reappeared: counts.reappeared,
        columns: JSON.parse(stage.used),
      }),
    ),
    db.prepare('DELETE FROM upload_rows'),
    db.prepare('DELETE FROM upload_stage'),
  ];
  await db.batch(statements);
  return { ...preview, id };
}

interface UploadRow {
  id: number;
  uploaded_by: string;
  filename: string;
  created_at: string;
  rows: number;
  added: number;
  cured: number;
  still_uncured: number;
  reappeared: number;
}

export const uploadRecord = (r: UploadRow): UploadRecord => ({
  id: r.id,
  uploadedBy: r.uploaded_by,
  filename: r.filename,
  createdAt: r.created_at,
  rows: r.rows,
  added: r.added,
  cured: r.cured,
  stillUncured: r.still_uncured,
  reappeared: r.reappeared,
});
