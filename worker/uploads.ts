// Applies the state's sheet to the database: a preview that changes nothing, and the upload itself, which writes everything in one
// batch (D1 runs a batch as a transaction), so a failed upload leaves no trace. The rules are in import.ts. Only erasable TypeScript.
import type { UploadPreview, UploadRecord } from '../src/api.d.ts';
import type { Db, Stmt } from './db.ts';
import { type ExistingPerson, MATCH_LIMIT, type Plan, planUpload, readSheet, type Sheet } from './import.ts';

// Rows per statement. Each row is sent as JSON inside one bound parameter and unpacked by SQLite (json_each), which keeps an upload
// to a handful of statements however long the sheet is.
const CHUNK = 100;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

interface ExistingRow {
  id: number;
  key: string;
  first_name: string;
  last_name: string;
  address: string;
  status: ExistingPerson['status'];
  status_changed_at: string;
  flag: ExistingPerson['flag'];
}

async function loadExisting(db: Db): Promise<ExistingPerson[]> {
  const { results } = await db
    .prepare('SELECT id, key, first_name, last_name, address, status, status_changed_at, flag FROM people')
    .all<ExistingRow>();
  return results.map((r) => ({
    id: r.id,
    key: r.key,
    firstName: r.first_name,
    lastName: r.last_name,
    address: r.address,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    flag: r.flag,
  }));
}

function previewOf(sheet: Sheet, plan: Plan): UploadPreview {
  const cities = new Map<string, number>();
  for (const p of sheet.people) cities.set(p.city, (cities.get(p.city) ?? 0) + 1);
  const warnings = [...sheet.warnings];
  if (plan.looksPartial) {
    warnings.push(
      `This file would cure ${plan.cures.length} of the ${plan.openBefore} people still open. That looks like a partial export, not a day of progress.`,
    );
  }
  if (plan.possibleMatches.length > 0) {
    warnings.push(
      `${plan.possibleMatches.length} new ${plan.possibleMatches.length > 1 ? 'people look' : 'person looks'} like someone who disappeared from the sheet (a corrected name or a move). Check the list below.`,
    );
  }
  return {
    rows: sheet.rows,
    skippedOtherDistrict: sheet.skippedOtherDistrict,
    skippedInvalid: sheet.skippedInvalid,
    duplicates: sheet.duplicates,
    added: plan.inserts.length,
    updated: plan.updates.length,
    cured: plan.cures.length,
    stillUncured: plan.stillUncured,
    reappeared: plan.reappeared,
    openBefore: plan.openBefore,
    looksPartial: plan.looksPartial,
    warnings,
    possibleMatches: plan.possibleMatches.slice(0, MATCH_LIMIT),
    possibleMatchCount: plan.possibleMatches.length,
    cities: [...cities].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
  };
}

async function prepare(db: Db, csv: string, now: string) {
  const sheet = readSheet(csv);
  const previous = await db.prepare('SELECT created_at FROM uploads ORDER BY id DESC LIMIT 1').first<{ created_at: string }>();
  const plan = planUpload(sheet.people, await loadExisting(db), now, previous?.created_at ?? null);
  return { sheet, plan };
}

export async function previewUpload(db: Db, csv: string, now: string): Promise<UploadPreview> {
  const { sheet, plan } = await prepare(db, csv, now);
  return previewOf(sheet, plan);
}

// Thrown when the file looks like a partial export and the caller has not said to go ahead anyway.
export class PartialUploadError extends Error {}

export interface ApplyOptions {
  now: string;
  actor: string;
  filename: string;
  // Needed when the preview said the file looks partial.
  force: boolean;
}

export async function applyUpload(db: Db, csv: string, options: ApplyOptions): Promise<UploadPreview & { id: number }> {
  const { now, actor, filename, force } = options;
  const { sheet, plan } = await prepare(db, csv, now);
  const preview = previewOf(sheet, plan);
  if (plan.looksPartial && !force) throw new PartialUploadError(preview.warnings.join(' '));
  const last = await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM uploads').first<{ id: number }>();
  const id = (last?.id ?? 0) + 1;

  const statements: Stmt[] = [
    db
      .prepare(
        'INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        actor,
        filename,
        now,
        preview.rows - preview.skippedOtherDistrict - preview.skippedInvalid,
        preview.added,
        preview.cured,
        preview.stillUncured,
        preview.reappeared,
      ),
  ];

  for (const group of chunks(plan.inserts)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO people (key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct,
             status_date, status, status_changed_at, first_upload_id, last_upload_id, created_at, updated_at)
           SELECT json_extract(value, '$.key'), json_extract(value, '$.firstName'), json_extract(value, '$.middleName'),
             json_extract(value, '$.lastName'), json_extract(value, '$.party'), json_extract(value, '$.legdist'),
             json_extract(value, '$.reasonCode'), json_extract(value, '$.phone'), json_extract(value, '$.address'),
             json_extract(value, '$.city'), json_extract(value, '$.zip'), json_extract(value, '$.precinct'),
             json_extract(value, '$.statusDate'), 'needs_contact', ?, ?, ?, ?, ?
           FROM json_each(?) WHERE true`,
        )
        .bind(now, id, id, now, now, JSON.stringify(group)),
    );
  }

  for (const group of chunks(plan.updates)) {
    const rows = group.map((u) => ({ id: u.id, status: u.status, flag: u.flag, statusChangedAt: u.statusChangedAt, ...u.incoming }));
    statements.push(
      db
        .prepare(
          `WITH j AS (
             SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.firstName') AS first_name,
               json_extract(value, '$.middleName') AS middle_name, json_extract(value, '$.lastName') AS last_name,
               json_extract(value, '$.party') AS party, json_extract(value, '$.legdist') AS legdist,
               json_extract(value, '$.reasonCode') AS reason_code, json_extract(value, '$.phone') AS phone,
               json_extract(value, '$.address') AS address, json_extract(value, '$.city') AS city, json_extract(value, '$.zip') AS zip,
               json_extract(value, '$.precinct') AS precinct, json_extract(value, '$.statusDate') AS status_date,
               json_extract(value, '$.status') AS status, json_extract(value, '$.flag') AS flag,
               json_extract(value, '$.statusChangedAt') AS status_changed_at
             FROM json_each(?))
           UPDATE people SET first_name = j.first_name, middle_name = j.middle_name, last_name = j.last_name, party = j.party,
             legdist = j.legdist, reason_code = j.reason_code, phone = j.phone, address = j.address, city = j.city, zip = j.zip,
             precinct = j.precinct, status_date = j.status_date, status = j.status, flag = j.flag,
             status_changed_at = j.status_changed_at, cured_at = NULL, last_upload_id = ?, updated_at = ?
           FROM j WHERE people.id = j.id`,
        )
        .bind(JSON.stringify(rows), id, now),
    );
  }

  for (const group of chunks(plan.cures, 500)) {
    statements.push(
      db
        .prepare(
          `UPDATE people SET status = 'cured', cured_at = ?, status_changed_at = ?, flag = NULL, updated_at = ?
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .bind(now, now, now, JSON.stringify(group)),
    );
  }

  // The log gets one row for the upload and one for each person the upload cured, flagged or reopened.
  const audit = [
    ...plan.audit.map((a) => ({ id: a.personId, action: a.action, detail: JSON.stringify(a.detail) })),
    ...plan.cures.map((personId) => ({ id: personId, action: 'import.cured', detail: JSON.stringify({ upload: id }) })),
  ];
  for (const group of chunks(audit)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO audit (at, actor, action, person_id, detail)
           SELECT ?, ?, json_extract(value, '$.action'), json_extract(value, '$.id'), json_extract(value, '$.detail')
           FROM json_each(?) WHERE true`,
        )
        .bind(now, actor, JSON.stringify(group)),
    );
  }
  statements.push(
    db.prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)').bind(
      now,
      actor,
      'upload',
      JSON.stringify({
        upload: id,
        filename,
        added: preview.added,
        cured: preview.cured,
        stillUncured: preview.stillUncured,
        reappeared: preview.reappeared,
      }),
    ),
  );

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
