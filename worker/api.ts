// The JSON API. Everyone signed in sees every person; what a volunteer may change is their own claims (claim, release, status, notes),
// and the admin routes (an email in ADMIN_EMAILS) move people between volunteers, upload the state's sheet and read the audit log.
// Every change writes an audit row. Only erasable TypeScript syntax.
import type {
  AdminSettings,
  AdminStats,
  ApiError,
  AuditEntry,
  ColumnPick,
  ContactMethod,
  Me,
  MergePair,
  Note,
  PeoplePage,
  Person,
  PersonDetail,
  ResetResult,
  StageStart,
  Status,
  Volunteer,
  VolunteerStats,
} from '../src/api.d.ts';
import type { IncomingPerson } from '../src/sheet.ts';
import { FIELDS } from '../src/sheet.ts';
import type { Db, Stmt, Value } from './db.ts';
import { censusLine, GeocodeError, geocodeChunk, placeByHand, unplacedPeople, waitingForGeocode } from './geocode.ts';
import { boxOf, pinsIn } from './map.ts';
import { homeOf, inCountry, nearestTown, nearSql, type Place, roundPlace, zipCenter } from './near.ts';
import {
  finishStage,
  graceCycles,
  MAX_GRACE_CYCLES,
  MAX_STAGE_PEOPLE,
  MAX_STAGE_ROWS,
  MergeError,
  PartialUploadError,
  planStage,
  StageError,
  savedColumns,
  savedFacets,
  setMerges,
  stageRows,
  startStage,
  uploadRecord,
} from './uploads.ts';

export interface ApiContext {
  db: Db;
  email: string;
  isAdmin: boolean;
  // Whether this deployment lets admins reset (ALLOW_RESET).
  allowReset: boolean;
  now: () => Date;
  fetcher: typeof fetch;
  // Whether the map's tile file is in place (worker/tiles.ts). Optional: without it the map has no basemap.
  tilesReady?: () => Promise<boolean>;
}

interface Ctx {
  db: Db;
  me: Volunteer;
  isAdmin: boolean;
  allowReset: boolean;
  now: string;
  today: string;
  fetcher: typeof fetch;
  tilesReady: () => Promise<boolean>;
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
  // In a "within N miles" search: the distance in miles, and whether the place is a guess.
  away?: number;
  approximate?: number;
}

const PERSON_COLUMNS = `SELECT p.id, p.first_name, p.middle_name, p.last_name, p.party, p.reason_code, p.phone, p.address, p.city, p.zip,
    p.precinct, p.status_date, p.status, p.status_changed_at, p.contact_method, p.assigned_to, p.flag,
    (SELECT COUNT(*) FROM notes n WHERE n.person_id = p.id) AS notes_count`;
const PERSON_SELECT = `${PERSON_COLUMNS}
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
    ...(r.away === undefined ? {} : { distanceMiles: Math.round(r.away * 10) / 10, approximate: r.approximate === 1 }),
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

// Where the volunteer saved themselves, with where that is in words.
async function myLocation(c: Ctx): Promise<Me['location']> {
  const home = await homeOf(c.db, c.me.id);
  return home ? { ...home, near: await nearestTown(c.db, home) } : null;
}

// A volunteer is "seen" at most this often. Every page asks who is signed in, and a write on each page load is a row written for nothing, and a
// page that cannot load when the database refuses writes (the free plan's daily limit).
const SEEN_EVERY_MS = 5 * 60_000;

async function getMe(c: Ctx): Promise<Response> {
  try {
    await c.db
      .prepare('UPDATE volunteers SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3')
      .bind(c.now, c.me.id, new Date(Date.parse(c.now) - SEEN_EVERY_MS).toISOString())
      .run();
  } catch (e) {
    // Being seen is not worth a page that does not load.
    console.warn('could not record last_seen_at', e);
  }
  const me: Me = { ...c.me, isAdmin: c.isAdmin, location: await myLocation(c) };
  return json(me);
}

async function putMe(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const name = text(body, 'name', 80);
  await c.db.batch([
    c.db.prepare('UPDATE volunteers SET name = ? WHERE id = ?').bind(name, c.me.id),
    auditStmt(c, 'volunteer.rename', null, { from: c.me.name, to: name }),
  ]);
  const me: Me = { ...c.me, name, isAdmin: c.isAdmin, location: await myLocation(c) };
  return json(me);
}

// Saves, or clears, where the volunteer is for "near me": a point from their device, or the middle of a ZIP. Rounded to about a mile either
// way, and the log says only that it happened: never where.
async function putLocation(c: Ctx, _p: string[], body: Body): Promise<Response> {
  let place: Place | null;
  let via: 'device' | 'zip' | 'clear';
  if (body.clear === true) {
    place = null;
    via = 'clear';
  } else if (body.zip !== undefined) {
    const zip = text(body, 'zip', 5);
    if (!/^\d{5}$/.test(zip)) throw new HttpError(400, 'A ZIP is five digits');
    const middle = await zipCenter(c.db, zip);
    if (!middle)
      throw new HttpError(
        400,
        'There are not enough people placed in that ZIP to tell where it is. Try a nearby ZIP, or use your location.',
      );
    place = { lat: roundPlace(middle.lat), lon: roundPlace(middle.lon) };
    via = 'zip';
  } else if (typeof body.lat === 'number' && typeof body.lon === 'number') {
    place = { lat: roundPlace(body.lat), lon: roundPlace(body.lon) };
    if (!inCountry(place)) throw new HttpError(400, 'That place is outside the United States');
    via = 'device';
  } else {
    throw new HttpError(400, 'Send lat and lon, or a zip, or clear: true');
  }
  await c.db.batch([
    c.db.prepare('UPDATE volunteers SET home_lat = ?, home_lon = ? WHERE id = ?').bind(place?.lat ?? null, place?.lon ?? null, c.me.id),
    auditStmt(c, place ? 'location.set' : 'location.clear', null, place ? { via } : {}),
  ]);
  return json({ location: place ? { ...place, near: await nearestTown(c.db, place) } : null });
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
  // "Within N miles" of the place the volunteer saved: only for the pool, and only with a saved place. Sorting by distance needs it too,
  // because a sort over everyone would read the whole pool.
  const milesRaw = url.searchParams.get('miles') ?? '';
  let near: { where: string; away: string } | null = null;
  if (milesRaw !== '') {
    if (scope !== 'pool') throw new HttpError(400, 'miles only applies to the pool');
    const miles = Number(milesRaw);
    if (!Number.isFinite(miles) || miles < 0.5 || miles > 100) throw new HttpError(400, 'miles must be from 0.5 to 100');
    const home = await homeOf(c.db, c.me.id);
    if (!home) throw new HttpError(400, 'Save your location first');
    near = nearSql(home, miles);
  }
  const sortName = url.searchParams.get('sort') ?? 'days';
  if (sortName === 'distance' && !near) throw new HttpError(400, 'Sorting by distance needs miles and a saved location');
  const terms = sortName === 'distance' ? ['away', 'p.id'] : PEOPLE_SORTS.get(sortName);
  if (terms === undefined) throw new HttpError(400, `sort must be one of ${[...PEOPLE_SORTS.keys(), 'distance'].join(', ')}`);
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
  if (near) where.push(near.where);
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
    .prepare(
      `${near ? `${PERSON_COLUMNS}, p.approximate AS approximate, ${near.away} AS away\n  FROM people p` : PERSON_SELECT}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
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

// The pins for the map: the open pool inside the box in the query (west, south, east, north), as [id, lat, lon, approximate], and whether the basemap file is there. Everyone sees
// the pool already, so the map shows nothing the list does not.
async function mapPins(c: Ctx, _p: string[], _b: Body, url: URL): Promise<Response> {
  const box = boxOf(url.searchParams);
  if (!box) throw new HttpError(400, 'Send west, south, east and north: a box in the United States');
  return json({ ...(await pinsIn(c.db, box)), tiles: await c.tilesReady() });
}

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
         COALESCE(SUM(status != 'cured' AND flag IS NOT NULL), 0) AS flagged,
         COALESCE(SUM(status != 'cured' AND geocode IS NULL), 0) AS waiting, COALESCE(SUM(status != 'cured' AND lat IS NOT NULL AND approximate = 0), 0) AS located,
         COALESCE(SUM(status != 'cured' AND placed_by IS NOT NULL), 0) AS by_hand,
         COALESCE(SUM(status != 'cured' AND approximate = 1), 0) AS roughly,
         COALESCE(SUM(status != 'cured' AND geocode IN ('no_match', 'tie') AND lat IS NULL), 0) AS nowhere,
         COALESCE(SUM(status != 'cured' AND geocode IN ('no_match', 'tie')), 0) AS unlocated
       FROM people`,
    )
    .first<{
      needs: number;
      voicemail: number;
      contacted: number;
      cured: number;
      unassigned: number;
      flagged: number;
      waiting: number;
      located: number;
      roughly: number;
      by_hand: number;
      nowhere: number;
      unlocated: number;
    }>();
  const sample = (await waitingForGeocode(c.db, 0, 3)).map(censusLine);
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
    geocode: {
      waiting: totals?.waiting ?? 0,
      matched: totals?.located ?? 0,
      approximate: totals?.roughly ?? 0,
      noPlace: totals?.nowhere ?? 0,
      byHand: totals?.by_hand ?? 0,
      unmatched: totals?.unlocated ?? 0,
      sample,
    },
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

// A count in a request: a whole number from 0 to max.
function count(body: Body, name: string, max: number): number {
  const v = body[name];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max)
    throw new HttpError(400, `${name} must be a whole number from 0 to ${max}`);
  return v;
}

const isStrings = (v: unknown, most: number, longest: number): v is string[] =>
  Array.isArray(v) && v.length <= most && v.every((x) => typeof x === 'string' && x.length <= longest);

// The column of the file used for each field: an object of field name to a header of the file.
function columnPick(raw: unknown, what: string): ColumnPick {
  if (!isObject(raw)) throw new HttpError(400, `${what} must be an object`);
  const picked: ColumnPick = {};
  for (const [name, value] of Object.entries(raw)) {
    const field = FIELDS.find((f) => f.key === name);
    if (!field) throw new HttpError(400, `${name} is not a column the importer reads`);
    if (value !== null && (typeof value !== 'string' || value.length > 200))
      throw new HttpError(400, `${what}.${name} must be a header or null`);
    picked[field.key] = value;
  }
  return picked;
}

// What the browser says about the file it is about to send. The Worker cannot check these, so they only shape what the admin sees.
function stageStartOf(body: Body): StageStart {
  const columns = body.columns;
  if (
    !isObject(columns) ||
    !isStrings(columns.headers, 300, 200) ||
    !isStrings(columns.sample, 300, 500) ||
    !Array.isArray(columns.choices) ||
    columns.choices.length > FIELDS.length ||
    typeof columns.ready !== 'boolean'
  )
    throw new HttpError(400, 'columns is not a column map');
  const cities = body.cities;
  if (
    !Array.isArray(cities) ||
    cities.length > 300 ||
    !cities.every((c) => isObject(c) && typeof c.city === 'string' && c.city.length <= 100 && Number.isSafeInteger(c.count))
  )
    throw new HttpError(400, 'cities is not a list of cities and counts');
  if (!isStrings(body.warnings, 50, 500)) throw new HttpError(400, 'warnings must be a short list of text');
  const expected = count(body, 'expected', MAX_STAGE_PEOPLE);
  if (expected < 1) throw new HttpError(400, 'expected must be at least 1');
  return {
    filename: text(body, 'filename', 200, false),
    keyVersion: count(body, 'keyVersion', 1000),
    expected,
    rows: count(body, 'rows', 1_000_000),
    skippedOtherDistrict: count(body, 'skippedOtherDistrict', 1_000_000),
    skippedInvalid: count(body, 'skippedInvalid', 1_000_000),
    duplicates: count(body, 'duplicates', 1_000_000),
    warnings: body.warnings,
    cities: cities as StageStart['cities'],
    columns: columns as unknown as StageStart['columns'],
    used: columnPick(body.used ?? {}, 'used'),
  };
}

const ROW_TEXT = [
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
] as const;
// "FIRST|LAST|ADDRESS", each with only the letters, digits and spaces that normalizeKey leaves.
const KEY = /^[A-Z0-9 ]*\|[A-Z0-9 ]*\|[A-Z0-9 ]*$/;

// People as the browser read them (src/sheet.ts). Checked here because the database trusts them.
function stagedRows(body: Body): IncomingPerson[] {
  const raw = body.rows;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STAGE_ROWS)
    throw new HttpError(400, `rows must be a list of 1 to ${MAX_STAGE_ROWS} people`);
  for (const r of raw) {
    if (!isObject(r) || typeof r.key !== 'string' || r.key.length > 1500 || !KEY.test(r.key))
      throw new HttpError(400, 'a person has no valid key');
    for (const f of ROW_TEXT)
      if (typeof r[f] !== 'string' || r[f].length > 500) throw new HttpError(400, `a person's ${f} must be text of at most 500 characters`);
    if (r.statusDate !== null && !(typeof r.statusDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.statusDate)))
      throw new HttpError(400, "a person's statusDate must be YYYY-MM-DD or null");
  }
  return raw as unknown as IncomingPerson[];
}

const tokenOf = (body: Body): string => text(body, 'token', 100);

// Pairs an admin marked as the same person: { id, key } each, as the possible matches list gave them.
function mergePairs(body: Body): MergePair[] {
  const raw = body.merges;
  if (!Array.isArray(raw) || raw.length > 1000) throw new HttpError(400, 'merges must be a list of at most 1000 pairs');
  return raw.map((m) => {
    if (
      !isObject(m) ||
      typeof m.id !== 'number' ||
      !Number.isSafeInteger(m.id) ||
      typeof m.key !== 'string' ||
      !KEY.test(m.key) ||
      m.key.length > 1500
    )
      throw new HttpError(400, 'a merge is { id, key }, as the possible matches list gives them');
    return { id: m.id, key: m.key };
  });
}

// StageError means the upload is not the current one, or not whole: the page should start again.
async function staged<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof StageError) throw new HttpError(409, e.message);
    throw e;
  }
}

// Looks up the next few hundred people who are waiting, after `after`, at the Census geocoder, and stores what it says.
async function geocode(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const after = body.after === undefined ? 0 : body.after;
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a person id or 0');
  try {
    return json(await geocodeChunk(c.db, c.me.email, c.now, after, c.fetcher, body.retry === true));
  } catch (e) {
    if (e instanceof GeocodeError) throw new HttpError(502, e.message);
    throw e;
  }
}

// The people the geocoder could not place, 50 at a time, for an admin to look up by hand.
async function unplaced(c: Ctx, _p: string[], _body: Body, url: URL): Promise<Response> {
  const raw = url.searchParams.get('after');
  const after = raw === null || raw === '' ? 0 : Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a person id');
  return json(await unplacedPeople(c.db, after));
}

async function uploadColumns(c: Ctx): Promise<Response> {
  return json(await savedColumns(c.db));
}

async function uploadStage(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const start = stageStartOf(body);
  return json(await staged(() => startStage(c.db, c.me.email, c.now, start)), 201);
}

async function uploadRows(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const rows = stagedRows(body);
  return json({ staged: await staged(() => stageRows(c.db, tokenOf(body), rows)) });
}

async function uploadMerges(c: Ctx, _p: string[], body: Body): Promise<Response> {
  const pairs = mergePairs(body);
  try {
    return json({ merged: await staged(() => setMerges(c.db, tokenOf(body), pairs)) });
  } catch (e) {
    if (e instanceof MergeError) throw new HttpError(400, e.message);
    throw e;
  }
}

async function uploadPlan(c: Ctx, _p: string[], body: Body): Promise<Response> {
  return json(await staged(() => planStage(c.db, tokenOf(body))));
}

async function uploadFinish(c: Ctx, _p: string[], body: Body): Promise<Response> {
  try {
    return json(await staged(() => finishStage(c.db, tokenOf(body), { now: c.now, actor: c.me.email, force: body.force === true })), 201);
  } catch (e) {
    if (e instanceof PartialUploadError) throw new HttpError(409, e.message, ['Send force: true to upload it anyway.']);
    throw e;
  }
}

// Places a person at coordinates an admin looked up, or ({ clear: true }) takes a hand-placed person's place away.
async function placePerson(c: Ctx, p: string[], body: Body): Promise<Response> {
  const id = idOf(p[0]);
  const row = await personRow(c, id);
  if (row.status === 'cured') throw new HttpError(409, `${nameOf(row)} is already cured`);
  if (body.clear === true) {
    await placeByHand(c.db, c.me.email, c.now, id, null);
    return json(toPerson(await personRow(c, id), c.today));
  }
  const { lat, lon } = body;
  if (typeof lat !== 'number' || typeof lon !== 'number') throw new HttpError(400, 'Send lat and lon (numbers), or clear: true');
  // To about a metre: a map gives more than anyone can use.
  const place = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  if (!inCountry(place)) throw new HttpError(400, 'That place is outside the United States');
  await placeByHand(c.db, c.me.email, c.now, id, place);
  return json(toPerson(await personRow(c, id), c.today));
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
    c.db.prepare('DELETE FROM upload_rows'),
    c.db.prepare('DELETE FROM upload_merges'),
    c.db.prepare('DELETE FROM upload_stage'),
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
  { method: 'PUT', pattern: /^\/api\/me\/location$/, admin: false, handler: putLocation },
  { method: 'GET', pattern: /^\/api\/volunteers$/, admin: false, handler: listVolunteers },
  { method: 'GET', pattern: /^\/api\/map$/, admin: false, handler: mapPins },
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
  { method: 'POST', pattern: /^\/api\/admin\/geocode$/, admin: true, handler: geocode },
  { method: 'GET', pattern: /^\/api\/admin\/geocode\/unplaced$/, admin: true, handler: unplaced },
  { method: 'GET', pattern: /^\/api\/admin\/uploads\/columns$/, admin: true, handler: uploadColumns },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/stage$/, admin: true, handler: uploadStage },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/stage\/rows$/, admin: true, handler: uploadRows },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/stage\/merges$/, admin: true, handler: uploadMerges },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/stage\/plan$/, admin: true, handler: uploadPlan },
  { method: 'POST', pattern: /^\/api\/admin\/uploads\/stage\/finish$/, admin: true, handler: uploadFinish },
  { method: 'POST', pattern: /^\/api\/admin\/people\/(\d+)\/assign$/, admin: true, handler: assign },
  { method: 'POST', pattern: /^\/api\/admin\/people\/(\d+)\/place$/, admin: true, handler: placePerson },
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
    const ctx: Ctx = {
      db: api.db,
      me,
      isAdmin: api.isAdmin,
      allowReset: api.allowReset,
      now: iso,
      today: arizonaDate(now),
      fetcher: api.fetcher,
      tilesReady: api.tilesReady ?? (async () => false),
    };
    const m = route.pattern.exec(url.pathname);
    return await route.handler(ctx, m?.slice(1) ?? [], body, url);
  } catch (e) {
    if (e instanceof HttpError) {
      const err: ApiError = e.problems.length > 0 ? { error: e.message, problems: e.problems } : { error: e.message };
      return json(err, e.status);
    }
    console.error('api error', e instanceof Error ? `${e.name}: ${e.message}` : e, e);
    return json({ error: 'Something went wrong' } satisfies ApiError, 500);
  }
}
