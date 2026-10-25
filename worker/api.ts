// The JSON API. Everyone signed in sees every person; what a volunteer may change is their own claims (claim, release, status, notes),
// and the admin routes (an email in ADMIN_EMAILS) move people between volunteers, upload the state's sheet and read the audit log.
// Every change writes an audit row. Only erasable TypeScript syntax.
import type {
  AdminSettings,
  AdminStats,
  ApiError,
  AuditEntry,
  ContactMethod,
  Me,
  Note,
  PeoplePage,
  Person,
  PersonDetail,
  ResetResult,
  Status,
  Volunteer,
  VolunteerStats,
} from '../src/api.d.ts';
import type { Db, Stmt, Value } from './db.ts';
import { ImportError } from './import.ts';
import { applyUpload, graceCycles, MAX_GRACE_CYCLES, PartialUploadError, previewUpload, savedFacets, uploadRecord } from './uploads.ts';

export interface ApiContext {
  db: Db;
  email: string;
  isAdmin: boolean;
  // Whether this deployment lets admins reset (ALLOW_RESET).
  allowReset: boolean;
  now: () => Date;
}

interface Ctx {
  db: Db;
  me: Volunteer;
  isAdmin: boolean;
  allowReset: boolean;
  now: string;
  today: string;
}

type Body = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers });

const STATUSES_VOLUNTEERS_SET = ['needs_contact', 'left_voicemail', 'contacted'] as const;
const METHODS = ['call', 'text', 'email', 'in_person', 'other'] as const;
// An upload is a few megabytes at most: the sheet is a few thousand rows.
const MAX_CSV = 5_000_000;

const isObject = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(body: Body, name: string, max: number, required = true): string {
  const v = body[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text`);
  const s = v.trim();
  if (s === '' && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (at most ${max} characters)`);
  return s;
}

function idOf(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'not a valid id');
  return n;
}

// The date in Arizona (no daylight saving), as YYYY-MM-DD.
const arizonaDate = (now: Date): string => now.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
}

interface PersonRow {
  id: number;
  first_name: string;
  middle_name: string;
  last_name: string;
  party: string;
  reason_code: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  precinct: string;
  status_date: string | null;
  status: Status;
  status_changed_at: string;
  contact_method: ContactMethod | null;
  assigned_to: number | null;
  flag: Person['flag'];
  notes_count: number;
}

const PERSON_SELECT = `SELECT p.id, p.first_name, p.middle_name, p.last_name, p.party, p.reason_code, p.phone, p.address, p.city, p.zip,
    p.precinct, p.status_date, p.status, p.status_changed_at, p.contact_method, p.assigned_to, p.flag,
    (SELECT COUNT(*) FROM notes n WHERE n.person_id = p.id) AS notes_count
  FROM people p`;

function toPerson(r: PersonRow, today: string): Person {
  return {
    id: r.id,
    firstName: r.first_name,
    middleName: r.middle_name,
    lastName: r.last_name,
    party: r.party,
    reasonCode: r.reason_code,
    phone: r.phone,
    address: r.address,
    city: r.city,
    zip: r.zip,
    precinct: r.precinct,
    statusDate: r.status_date,
    daysUncured: r.status_date === null || r.status === 'cured' ? null : daysBetween(r.status_date, today),
    status: r.status,
    statusChangedAt: r.status_changed_at,
    contactMethod: r.contact_method,
    assignedTo: r.assigned_to,
    flag: r.flag,
    notesCount: r.notes_count,
  };
}

async function personRow(c: Ctx, id: number): Promise<PersonRow> {
  const row = await c.db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).bind(id).first<PersonRow>();
  if (!row) throw new HttpError(404, 'No such person');
  return row;
}

const nameOf = (r: Pick<PersonRow, 'first_name' | 'last_name'>): string => `${r.first_name} ${r.last_name}`;

function auditStmt(c: Ctx, action: string, personId: number | null, detail: Record<string, unknown> = {}): Stmt {
  return c.db
    .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(c.now, c.me.email, action, personId, JSON.stringify(detail));
}

async function volunteerById(c: Ctx, id: number): Promise<Volunteer> {
  const v = await c.db.prepare('SELECT id, email, name FROM volunteers WHERE id = ?').bind(id).first<Volunteer>();
  if (!v) throw new HttpError(404, 'No such volunteer');
  return v;
}

// The person's own claim, or any admin.
function mayChange(c: Ctx, p: PersonRow): void {
  if (!c.isAdmin && p.assigned_to !== c.me.id) throw new HttpError(403, 'This person is not assigned to you');
}

// ---- routes: everyone signed in

async function getMe(c: Ctx): Promise<Response> {
  await c.db.prepare('UPDATE volunteers SET last_seen_at = ? WHERE id = ?').bind(c.now, c.me.id).run();
  const me: Me = { ...c.me, isAdmin: c.isAdmin };
  return json(me);
}

async function putMe(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const name = text(body, 'name', 80);
  await c.db.batch([
    c.db.prepare('UPDATE volunteers SET name = ? WHERE id = ?').bind(name, c.me.id),
    auditStmt(c, 'volunteer.rename', null, { from: c.me.name, to: name }),
  ]);
  const me: Me = { ...c.me, name, isAdmin: c.isAdmin };
  return json(me);
}

async function listVolunteers(c: Ctx): Promise<Response> {
  const { results } = await c.db.prepare('SELECT id, email, name FROM volunteers ORDER BY name COLLATE NOCASE, email').all<Volunteer>();
  return json(results);
}

// The pool: open people nobody has claimed. The partial index people_pool covers exactly this condition, so keep it word for word.
const POOL_WHERE = "p.assigned_to IS NULL AND p.status != 'cured'";
// Longest uncured first is the earliest status date first, people with no date last. The first term is the expression people_pool indexes.
const DAYS_ORDER = ["COALESCE(p.status_date, '9999-12-31')", 'p.id'];
// Each sort as the terms of its ORDER BY, in its natural direction. dir=desc puts DESC on every term, which is the exact reverse (and
// lets SQLite read an index backwards).
const PEOPLE_SORTS = new Map([
  ['days', DAYS_ORDER],
  ['precinct', ['p.precinct COLLATE NOCASE', ...DAYS_ORDER]],
  ['city', ['p.city COLLATE NOCASE', ...DAYS_ORDER]],
  ['name', ['p.last_name COLLATE NOCASE', 'p.first_name COLLATE NOCASE', 'p.id']],
]);
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
// A volunteer's own list is not paged by the pages, and an admin can move someone's whole list to another volunteer.
const MAX_MINE = 1000;
const MAX_FILTER = 100;

// A LIKE pattern for "contains this text", with the wildcards in the text taken literally (the query says ESCAPE '\').
const containing = (s: string): string => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function filterParam(url: URL, name: string): string {
  const v = (url.searchParams.get(name) ?? '').trim();
  if (v.length > MAX_FILTER) throw new HttpError(400, `${name} is too long (at most ${MAX_FILTER} characters)`);
  return v;
}

// People, a page at a time. scope=pool (the default) is who still needs a volunteer, scope=mine is the caller's own people, and
// scope=all (admins) is everyone. sort (days, precinct, city or name) runs the other way with dir=desc. city, precinct (ignoring case)
// and party match exactly, which the indexes in migration 0003 answer; q (name, street and, for admins, phone) matches any part, which
// reads every row that is left after the other filters. There is no count: the page asks for one person more than it shows (hasMore).
async function listPeople(c: Ctx, _params: string[], _body: Body, url: URL): Promise<Response> {
  const scope = url.searchParams.get('scope') ?? 'pool';
  if (scope !== 'pool' && scope !== 'mine' && scope !== 'all') throw new HttpError(400, 'scope must be pool, mine or all');
  if (scope === 'all' && !c.isAdmin) throw new HttpError(403, 'Forbidden');
  const terms = PEOPLE_SORTS.get(url.searchParams.get('sort') ?? 'days');
  if (terms === undefined) throw new HttpError(400, `sort must be one of ${[...PEOPLE_SORTS.keys()].join(', ')}`);
  const dir = url.searchParams.get('dir') ?? 'asc';
  if (dir !== 'asc' && dir !== 'desc') throw new HttpError(400, 'dir must be asc or desc');
  const order = terms.map((t) => (dir === 'desc' ? `${t} DESC` : t)).join(', ');
  const limit = intParam(url, 'limit', scope === 'mine' ? MAX_MINE : DEFAULT_PAGE, 1, scope === 'mine' ? MAX_MINE : MAX_PAGE);
  const offset = intParam(url, 'offset', 0, 0, 1_000_000);

  const where: string[] = [];
  const binds: Value[] = [];
  if (scope === 'pool') where.push(POOL_WHERE);
  if (scope === 'mine') {
    where.push('p.assigned_to = ?');
    binds.push(c.me.id);
  }
  const city = filterParam(url, 'city');
  if (city !== '') {
    where.push('p.city COLLATE NOCASE = ?');
    binds.push(city);
  }
  const party = filterParam(url, 'party');
  if (party !== '') {
    where.push('p.party = ?');
    binds.push(party);
  }
  const precinct = filterParam(url, 'precinct');
  if (precinct !== '') {
    where.push('p.precinct COLLATE NOCASE = ?');
    binds.push(precinct);
  }
  const q = filterParam(url, 'q');
  if (q !== '') {
    where.push(
      c.isAdmin
        ? "(p.first_name || ' ' || p.last_name || ' ' || p.address || ' ' || p.phone) LIKE ? ESCAPE '\\'"
        : "(p.first_name || ' ' || p.last_name || ' ' || p.address) LIKE ? ESCAPE '\\'",
    );
    binds.push(containing(q));
  }

  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const { results } = await c.db
    .prepare(`${PERSON_SELECT}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset)
    .all<PersonRow>();
  const page: PeoplePage = { people: results.slice(0, limit).map((r) => toPerson(r, c.today)), hasMore: results.length > limit };
  if (scope === 'pool' && url.searchParams.get('facets') === '1') page.facets = await savedFacets(c.db);
  return json(page);
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  person_id: number | null;
  detail: string;
  person_name: string | null;
}

const AUDIT_SELECT = `SELECT a.id, a.at, a.actor, a.action, a.person_id, a.detail, trim(p.first_name || ' ' || p.last_name) AS person_name
  FROM audit a LEFT JOIN people p ON p.id = a.person_id`;

const toAudit = (r: AuditRow): AuditEntry => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  personId: r.person_id,
  personName: r.person_name,
  detail: parseDetail(r.detail),
});

async function getPerson(c: Ctx, p: string[]): Promise<Response> {
  const id = idOf(p[0]);
  const person = toPerson(await personRow(c, id), c.today);
  const notes = await c.db
    .prepare(
      `SELECT n.id, n.body, n.created_at, n.volunteer_id, v.name, v.email FROM notes n JOIN volunteers v ON v.id = n.volunteer_id
       WHERE n.person_id = ? ORDER BY n.id DESC`,
    )
    .bind(id)
    .all<{ id: number; body: string; created_at: string; volunteer_id: number; name: string; email: string }>();
  const history = await c.db.prepare(`${AUDIT_SELECT} WHERE a.person_id = ? ORDER BY a.id DESC LIMIT 50`).bind(id).all<AuditRow>();
  const detail: PersonDetail = {
    person,
    notes: notes.results.map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.created_at,
      volunteerId: n.volunteer_id,
      volunteerName: n.name || n.email,
    })),
    history: history.results.map(toAudit),
  };
  return json(detail);
}

async function claim(c: Ctx, p: string[]): Promise<Response> {
  const id = idOf(p[0]);
  // One statement does the check and the claim, so two volunteers cannot both win.
  const res = await c.db
    .prepare("UPDATE people SET assigned_to = ?, updated_at = ? WHERE id = ? AND assigned_to IS NULL AND status != 'cured'")
    .bind(c.me.id, c.now, id)
    .run();
  if (res.meta.changes === 0) {
    const row = await personRow(c, id);
    if (row.status === 'cured') throw new HttpError(409, `${nameOf(row)} is already cured`);
    if (row.assigned_to === c.me.id) return json(toPerson(row, c.today));
    const other = row.assigned_to === null ? null : await volunteerById(c, row.assigned_to);
    throw new HttpError(409, `${nameOf(row)} was just claimed by ${other ? other.name || other.email : 'someone else'}`);
  }
  await auditStmt(c, 'claim', id).run();
  return json(toPerson(await personRow(c, id), c.today));
}

async function release(c: Ctx, p: string[]): Promise<Response> {
  const id = idOf(p[0]);
  const row = await personRow(c, id);
  mayChange(c, row);
  if (row.assigned_to === null) return json(toPerson(row, c.today));
  await c.db.batch([
    c.db.prepare('UPDATE people SET assigned_to = NULL, updated_at = ? WHERE id = ?').bind(c.now, id),
    auditStmt(c, 'release', id, { from: row.assigned_to }),
  ]);
  return json(toPerson(await personRow(c, id), c.today));
}

async function setStatus(c: Ctx, p: string[], body: Body): Promise<Response> {
  const id = idOf(p[0]);
  const status = text(body, 'status', 20);
  if (!(STATUSES_VOLUNTEERS_SET as readonly string[]).includes(status)) {
    throw new HttpError(400, `status must be one of ${STATUSES_VOLUNTEERS_SET.join(', ')}`);
  }
  const rawMethod = body.method;
  if (rawMethod !== undefined && rawMethod !== null && !(METHODS as readonly unknown[]).includes(rawMethod)) {
    throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
  }
  const row = await personRow(c, id);
  mayChange(c, row);
  if (row.status === 'cured') throw new HttpError(409, `${nameOf(row)} is already cured`);
  const said = rawMethod === undefined ? row.contact_method : ((rawMethod as ContactMethod | null) ?? null);
  // A voicemail is a phone call. A text is also filed under this status, so only a method left unsaid becomes a call.
  const method = status === 'left_voicemail' && said === null ? 'call' : said;
  // Acting on a person answers the flag the last upload put on them.
  await c.db.batch([
    c.db
      .prepare(
        'UPDATE people SET status = ?, status_changed_at = ?, contact_method = ?, flag = NULL, contacted_cycles = 0, updated_at = ? WHERE id = ?',
      )
      .bind(status, c.now, method, c.now, id),
    auditStmt(c, 'status', id, { from: row.status, to: status, method }),
  ]);
  return json(toPerson(await personRow(c, id), c.today));
}

async function addNote(c: Ctx, p: string[], body: Body): Promise<Response> {
  const id = idOf(p[0]);
  const noteText = text(body, 'body', 2000);
  mayChange(c, await personRow(c, id));
  const res = await c.db
    .prepare('INSERT INTO notes (person_id, volunteer_id, body, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, c.me.id, noteText, c.now)
    .run();
  await auditStmt(c, 'note', id, { note: res.meta.last_row_id }).run();
  const note: Note = {
    id: res.meta.last_row_id,
    body: noteText,
    createdAt: c.now,
    volunteerId: c.me.id,
    volunteerName: c.me.name || c.me.email,
  };
  return json(note, 201);
}

// ---- routes: admins

async function adminStats(c: Ctx): Promise<Response> {
  const totals = await c.db
    .prepare(
      `SELECT COALESCE(SUM(status = 'needs_contact'), 0) AS needs, COALESCE(SUM(status = 'left_voicemail'), 0) AS voicemail,
         COALESCE(SUM(status = 'contacted'), 0) AS contacted, COALESCE(SUM(status = 'cured'), 0) AS cured,
         COALESCE(SUM(status != 'cured' AND assigned_to IS NULL), 0) AS unassigned,
         COALESCE(SUM(status != 'cured' AND flag IS NOT NULL), 0) AS flagged
       FROM people`,
    )
    .first<{ needs: number; voicemail: number; contacted: number; cured: number; unassigned: number; flagged: number }>();
  const volunteers = await c.db
    .prepare(
      `SELECT v.id, v.email, v.name, v.last_seen_at,
         COALESCE(SUM(p.status != 'cured'), 0) AS assigned,
         COALESCE(SUM(p.status = 'needs_contact'), 0) AS needs,
         COALESCE(SUM(p.status = 'left_voicemail'), 0) AS voicemail,
         COALESCE(SUM(p.status = 'contacted'), 0) AS contacted,
         COALESCE(SUM(p.status = 'cured'), 0) AS cured,
         COALESCE(SUM(p.status != 'cured' AND p.flag IS NOT NULL), 0) AS flagged
       FROM volunteers v LEFT JOIN people p ON p.assigned_to = v.id
       GROUP BY v.id ORDER BY v.name COLLATE NOCASE, v.email`,
    )
    .all<{
      id: number;
      email: string;
      name: string;
      last_seen_at: string;
      assigned: number;
      needs: number;
      voicemail: number;
      contacted: number;
      cured: number;
      flagged: number;
    }>();
  const flagged = await c.db
    .prepare(`${PERSON_SELECT} WHERE p.flag IS NOT NULL AND p.status != 'cured' ORDER BY p.status_changed_at DESC, p.id`)
    .all<PersonRow>();
  const last = await c.db
    .prepare(
      'SELECT id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared FROM uploads ORDER BY id DESC LIMIT 1',
    )
    .first<Parameters<typeof uploadRecord>[0]>();
  const stats: AdminStats = {
    totals: {
      needsContact: totals?.needs ?? 0,
      leftVoicemail: totals?.voicemail ?? 0,
      contacted: totals?.contacted ?? 0,
      cured: totals?.cured ?? 0,
      unassigned: totals?.unassigned ?? 0,
      flagged: totals?.flagged ?? 0,
    },
    volunteers: volunteers.results.map(
      (v): VolunteerStats => ({
        id: v.id,
        email: v.email,
        name: v.name,
        lastSeenAt: v.last_seen_at,
        assigned: v.assigned,
        needsContact: v.needs,
        leftVoicemail: v.voicemail,
        contacted: v.contacted,
        cured: v.cured,
        flagged: v.flagged,
      }),
    ),
    flagged: flagged.results.map((r) => toPerson(r, c.today)),
    lastUpload: last ? uploadRecord(last) : null,
  };
  return json(stats);
}

async function adminAudit(c: Ctx, _p: string[], _b: Body, url: URL): Promise<Response> {
  const num = (name: string): number | null => {
    const raw = url.searchParams.get(name);
    return raw === null ? null : idOf(raw);
  };
  const limit = Math.min(num('limit') ?? 50, 200);
  const before = num('before');
  const person = num('person');
  const { results } = await c.db
    .prepare(`${AUDIT_SELECT} WHERE (? IS NULL OR a.id < ?) AND (? IS NULL OR a.person_id = ?) ORDER BY a.id DESC LIMIT ?`)
    .bind(before, before, person, person, limit)
    .all<AuditRow>();
  return json(results.map(toAudit));
}

async function adminUploads(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare(
      'SELECT id, uploaded_by, filename, created_at, rows, added, cured, still_uncured, reappeared FROM uploads ORDER BY id DESC LIMIT 20',
    )
    .all<Parameters<typeof uploadRecord>[0]>();
  return json(results.map(uploadRecord));
}

function csvOf(body: Body): string {
  const csv = body.csv;
  if (typeof csv !== 'string' || csv.trim() === '') throw new HttpError(400, 'csv is required');
  if (csv.length > MAX_CSV) throw new HttpError(413, 'The file is too large');
  return csv;
}

async function uploadPreview(c: Ctx, _p: string[], body: Body): Promise<Response> {
  return json(await previewUpload(c.db, csvOf(body), c.now));
}

async function uploadApply(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const csv = csvOf(body);
  const filename = text(body, 'filename', 200, false);
  try {
    return json(await applyUpload(c.db, csv, { now: c.now, actor: c.me.email, filename, force: body.force === true }), 201);
  } catch (e) {
    if (e instanceof PartialUploadError) throw new HttpError(409, e.message, ['Send force: true to upload it anyway.']);
    throw e;
  }
}

async function assign(c: Ctx, p: string[], body: Body): Promise<Response> {
  const id = idOf(p[0]);
  const to = body.volunteerId;
  if (to !== null && (typeof to !== 'number' || !Number.isSafeInteger(to)))
    throw new HttpError(400, 'volunteerId must be a volunteer id or null');
  const row = await personRow(c, id);
  if (row.status === 'cured') throw new HttpError(409, `${nameOf(row)} is already cured`);
  if (to !== null) await volunteerById(c, to);
  await c.db.batch([
    c.db.prepare('UPDATE people SET assigned_to = ?, updated_at = ? WHERE id = ?').bind(to, c.now, id),
    auditStmt(c, 'assign', id, { from: row.assigned_to, to }),
  ]);
  return json(toPerson(await personRow(c, id), c.today));
}

async function dismissFlag(c: Ctx, p: string[]): Promise<Response> {
  const id = idOf(p[0]);
  const row = await personRow(c, id);
  if (row.flag === null) return json(toPerson(row, c.today));
  await c.db.batch([
    c.db.prepare('UPDATE people SET flag = NULL, updated_at = ? WHERE id = ?').bind(c.now, id),
    auditStmt(c, 'flag.dismiss', id, { flag: row.flag }),
  ]);
  return json(toPerson(await personRow(c, id), c.today));
}

// Moves everyone a volunteer still has open to another volunteer, or back to the pool (volunteerId null).
async function reassignAll(c: Ctx, p: string[], body: Body): Promise<Response> {
  const from = idOf(p[0]);
  const to = body.volunteerId;
  if (to !== null && (typeof to !== 'number' || !Number.isSafeInteger(to)))
    throw new HttpError(400, 'volunteerId must be a volunteer id or null');
  if (to === from) throw new HttpError(400, 'Pick someone else');
  await volunteerById(c, from);
  if (to !== null) await volunteerById(c, to);
  const res = await c.db
    .prepare("UPDATE people SET assigned_to = ?, updated_at = ? WHERE assigned_to = ? AND status != 'cured'")
    .bind(to, c.now, from)
    .run();
  await auditStmt(c, 'reassign', null, { from, to, count: res.meta.changes }).run();
  return json({ moved: res.meta.changes });
}

async function getSettings(c: Ctx): Promise<Response> {
  const settings: AdminSettings = { graceCycles: await graceCycles(c.db), resetEnabled: c.allowReset };
  return json(settings);
}

async function putSettings(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const raw = body.graceCycles;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_GRACE_CYCLES) {
    throw new HttpError(400, `graceCycles must be a whole number from 0 to ${MAX_GRACE_CYCLES}`);
  }
  const before = await graceCycles(c.db);
  await c.db.batch([
    c.db
      .prepare("INSERT INTO settings (key, value) VALUES ('grace_cycles', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(String(raw)),
    auditStmt(c, 'settings', null, { graceCycles: { from: before, to: raw } }),
  ]);
  const settings: AdminSettings = { graceCycles: raw, resetEnabled: c.allowReset };
  return json(settings);
}

// Deletes every voter, their notes and the upload history, for starting over after trying the tool with test data. Volunteers, the
// settings and the audit log stay (the log gets a row saying what was deleted). Refused unless this deployment turns it on, and unless
// the request says what it is.
async function reset(c: Ctx, _p: string[], body: Body): Promise<Response> {
  if (!c.allowReset) throw new HttpError(403, 'Reset is turned off on this site');
  if (body.confirm !== 'delete all voters') throw new HttpError(400, 'Send confirm: "delete all voters"');
  const count = async (table: string): Promise<number> =>
    (await c.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  const deleted = { people: await count('people'), notes: await count('notes'), uploads: await count('uploads') };
  // Notes and people point at people and uploads, so they go first.
  await c.db.batch([
    c.db.prepare('DELETE FROM notes'),
    c.db.prepare('DELETE FROM people'),
    c.db.prepare("DELETE FROM settings WHERE key = 'facets'"),
    c.db.prepare('DELETE FROM uploads'),
    auditStmt(c, 'reset', null, deleted),
  ]);
  const result: ResetResult = { deleted };
  return json(result);
}

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  admin: boolean;
  handler: (c: Ctx, params: string[], body: Body, url: URL) => Promise<Response>;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/me$/, admin: false, handler: getMe },
  { method: 'PUT', pattern: /^\/api\/me$/, admin: false, handler: putMe },
  { method: 'GET', pattern: /^\/api\/volunteers$/, admin: false, handler: listVolunteers },
  { method: 'GET', pattern: /^\/api\/people$/, admin: false, handler: listPeople },
  { method: 'GET', pattern: /^\/api\/people\/(\d+)$/, admin: false, handler: getPerson },
  { method: 'POST', pattern: /^\/api\/people\/(\d+)\/claim$/, admin: false, handler: claim },
  { method: 'POST', pattern: /^\/api\/people\/(\d+)\/release$/, admin: false, handler: release },
  { method: 'POST', pattern: /^\/api\/people\/(\d+)\/status$/, admin: false, handler: setStatus },
  { method: 'POST', pattern: /^\/api\/people\/(\d+)\/notes$/, admin: false, handler: addNote },
  { method: 'GET', pattern: /^\/api\/admin\/stats$/, admin: true, handler: adminStats },
  { method: 'GET', pattern: /^\/api\/admin\/audit$/, admin: true, handler: adminAudit },
  { method: 'GET', pattern: /^\/api\/admin\/uploads$/, admin: true, handler: adminUploads },
  { method: 'GET', pattern: /^\/api\/admin\/settings$/, admin: true, handler: getSettings },
  { method: 'PUT', pattern: /^\/api\/admin\/settings$/, admin: true, handler: putSettings },
  { method: 'POST', pattern: /^\/api\/admin\/reset$/, admin: true, handler: reset },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/preview$/, admin: true, handler: uploadPreview },
  { method: 'POST', pattern: /^\/api\/admin\/uploads$/, admin: true, handler: uploadApply },
  { method: 'POST', pattern: /^\/api\/admin\/people\/(\d+)\/assign$/, admin: true, handler: assign },
  { method: 'POST', pattern: /^\/api\/admin\/people\/(\d+)\/dismiss-flag$/, admin: true, handler: dismissFlag },
  { method: 'POST', pattern: /^\/api\/admin\/volunteers\/(\d+)\/reassign$/, admin: true, handler: reassignAll },
];

async function ensureVolunteer(db: Db, email: string, now: string): Promise<Volunteer> {
  const find = () => db.prepare('SELECT id, email, name FROM volunteers WHERE email = ?').bind(email).first<Volunteer>();
  const known = await find();
  if (known) return known;
  await db
    .prepare('INSERT INTO volunteers (email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
    .bind(email, '', now, now)
    .run();
  const created = await find();
  if (!created) throw new Error('could not create the volunteer');
  await db
    .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)')
    .bind(now, email, 'volunteer.join', '{}')
    .run();
  return created;
}

export async function handleApi(request: Request, api: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    const matching = routes.filter((r) => r.pattern.test(url.pathname));
    if (matching.length === 0) throw new HttpError(404, 'Not found');
    const route = matching.find((r) => r.method === request.method);
    if (!route) throw new HttpError(405, 'Method not allowed');
    if (route.admin && !api.isAdmin) throw new HttpError(403, 'Forbidden');

    let body: Body = {};
    if (request.method !== 'GET') {
      // Cross-site requests are refused, and the JSON content type cannot be sent by a plain cross-site form.
      const site = request.headers.get('sec-fetch-site');
      if (site !== null && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        throw new HttpError(400, 'The body is not valid JSON');
      }
      if (!isObject(parsed)) throw new HttpError(400, 'The body must be a JSON object');
      body = parsed;
    }

    const now = api.now();
    const iso = now.toISOString();
    const me = await ensureVolunteer(api.db, api.email, iso);
    const ctx: Ctx = { db: api.db, me, isAdmin: api.isAdmin, allowReset: api.allowReset, now: iso, today: arizonaDate(now) };
    const m = route.pattern.exec(url.pathname);
    return await route.handler(ctx, m?.slice(1) ?? [], body, url);
  } catch (e) {
    if (e instanceof HttpError) {
      const err: ApiError = e.problems.length > 0 ? { error: e.message, problems: e.problems } : { error: e.message };
      return json(err, e.status);
    }
    if (e instanceof ImportError) {
      const err: ApiError = { error: e.message, problems: e.problems };
      return json(err, 422);
    }
    console.error('api error', e);
    return json({ error: 'Something went wrong' } satisfies ApiError, 500);
  }
}
