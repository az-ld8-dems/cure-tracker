// The pins on the map: where the open pool is, inside a box. Free of Worker-only globals. Only erasable TypeScript syntax.
import type { Db } from './db.ts';
import { inCountry } from './near.ts';

export interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

// One pin is [id, latitude, longitude, 1 when the place is a guess (the middle of a ZIP, or a match the Census calls non-exact) and 0
// when it is exact (or set by hand)].
export type Pin = [number, number, number, 0 | 1];

// The district holds a few thousand people; this is the room for a pool several times that. Past it the map says it is not showing
// everyone.
export const MAX_PINS = 20_000;

// The open pool inside the box. The partial index people_pool_place (migration 0008) holds exactly these people by latitude and
// longitude, so the box is read from the index, and the pool condition below is that index's own, word for word.
export async function pinsIn(db: Db, box: Box): Promise<{ pins: Pin[]; more: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.lat, p.lon, p.approximate FROM people p
       WHERE p.assigned_to IS NULL AND p.status != 'cured' AND p.lat IS NOT NULL AND p.lat BETWEEN ?1 AND ?2 AND p.lon BETWEEN ?3 AND ?4
       ORDER BY p.lat, p.lon LIMIT ?5`,
    )
    .bind(box.south, box.north, box.west, box.east, MAX_PINS + 1)
    .all<{ id: number; lat: number; lon: number; approximate: number }>();
  const more = results.length > MAX_PINS;
  return { pins: results.slice(0, MAX_PINS).map((r): Pin => [r.id, r.lat, r.lon, r.approximate ? 1 : 0]), more };
}

// A box from the query string, or null when it is not a box inside the country, south of north and west of east.
export function boxOf(params: URLSearchParams): Box | null {
  const get = (k: string): number => (params.get(k) === null || params.get(k) === '' ? Number.NaN : Number(params.get(k)));
  const box = { west: get('west'), south: get('south'), east: get('east'), north: get('north') };
  if (!inCountry({ lat: box.south, lon: box.west }) || !inCountry({ lat: box.north, lon: box.east })) return null;
  return box.south < box.north && box.west < box.east ? box : null;
}
