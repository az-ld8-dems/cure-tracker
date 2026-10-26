// "Near me": where a volunteer is (a rounded point they chose to save) and the SQL that finds the people within some miles of it, by
// great-circle distance (the haversine formula, which D1's math functions can do). Free of Worker-only globals. Only erasable TypeScript
// syntax.
import type { Db } from './db.ts';

export interface Place {
  lat: number;
  lon: number;
}

// The Earth's mean radius in miles.
const EARTH_MILES = 3958.8;
const DEGREES = 180 / Math.PI;

// A saved place is only ever this precise: 0.01 degrees is about 0.7 miles. The browser rounds, and the Worker rounds again.
export const roundPlace = (v: number): number => Math.round(v * 100) / 100;

// The continental United States, with room: a point outside it is a mistake.
export const inCountry = (p: Place): boolean =>
  Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= 24 && p.lat <= 50 && p.lon >= -125 && p.lon <= -66;

// A ZIP needs this many placed people before its middle can stand for a volunteer: fewer, and it could be one person's house.
export const ZIP_CENTER_MIN = 5;

const num = (n: number): string => `(${n.toFixed(8)})`;

// SQL for "within `miles` of `home`", for the people p: a box the (lat, lon) index can read (the smallest box that holds the circle), then
// the circle itself. `away` is the distance in miles, for sorting and for the distance shown. The numbers are ones this code worked out,
// written into the SQL; nothing from a request.
export function nearSql(home: Place, miles: number): { where: string; away: string } {
  const angle = miles / EARTH_MILES;
  const dLat = angle * DEGREES;
  // The longitude reach of a circle of this size at this latitude; past the poles' neighbourhood it would be the whole globe.
  const dLon = Math.asin(Math.min(1, Math.sin(angle) / Math.cos((home.lat * Math.PI) / 180))) * DEGREES;
  const haversine = `(power(sin(radians(p.lat - ${num(home.lat)}) / 2), 2) + cos(radians(${num(home.lat)})) * cos(radians(p.lat)) * power(sin(radians(p.lon - ${num(home.lon)}) / 2), 2))`;
  const away = `(2 * ${num(EARTH_MILES)} * asin(sqrt(min(1.0, ${haversine}))))`;
  return {
    away,
    where: `p.lat BETWEEN ${num(home.lat - dLat)} AND ${num(home.lat + dLat)} AND p.lon BETWEEN ${num(home.lon - dLon)} AND ${num(home.lon + dLon)} AND ${away} <= ${num(miles)}`,
  };
}

// Great-circle miles between two places, for checks made in the Worker (the SQL above does it for whole searches).
export function milesBetween(a: Place, b: Place): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(Math.min(1, h)));
}

// The town of the nearest person in the pool within 25 miles of a place, as "Phoenix 85018", so a volunteer can be told where they are in words.
// null when no one waiting is that close. Reads a band of the map through the (lat, lon) index.
export async function nearestTown(db: Db, home: Place): Promise<string | null> {
  const { where, away } = nearSql(home, 25);
  const row = await db
    .prepare(
      `SELECT p.city, p.zip FROM people p WHERE p.assigned_to IS NULL AND p.status != 'cured' AND ${where} ORDER BY ${away}, p.id LIMIT 1`,
    )
    .first<{ city: string; zip: string }>();
  return row ? [row.city, row.zip].filter((v) => v !== '').join(' ') || null : null;
}

// The place a volunteer saved, or null.
export async function homeOf(db: Db, volunteerId: number): Promise<Place | null> {
  const row = await db
    .prepare('SELECT home_lat, home_lon FROM volunteers WHERE id = ?')
    .bind(volunteerId)
    .first<{ home_lat: number | null; home_lon: number | null }>();
  return row && row.home_lat !== null && row.home_lon !== null ? { lat: row.home_lat, lon: row.home_lon } : null;
}

// The middle of a ZIP: the average of the people the geocoder placed exactly there, when there are enough. A way to say "around here" without
// the device's location.
export async function zipCenter(db: Db, zip: string): Promise<Place | null> {
  const row = await db
    .prepare("SELECT AVG(lat) AS lat, AVG(lon) AS lon, COUNT(*) AS n FROM people WHERE zip = ? AND geocode = 'match' AND approximate = 0")
    .bind(zip)
    .first<{ lat: number | null; lon: number | null; n: number }>();
  return row && row.n >= ZIP_CENTER_MIN && row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
}
