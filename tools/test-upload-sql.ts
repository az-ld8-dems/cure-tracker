// Holds the SQL that applies an upload (worker/uploads.ts) to the plain-function reference (tools/lib/plan.ts): on many random states of
// the database and random sheets, both must give the same people, the same audit rows, the same counts and the same possible matches.
// The states cover every status, flag and contact cycle, grace periods of 0 to 2, known people the sheet leaves alone or changes, new
// people, people who leave, and corrected names. Synthetic data only; the random numbers are seeded, so a failure repeats.
import assert from 'node:assert/strict';
import type { Flag, Status } from '../src/api.d.ts';
import { type IncomingPerson, normalizeKey, splitAddress } from '../src/sheet.ts';
import { finishStage, planStage, setMerges, stageRows, startStage } from '../worker/uploads.ts';
import { type ExistingPerson, MATCH_LIMIT, planUpload } from './lib/plan.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Alex', 'Beth', 'Carlos', 'Dana', 'Eli', 'Farah', 'Gus', 'Hana'];
const LAST = ['Ames', 'Baker', 'Cruz', 'Dunn', 'Egan', 'Fox'];
const STREETS = ['N 47TH PL', 'E MAIN ST', 'W CAMELBACK RD', 'S RURAL RD'];
const CITIES = [
  ['PHOENIX', '85018'],
  ['TEMPE', '85281'],
  ['MESA', '85201'],
] as const;
const NOW = '2026-10-23T12:00:00.000Z';
const OLD = '2026-10-01T00:00:00.000Z';

// A made-up person: the same index always gives the same person, so a database state and a sheet can both mention them.
function identity(i: number, v = 0): IncomingPerson {
  const first = FIRST[i % FIRST.length] ?? 'Sam';
  const last = `${LAST[Math.floor(i / FIRST.length) % LAST.length]}${Math.floor(i / (FIRST.length * LAST.length)) || ''}`;
  const [cityName, zip] = CITIES[i % CITIES.length] ?? CITIES[0];
  const address = `${100 + i * 3} ${STREETS[i % STREETS.length]} ${cityName}, AZ ${zip}`;
  const { city } = splitAddress(address);
  return {
    key: normalizeKey(first, last, address),
    firstName: first,
    middleName: v % 5 === 3 ? 'Q' : '',
    lastName: last,
    // v makes the details differ from what the database holds, a little at a time.
    party: v % 3 === 1 ? 'IND' : 'DEM',
    legdist: '8',
    reasonCode: v % 4 === 2 ? 'SIGNATURE MISSING' : 'NO ID',
    phone: v % 2 === 1 ? `602-555-${String(1000 + i).slice(-4)}` : '',
    address,
    city,
    zip,
    precinct: v % 6 === 5 ? 'NORTH' : 'ARCADIA',
    statusDate: v % 7 === 6 ? null : `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`,
  };
}

const STATUSES: Status[] = ['needs_contact', 'left_voicemail', 'contacted', 'cured'];
const FLAGS: (Flag | null)[] = [null, null, 'still_uncured', 'reappeared'];

interface Row extends ExistingPerson {
  assignedTo: number | null;
  curedAt: string | null;
  createdAt: string;
  firstUploadId: number;
  lastUploadId: number;
  updatedAt: string;
}

const DETAILS = [
  'firstName',
  'middleName',
  'lastName',
  'party',
  'legdist',
  'reasonCode',
  'phone',
  'address',
  'city',
  'zip',
  'precinct',
  'statusDate',
] as const;
const COLUMN: Record<(typeof DETAILS)[number], string> = {
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  party: 'party',
  legdist: 'legdist',
  reasonCode: 'reason_code',
  phone: 'phone',
  address: 'address',
  city: 'city',
  zip: 'zip',
  precinct: 'precinct',
  statusDate: 'status_date',
};

let scenarios = 0;
let withMatches = 0;
let merged = 0;
const kinds = new Set<string>();
const seen = { reappeared: 0, stillUncured: 0, unchanged: 0, rewritten: 0, cured: 0, added: 0, merged: 0 };

for (let seed = 1; seed <= 250; seed++) {
  const rnd = random(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]): T => list[int(list.length)] as T;
  const grace = int(3);

  // --- the database before: some people, in every state
  const sqlite = migratedDb();
  const db = sqliteD1(sqlite);
  sqlite.exec(
    `INSERT INTO uploads (id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared) VALUES (1, 'x', 'x', '${OLD}', 0, 0, 0, 0, 0)`,
  );
  sqlite.exec(`INSERT INTO volunteers (id, email, name, created_at, last_seen_at) VALUES (1, 'v@example.com', 'V', '${OLD}', '${OLD}')`);
  sqlite.prepare("INSERT INTO settings (key, value) VALUES ('grace_cycles', ?)").run(String(grace));
  const known = new Map<number, Row>();
  const have = new Set<number>();
  const howMany = int(40);
  for (let n = 0; n < howMany; n++) {
    const i = int(60);
    if (have.has(i)) continue;
    have.add(i);
    const status = pick(STATUSES);
    const p = identity(i, int(8));
    const row: Row = {
      ...p,
      id: 0,
      status,
      flag: status === 'cured' ? null : pick(FLAGS),
      statusChangedAt: pick([OLD, '2026-10-15T00:00:00.000Z', '2026-10-22T18:00:00.000Z']),
      contactedCycles: status === 'contacted' ? int(4) : int(5) === 0 ? 1 : 0,
      assignedTo: int(3) === 0 ? 1 : null,
      curedAt: status === 'cured' ? OLD : null,
      createdAt: OLD,
      firstUploadId: 1,
      lastUploadId: 1,
      updatedAt: OLD,
    };
    const res = sqlite
      .prepare(
        `INSERT INTO people (key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct, status_date,
           status, status_changed_at, contact_method, assigned_to, flag, contacted_cycles, cured_at, first_upload_id, last_upload_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(
        row.key,
        row.firstName,
        row.middleName,
        row.lastName,
        row.party,
        row.legdist,
        row.reasonCode,
        row.phone,
        row.address,
        row.city,
        row.zip,
        row.precinct,
        row.statusDate,
        row.status,
        row.statusChangedAt,
        row.assignedTo,
        row.flag,
        row.contactedCycles,
        row.curedAt,
        OLD,
        OLD,
      );
    row.id = Number(res.lastInsertRowid);
    known.set(row.id, row);
  }

  // --- the sheet: some of them, as they were or changed, and some new, some of which look like a corrected record
  const incoming = new Map<string, IncomingPerson>();
  const rows = [...known.values()];
  for (const r of rows) {
    if (int(3) === 0) continue; // left the sheet
    const p = int(2) === 0 ? identity(have.size ? ([...have][rows.indexOf(r)] ?? 0) : 0) : null;
    incoming.set(r.key, p && p.key === r.key ? { ...p } : { ...r, ...(int(2) === 0 ? { phone: '602-555-0000' } : {}), key: r.key });
  }
  for (let n = int(8); n > 0; n--) {
    const i = 60 + int(40);
    const fresh = identity(i, int(8));
    incoming.set(fresh.key, fresh);
  }
  for (const r of rows) {
    if (int(4) !== 0 || incoming.has(r.key)) continue;
    // A corrected record: another first name, another last name, or another address.
    const how = int(3);
    const corrected: IncomingPerson =
      how === 0
        ? { ...r, firstName: `${r.firstName}y`, key: normalizeKey(`${r.firstName}y`, r.lastName, r.address) }
        : how === 1
          ? { ...r, lastName: `${r.lastName}n`, key: normalizeKey(r.firstName, `${r.lastName}n`, r.address) }
          : { ...r, address: `${r.address} APT 2`, key: normalizeKey(r.firstName, r.lastName, `${r.address} APT 2`) };
    incoming.set(corrected.key, corrected);
  }
  if (incoming.size === 0) incoming.set(identity(99).key, identity(99));
  const sheet = [...incoming.values()].map((p) => ({ ...p, statusDate: p.statusDate }));

  // --- the reference. First without merges, for the counts and the matches the admin would see; then with some of those pairs marked as
  // the same person, which is the same as the existing person having had the sheet's key all along.
  const existing: ExistingPerson[] = rows.map((r) => ({ ...r }));
  const plan0 = planUpload(sheet, existing, NOW, grace);
  const merges: { id: number; key: string }[] = [];
  for (const m of plan0.possibleMatches) {
    if (int(2) === 0 || merges.some((x) => x.id === m.existing.id || x.key === m.incoming.key)) continue;
    merges.push({ id: m.existing.id, key: m.incoming.key });
  }
  const keyAfter = new Map(merges.map((m) => [m.id, m.key]));
  const existing2: ExistingPerson[] = rows.map((r) => ({ ...r, key: keyAfter.get(r.id) ?? r.key }));
  const plan = planUpload(sheet, existing2, NOW, grace);

  // --- the SQL
  const { token } = await startStage(db, 'a@example.com', NOW, {
    filename: 'x.csv',
    expected: sheet.length,
    rows: sheet.length,
    skippedOtherDistrict: 0,
    skippedInvalid: 0,
    duplicates: 0,
    warnings: [],
    cities: [],
    columns: { headers: [], sample: [], choices: [], ready: true },
    used: {},
  });
  for (let i = 0; i < sheet.length; i += 37) await stageRows(db, token, sheet.slice(i, i + 37));
  const preview0 = await planStage(db, token);
  const countsOf = (x: {
    added: number;
    updated: number;
    cured: number;
    stillUncured: number;
    reappeared: number;
    openBefore: number;
    looksPartial: boolean;
  }) => [x.added, x.updated, x.cured, x.stillUncured, x.reappeared, x.openBefore, x.looksPartial];
  const reference = (q: typeof plan) => [
    q.inserts.length,
    q.updates.length + q.unchanged,
    q.cures.length,
    q.stillUncured,
    q.reappeared,
    q.openBefore,
    q.looksPartial,
  ];
  assert.deepEqual(countsOf(preview0), reference(plan0), `seed ${seed}: counts`);
  const matchKey = (m: {
    kind: string;
    existing: { id: number; name: string; address: string };
    incoming: { key: string; name: string; address: string };
  }) => `${m.kind}|${m.existing.id}|${m.existing.name}|${m.existing.address}|${m.incoming.key}|${m.incoming.name}|${m.incoming.address}`;
  assert.equal(preview0.possibleMatchCount, plan0.possibleMatches.length, `seed ${seed}: possible matches`);
  const wanted = plan0.possibleMatches.map(matchKey);
  assert.equal(
    preview0.possibleMatches.filter((m) => wanted.includes(matchKey(m)) && !m.merged).length,
    Math.min(MATCH_LIMIT, plan0.possibleMatches.length),
    `seed ${seed}: the matches listed are the reference's`,
  );
  if (plan0.possibleMatches.length > 0) withMatches++;
  for (const kind of ['address', 'surname', 'moved']) if (plan0.possibleMatches.some((m) => m.kind === kind)) kinds.add(kind);

  // Marking pairs as the same person changes what the upload does, and only that.
  await setMerges(db, token, merges);
  const preview = await planStage(db, token);
  assert.deepEqual(countsOf(preview), reference(plan), `seed ${seed}: counts with ${merges.length} merges`);
  assert.equal(preview.possibleMatchCount, plan0.possibleMatches.length, `seed ${seed}: the list stays whole after merges`);
  const isMerged = (m: { existing: { id: number }; incoming: { key: string } }) =>
    merges.some((x) => x.id === m.existing.id && x.key === m.incoming.key);
  assert.ok(
    preview.possibleMatches.every((m) => m.merged === isMerged(m)),
    `seed ${seed}: merged flags`,
  );
  merged += merges.length;

  const result = await finishStage(db, token, { now: NOW, actor: 'a@example.com', force: true });
  const id = result.id;

  // --- the reference applied: what each person should look like now
  const expected = new Map<string, Row>();
  for (const r of rows) expected.set(keyAfter.get(r.id) ?? r.key, { ...r, key: keyAfter.get(r.id) ?? r.key });
  for (const u of plan.updates) {
    const r = [...expected.values()].find((x) => x.id === u.id) ?? assert.fail('update');
    Object.assign(r, u.incoming, {
      status: u.status,
      flag: u.flag,
      statusChangedAt: u.statusChangedAt,
      contactedCycles: u.contactedCycles,
      curedAt: null,
      lastUploadId: id,
      updatedAt: NOW,
    });
    seen.rewritten++;
  }
  seen.unchanged += plan.unchanged;
  for (const cureId of plan.cures) {
    const r = [...expected.values()].find((x) => x.id === cureId) ?? assert.fail('cure');
    Object.assign(r, { status: 'cured', curedAt: NOW, statusChangedAt: NOW, flag: null, updatedAt: NOW });
    seen.cured++;
  }
  for (const p of plan.inserts) {
    expected.set(p.key, {
      ...p,
      id: 0,
      status: 'needs_contact',
      flag: null,
      statusChangedAt: NOW,
      contactedCycles: 0,
      assignedTo: null,
      curedAt: null,
      createdAt: NOW,
      firstUploadId: id,
      lastUploadId: id,
      updatedAt: NOW,
    });
    seen.added++;
  }
  seen.merged += merges.length;
  seen.reappeared += plan.reappeared;
  seen.stillUncured += plan.stillUncured;

  // --- the same people, the same everything
  const actualRows = sqlite.prepare('SELECT * FROM people ORDER BY key').all();
  assert.equal(actualRows.length, expected.size, `seed ${seed}: how many people`);
  for (const a of actualRows) {
    const e = expected.get(String(a.key)) ?? assert.fail(`seed ${seed}: unexpected ${a.key}`);
    const got = {
      ...Object.fromEntries(DETAILS.map((d) => [d, a[COLUMN[d]]])),
      status: a.status,
      flag: a.flag,
      statusChangedAt: a.status_changed_at,
      contactedCycles: a.contacted_cycles,
      assignedTo: a.assigned_to,
      curedAt: a.cured_at,
      createdAt: a.created_at,
      firstUploadId: a.first_upload_id,
      lastUploadId: a.last_upload_id,
      updatedAt: a.updated_at,
    };
    const want = {
      ...Object.fromEntries(DETAILS.map((d) => [d, e[d]])),
      status: e.status,
      flag: e.flag,
      statusChangedAt: e.statusChangedAt,
      contactedCycles: e.contactedCycles,
      assignedTo: e.assignedTo,
      curedAt: e.curedAt,
      createdAt: e.createdAt,
      firstUploadId: e.firstUploadId,
      lastUploadId: e.lastUploadId,
      updatedAt: e.updatedAt,
    };
    assert.deepEqual(got, want, `seed ${seed}: ${a.key}`);
  }

  // --- the same audit rows (who, what and why), whatever order they were written in
  const keyOf = new Map<number, string>(
    sqlite
      .prepare('SELECT id, key FROM people')
      .all()
      .map((r) => [Number(r.id), String(r.key)]),
  );
  const auditOf = (list: { action: string; key: string | undefined; detail: unknown }[]) =>
    list.map((a) => JSON.stringify([a.action, a.key, a.detail])).sort();
  const actualAudit = sqlite
    .prepare("SELECT action, person_id, detail FROM audit WHERE action LIKE 'import.%'")
    .all()
    .map((r) => ({ action: String(r.action), key: keyOf.get(Number(r.person_id)), detail: JSON.parse(String(r.detail)) }));
  const wantAudit = [
    ...plan.audit.map((a) => ({ action: a.action, key: existing2.find((x) => x.id === a.personId)?.key, detail: a.detail })),
    ...plan.cures.map((c) => ({ action: 'import.cured', key: existing2.find((x) => x.id === c)?.key, detail: { upload: id } })),
    ...merges.map((m) => {
      const was = existing.find((x) => x.id === m.id) ?? assert.fail('merged person');
      const now = sheet.find((x) => x.key === m.key) ?? assert.fail('merged row');
      return {
        action: 'import.merged',
        key: m.key,
        detail: {
          upload: id,
          was: { name: `${was.firstName} ${was.lastName}`, address: was.address },
          now: { name: `${now.firstName} ${now.lastName}`, address: now.address },
        },
      };
    }),
  ];
  assert.deepEqual(auditOf(actualAudit), auditOf(wantAudit), `seed ${seed}: audit`);

  // --- what the upload recorded, and what the filters now offer
  const record = sqlite.prepare('SELECT added, cured, still_uncured, reappeared FROM uploads WHERE id = ?').get(id);
  assert.deepEqual(
    [record?.added, record?.cured, record?.still_uncured, record?.reappeared],
    [plan.inserts.length, plan.cures.length, plan.stillUncured, plan.reappeared],
    `seed ${seed}: the upload's row`,
  );
  const facets = JSON.parse(String(sqlite.prepare("SELECT value FROM settings WHERE key = 'facets'").get()?.value));
  const sorted = (f: (p: IncomingPerson) => string) => [...new Set(sheet.map(f))].filter((v) => v !== '').sort();
  assert.deepEqual(
    facets,
    { cities: sorted((p) => p.city), parties: sorted((p) => p.party), precincts: sorted((p) => p.precinct) },
    `seed ${seed}: facets`,
  );
  assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM upload_rows').get()?.n), 0, `seed ${seed}: staging is cleared`);
  assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS n FROM upload_stage').get()?.n), 0);
  scenarios++;
}

// The scenarios must have reached every rule, or passing means little.
for (const [what, n] of Object.entries(seen)) assert.ok(n > 20, `the random states reached ${what} only ${n} times`);
assert.ok(withMatches > 10, `corrected names came up in ${withMatches} states`);
assert.ok(merged > 20, `only ${merged} pairs were marked as the same person`);
assert.deepEqual([...kinds].sort(), ['address', 'moved', 'surname'], 'every kind of possible match came up');
console.log(
  `test-upload-sql: ok (${scenarios} random states; ${Object.entries(seen)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')}; ${withMatches} with possible matches)`,
);
