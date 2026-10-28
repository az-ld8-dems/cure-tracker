// Phone numbers entered by hand for people whose row on the state's sheet has none. An organizer or admin finds the number some other way
// and types it in; it is marked (people.phone_by) so an upload does not wipe it and so it can be corrected or taken away. Only erasable
// TypeScript syntax.
import type { MissingPhonePage } from '../src/api.d.ts';
import type { Db } from './db.ts';
import { type Scope, scopeWhere } from './organizers.ts';

const PAGE = 50;

// "(480) 555-0123", "480.555.0123", "+1 480 555 0123" and "4805550123" are all 480-555-0123, the way the sheet writes its numbers. Anything that
// is not ten digits (after a leading 1 for the country) is null. Area and exchange codes cannot start with 0 or 1.
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// Open people in the caller's precincts who have no phone number, or whose number was entered by hand (so it can be corrected), 50 at a time
// after `after`, optionally only those whose name or address matches `like` (a LIKE pattern, ESCAPE '\'). `total` counts the whole list.
export async function missingPhones(db: Db, scope: Scope, after: number, like: string): Promise<MissingPhonePage> {
  const only = scopeWhere(scope, 'precinct');
  const listed = `status != 'cured' AND (phone = '' OR phone_by IS NOT NULL) AND ${only.sql}`;
  const { results } = await db
    .prepare(
      `SELECT id, first_name, last_name, address, precinct, phone, phone_by FROM people
       WHERE id > ? AND ${listed} AND (first_name || ' ' || last_name || ' ' || address) LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?`,
    )
    .bind(after, ...only.binds, like, PAGE + 1)
    .all<{
      id: number;
      first_name: string;
      last_name: string;
      address: string;
      precinct: string;
      phone: string;
      phone_by: string | null;
    }>();
  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM people WHERE ${listed}`)
    .bind(...only.binds)
    .first<{ n: number }>();
  const page = results.slice(0, PAGE);
  return {
    people: page.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      address: r.address,
      precinct: r.precinct,
      phone: r.phone_by === null ? '' : r.phone,
      byHand: r.phone_by !== null,
    })),
    next: results.length > PAGE ? (page.at(-1)?.id ?? null) : null,
    total: total?.n ?? 0,
  };
}
