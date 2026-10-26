// Looks up where people live: sends their street addresses, and nothing else about them, to the US Census Bureau's batch geocoder and
// stores the coordinates it answers with. Run by an admin from the admin page, a couple of hundred people a request, because a free
// Worker has about 10 ms of CPU a request and no limit on how long it waits for an answer. Only erasable TypeScript syntax.
import type { GeocodeProgress } from '../src/api.d.ts';
import { parseCsv, streetLine } from '../src/sheet.ts';
import type { Db } from './db.ts';

// People looked up in one request. The Census takes up to 10,000 in a batch; this many keeps the Worker's own work (writing the request
// and reading the answer) small, and a failed request costs little.
export const GEOCODE_CHUNK = 200;
export const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
// The Census's current benchmark: the address ranges as of the latest release.
const BENCHMARK = 'Public_AR_Current';
const TIMEOUT_MS = 25_000;

// Thrown when the Census cannot be reached or does not answer properly. Nothing was written.
export class GeocodeError extends Error {}

interface Waiting {
  id: number;
  address: string;
  city: string;
  zip: string;
}

const quoted = (s: string): string => `"${s.replaceAll('"', '""')}"`;

// The line the Census reads for one person: an id and an address (street, city, state, ZIP). No name, phone or anything else.
export const censusLine = (p: Waiting): string =>
  [String(p.id), quoted(streetLine(p.address, p.city)), quoted(p.city), 'AZ', quoted(p.zip)].join(',');

// Who is still waiting: open people with no answer yet, after `after`, in id order.
export async function waitingForGeocode(db: Db, after: number, limit: number): Promise<Waiting[]> {
  const { results } = await db
    .prepare("SELECT id, address, city, zip FROM people WHERE id > ?1 AND status != 'cured' AND geocode IS NULL ORDER BY id LIMIT ?2")
    .bind(after, limit)
    .all<Waiting>();
  return results;
}

interface Answer {
  id: number;
  address: string;
  geocode: 'match' | 'no_match' | 'tie';
  lat: number | null;
  lon: number | null;
}

// "x,y" as the Census writes a point (longitude first), or null when it is not a place on Earth.
function pointOf(text: string | undefined): { lat: number; lon: number } | null {
  const [x, y] = (text ?? '').split(',').map((v) => Number(v));
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)
    return null;
  return { lat: y, lon: x };
}

// Looks up the next people after `after` and stores what comes back. `next` is where to go on from, null when there is no one left.
// `fetcher` is the global fetch; tests give their own.
export async function geocodeChunk(
  db: Db,
  actor: string,
  now: string,
  after: number,
  fetcher: typeof fetch = fetch,
): Promise<GeocodeProgress> {
  const people = await waitingForGeocode(db, after, GEOCODE_CHUNK);
  const last = people.at(-1);
  if (!last) return { sent: 0, matched: 0, noMatch: 0, unanswered: 0, next: null };

  const form = new FormData();
  form.append('addressFile', new Blob([people.map(censusLine).join('\n')], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', BENCHMARK);
  let text: string;
  try {
    const res = await fetcher(CENSUS_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new GeocodeError(`The Census geocoder answered HTTP ${res.status}. Try again in a few minutes.`);
    text = await res.text();
  } catch (e) {
    if (e instanceof GeocodeError) throw e;
    throw new GeocodeError('The Census geocoder did not answer. Try again in a few minutes.');
  }

  // "id","input address","Match"|"No_Match"|"Tie","Exact"|"Non_Exact","matched address","x,y","tiger line id","side"; a row with no match has only
  // the first three fields.
  const asked = new Map(people.map((p) => [p.id, p]));
  const answers: Answer[] = [];
  for (const row of parseCsv(text)) {
    const person = asked.get(Number(row[0]));
    if (!person) continue;
    const kind = (row[2] ?? '').trim().toLowerCase();
    const point = kind === 'match' ? pointOf(row[5]) : null;
    if (kind !== 'match' && kind !== 'no_match' && kind !== 'tie') continue;
    answers.push({
      id: person.id,
      address: person.address,
      geocode: point ? 'match' : kind === 'tie' ? 'tie' : 'no_match',
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
    });
    asked.delete(person.id);
  }

  const matched = answers.filter((a) => a.geocode === 'match').length;
  // The address is checked again as it is written, in case an upload changed it while the Census was thinking.
  await db.batch([
    db
      .prepare(
        `WITH j AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.address') AS address, json_extract(value, '$.geocode') AS geocode,
           json_extract(value, '$.lat') AS lat, json_extract(value, '$.lon') AS lon FROM json_each(?1))
         UPDATE people SET lat = j.lat, lon = j.lon, geocode = j.geocode, geocoded_at = ?2
         FROM j WHERE people.id = j.id AND people.address = j.address`,
      )
      .bind(JSON.stringify(answers), now),
    db
      .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)')
      .bind(
        now,
        actor,
        'geocode',
        JSON.stringify({ sent: people.length, matched, noMatch: answers.length - matched, unanswered: asked.size }),
      ),
  ]);
  return {
    sent: people.length,
    matched,
    noMatch: answers.length - matched,
    unanswered: asked.size,
    next: people.length === GEOCODE_CHUNK ? last.id : null,
  };
}
