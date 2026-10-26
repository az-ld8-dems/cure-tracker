// Precinct organizers: volunteers a site admin lets move people between volunteers in some precincts, or in all of them. The grants are rows
// in `organizers` (migration 0010); a site admin (the ADMIN_EMAILS secret) organizes everything and needs none.
import type { Db, Stmt } from './db.ts';

export const ALL_PRECINCTS = '*';
const MAX_GRANTS = 200;
const MAX_PRECINCT = 40;

// What a person may organize. `all` includes people with a blank precinct; so does any scope, because those can be moved by anyone who organizes.
export interface Scope {
  all: boolean;
  precincts: string[];
}

export const EVERYTHING: Scope = { all: true, precincts: [] };

// The scope of a volunteer, or null when they organize nothing. A site admin always has everything.
export async function scopeOf(db: Db, volunteerId: number, isAdmin: boolean): Promise<Scope | null> {
  if (isAdmin) return EVERYTHING;
  const { results } = await db
    .prepare('SELECT precinct FROM organizers WHERE volunteer_id = ? ORDER BY precinct COLLATE NOCASE')
    .bind(volunteerId)
    .all<{ precinct: string }>();
  if (results.length === 0) return null;
  const all = results.some((r) => r.precinct === ALL_PRECINCTS);
  return { all, precincts: all ? [] : results.map((r) => r.precinct) };
}

// Whether the email belongs to a volunteer who organizes something: for the admin pages, before a volunteer row is looked up.
export async function organizesAnything(db: Db, email: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS yes FROM organizers o JOIN volunteers v ON v.id = o.volunteer_id WHERE v.email = ? LIMIT 1')
    .bind(email)
    .first<{ yes: number }>();
  return row !== null;
}

export function inScope(scope: Scope, precinct: string): boolean {
  if (scope.all || precinct === '') return true;
  const want = precinct.toLowerCase();
  return scope.precincts.some((p) => p.toLowerCase() === want);
}

// A SQL condition on `column` (the precinct column of a table alias) for what the scope covers, with its bind values.
export function scopeWhere(scope: Scope, column: string): { sql: string; binds: string[] } {
  if (scope.all) return { sql: '1', binds: [] };
  return {
    sql: `(${column} = '' OR ${column} COLLATE NOCASE IN (SELECT value FROM json_each(?)))`,
    binds: [JSON.stringify(scope.precincts)],
  };
}

export interface Grant {
  all: boolean;
  precincts: string[];
}

// Checks what an admin sent for someone's grant: precincts are short, non-blank text, kept once each (ignoring case).
export function parseGrant(body: Record<string, unknown>): Grant {
  if (typeof body.all !== 'boolean') throw new RangeError('all must be true or false');
  const list = body.precincts;
  if (!Array.isArray(list) || list.length > MAX_GRANTS) throw new RangeError(`precincts must be a list of at most ${MAX_GRANTS}`);
  const seen = new Map<string, string>();
  for (const item of list) {
    if (typeof item !== 'string') throw new RangeError('each precinct must be text');
    const precinct = item.trim();
    if (precinct === '' || precinct.length > MAX_PRECINCT || precinct === ALL_PRECINCTS)
      throw new RangeError(`a precinct must be 1 to ${MAX_PRECINCT} characters, and not ${ALL_PRECINCTS}`);
    if (!seen.has(precinct.toLowerCase())) seen.set(precinct.toLowerCase(), precinct);
  }
  return { all: body.all, precincts: body.all ? [] : [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) };
}

export interface OrganizerRow {
  volunteerId: number;
  all: boolean;
  precincts: string[];
}

// Everyone's grants, one entry per volunteer who has any.
export async function allGrants(db: Db): Promise<OrganizerRow[]> {
  const { results } = await db
    .prepare('SELECT volunteer_id, precinct FROM organizers ORDER BY volunteer_id, precinct COLLATE NOCASE')
    .all<{ volunteer_id: number; precinct: string }>();
  const by = new Map<number, OrganizerRow>();
  for (const r of results) {
    const row = by.get(r.volunteer_id) ?? { volunteerId: r.volunteer_id, all: false, precincts: [] };
    if (r.precinct === ALL_PRECINCTS) row.all = true;
    else row.precincts.push(r.precinct);
    by.set(r.volunteer_id, row);
  }
  return [...by.values()].map((r) => (r.all ? { ...r, precincts: [] } : r));
}

// The statements that replace a volunteer's grant with `grant`.
export function replaceGrant(db: Db, volunteerId: number, grant: Grant, by: string, now: string): Stmt[] {
  const rows = grant.all ? [ALL_PRECINCTS] : grant.precincts;
  return [
    db.prepare('DELETE FROM organizers WHERE volunteer_id = ?').bind(volunteerId),
    ...rows.map((precinct) =>
      db
        .prepare('INSERT INTO organizers (volunteer_id, precinct, granted_by, granted_at) VALUES (?, ?, ?, ?)')
        .bind(volunteerId, precinct, by, now),
    ),
  ];
}
