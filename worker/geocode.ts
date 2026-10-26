// Looks up where people live: sends their street addresses, and nothing else about them, to the US Census Bureau's batch geocoder and
// stores the coordinates it answers with. Run by an admin from the admin page, a couple of hundred people a request, because a free
// Worker has about 10 ms of CPU a request and no limit on how long it waits for an answer. Only erasable TypeScript syntax.
import type { GeocodeProgress, UnplacedPage } from '../src/api.d.ts';
import { parseCsv, streetForGeocoder } from '../src/sheet.ts';
import type { Db } from './db.ts';
import { milesBetween, type Place } from './near.ts';

// People looked up in one request. The Census takes up to 10,000 in a batch; this many keeps the Worker's own work (writing the request
// and reading the answer) small, and a failed request costs little.
export const GEOCODE_CHUNK = 200;
// A ZIP needs this many people the geocoder placed before its middle stands in for someone it could not: fewer, and the middle could be one
// person's house.
export const ZIP_PLACE_MIN = 5;
// An answer found by the street alone (no city or ZIP) is believed only if it is this near the middle of the person's ZIP: the Census may
// find the same street and number in another town.
export const ALONE_MAX_MILES = 15;
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

// The line the Census reads for one person: an id and an address (street without its unit, city, state, ZIP). No name, phone or anything
// else.
export const censusLine = (p: Waiting): string =>
  [String(p.id), quoted(streetForGeocoder(p.address, p.city)), quoted(p.city), 'AZ', quoted(p.zip)].join(',');

// The second try, for someone the first missed: the street alone. When the sheet's city or ZIP is not where the Census puts a street (a
// boundary between towns, a mailing city that is not the jurisdiction), the same street can match with neither. Its id is the person's with a b.
const aloneLine = (p: Waiting): string => [`${p.id}b`, quoted(streetForGeocoder(p.address, p.city)), '""', 'AZ', '""'].join(',');

// Who is still waiting: open people with no answer yet, after `after`, in id order. With `retry`, also those the geocoder could not place
// last time (a tie or a miss can come out differently after the Census updates its data).
export async function waitingForGeocode(db: Db, after: number, limit: number, retry = false): Promise<Waiting[]> {
  const { results } = await db
    .prepare(
      `SELECT id, address, city, zip FROM people
       WHERE id > ?1 AND status != 'cured' AND (geocode IS NULL OR (?3 = 1 AND geocode IN ('no_match', 'tie'))) ORDER BY id LIMIT ?2`,
    )
    .bind(after, limit, retry ? 1 : 0)
    .all<Waiting>();
  return results;
}

// Puts each open person the geocoder could not place at the middle of their ZIP: the average of the people it did place there, when there
// are enough of them. Marked approximate. People who already have a place (a guess from an earlier run) are left alone.
const PLACE_BY_ZIP = `
  UPDATE people SET lat = z.lat, lon = z.lon, approximate = 1, geocoded_at = ?1
  FROM (SELECT zip, AVG(lat) AS lat, AVG(lon) AS lon FROM people WHERE geocode = 'match' AND approximate = 0 AND zip != '' GROUP BY zip
        HAVING COUNT(*) >= ?2) z
  WHERE people.zip = z.zip AND people.status != 'cured' AND people.geocode IN ('no_match', 'tie') AND people.lat IS NULL`;

const changed = (result: unknown): number => {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return meta?.changes ?? 0;
};

interface Answer {
  id: number;
  address: string;
  geocode: 'match' | 'no_match' | 'tie';
  lat: number | null;
  lon: number | null;
  // 1 for a match the Census calls non-exact (the street found, the number or side of the street guessed).
  approximate: 0 | 1;
}

// What the Census said about one line of a request.
interface Said {
  kind: 'match' | 'no_match' | 'tie';
  place: Place | null;
  exact: boolean;
}

// The middle of each of these ZIPs (the people the geocoder placed exactly there, when there are enough).
async function zipMiddles(db: Db, zips: string[]): Promise<Map<string, Place>> {
  if (zips.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT zip, AVG(lat) AS lat, AVG(lon) AS lon FROM people
       WHERE geocode = 'match' AND approximate = 0 AND zip IN (SELECT value FROM json_each(?1)) GROUP BY zip HAVING COUNT(*) >= ?2`,
    )
    .bind(JSON.stringify(zips), ZIP_PLACE_MIN)
    .all<{ zip: string; lat: number; lon: number }>();
  return new Map(results.map((r) => [r.zip, { lat: r.lat, lon: r.lon }]));
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
  retry = false,
): Promise<GeocodeProgress> {
  const people = await waitingForGeocode(db, after, GEOCODE_CHUNK, retry);
  const last = people.at(-1);
  if (!last) {
    // Nobody left to send: the run is over, so those it could not place get the middle of their ZIP.
    const approximated = changed(await db.prepare(PLACE_BY_ZIP).bind(now, ZIP_PLACE_MIN).run());
    return { sent: 0, matched: 0, noMatch: 0, unanswered: 0, approximated, next: null };
  }

  const form = new FormData();
  // A retry also tries each person's street alone, as a second line with the id plus a b.
  const lines = people.flatMap((p) => (retry ? [censusLine(p), aloneLine(p)] : [censusLine(p)]));
  form.append('addressFile', new Blob([lines.join('\n')], { type: 'text/csv' }), 'addresses.csv');
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
  const said = new Map<string, Said>();
  for (const row of parseCsv(text)) {
    const kind = (row[2] ?? '').trim().toLowerCase();
    if (kind !== 'match' && kind !== 'no_match' && kind !== 'tie') continue;
    const place = kind === 'match' ? pointOf(row[5]) : null;
    said.set(row[0] ?? '', {
      kind: kind === 'match' && !place ? 'no_match' : kind,
      place,
      exact: (row[3] ?? '').trim().toLowerCase() === 'exact',
    });
  }
  // Someone the first line did not place but the street alone did needs checking: is it near their ZIP?
  const rescued = people.filter((p) => said.get(String(p.id))?.kind !== 'match' && said.get(`${p.id}b`)?.kind === 'match');
  const middles = await zipMiddles(db, [...new Set(rescued.map((p) => p.zip).filter((z) => z !== ''))]);
  const asked = new Map(people.map((p) => [p.id, p]));
  const answers: Answer[] = [];
  for (const person of people) {
    const first = said.get(String(person.id));
    const alone = said.get(`${person.id}b`);
    const middle = middles.get(person.zip);
    const useAlone =
      first?.kind !== 'match' &&
      alone?.kind === 'match' &&
      alone.place !== null &&
      middle !== undefined &&
      milesBetween(middle, alone.place) <= ALONE_MAX_MILES;
    const chosen = first?.kind === 'match' ? first : useAlone ? alone : first;
    if (!chosen) continue;
    answers.push({
      id: person.id,
      address: person.address,
      geocode: chosen.kind,
      lat: chosen.place?.lat ?? null,
      lon: chosen.place?.lon ?? null,
      approximate: chosen.kind === 'match' && !chosen.exact ? 1 : 0,
    });
    asked.delete(person.id);
  }

  const matched = answers.filter((a) => a.geocode === 'match').length;
  const lastChunk = people.length < GEOCODE_CHUNK;
  // The address is checked again as it is written, in case an upload changed it while the Census was thinking. A miss keeps a guess an
  // earlier run made (retrying must not take it away). The last chunk ends the run, and those still unplaced get the middle of their ZIP.
  const results = await db.batch([
    db
      .prepare(
        `WITH j AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.address') AS address, json_extract(value, '$.geocode') AS geocode,
           json_extract(value, '$.lat') AS lat, json_extract(value, '$.lon') AS lon,
           json_extract(value, '$.approximate') AS approximate FROM json_each(?1))
         UPDATE people SET
           lat = CASE WHEN j.geocode = 'match' THEN j.lat ELSE people.lat END, lon = CASE WHEN j.geocode = 'match' THEN j.lon ELSE people.lon END,
           approximate = CASE WHEN j.geocode = 'match' THEN j.approximate ELSE people.approximate END,
           placed_by = CASE WHEN j.geocode = 'match' THEN NULL ELSE people.placed_by END, geocode = j.geocode, geocoded_at = ?2
         FROM j WHERE people.id = j.id AND people.address = j.address`,
      )
      .bind(JSON.stringify(answers), now),
    db
      .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, NULL, ?)')
      .bind(
        now,
        actor,
        'geocode',
        JSON.stringify({ sent: people.length, matched, noMatch: answers.length - matched, unanswered: asked.size, retry }),
      ),
    ...(lastChunk ? [db.prepare(PLACE_BY_ZIP).bind(now, ZIP_PLACE_MIN)] : []),
  ]);
  return {
    sent: people.length,
    matched,
    noMatch: answers.length - matched,
    unanswered: asked.size,
    approximated: lastChunk ? changed(results[2]) : 0,
    next: lastChunk ? null : last.id,
  };
}

export const UNPLACED_PAGE = 50;

interface UnplacedRow {
  id: number;
  first_name: string;
  last_name: string;
  address: string;
  geocode: 'no_match' | 'tie';
  approximate: number;
  placed_by: string | null;
  lat: number | null;
  lon: number | null;
}

// Open people the geocoder could not place, 50 at a time after `after`, for an admin to look up by hand. `approximate` says they have the
// middle of their ZIP in the meantime.
export async function unplacedPeople(db: Db, after: number): Promise<UnplacedPage> {
  const { results } = await db
    .prepare(
      `SELECT id, first_name, last_name, address, geocode, approximate, placed_by, lat, lon FROM people
       WHERE id > ?1 AND status != 'cured' AND geocode IN ('no_match', 'tie') ORDER BY id LIMIT ?2`,
    )
    .bind(after, UNPLACED_PAGE + 1)
    .all<UnplacedRow>();
  const page = results.slice(0, UNPLACED_PAGE);
  return {
    people: page.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      address: r.address,
      reason: r.geocode,
      approximate: r.approximate === 1,
      byHand: r.placed_by !== null && r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon } : null,
    })),
    next: results.length > UNPLACED_PAGE ? (page.at(-1)?.id ?? null) : null,
  };
}

// What an admin does to a person's place by hand.
export type HandPlace = { lat: number; lon: number } | null;

// Puts a person at a place an admin looked up (or, with null, takes a hand-placed person's place away). The geocoder's own verdict stays as it
// was; the place counts as exact, and is the admin's until the geocoder finds the person or an upload changes their address.
export async function placeByHand(db: Db, actor: string, now: string, id: number, place: HandPlace): Promise<void> {
  await db.batch([
    place
      ? db
          .prepare('UPDATE people SET lat = ?1, lon = ?2, approximate = 0, placed_by = ?3, geocoded_at = ?4, updated_at = ?4 WHERE id = ?5')
          .bind(place.lat, place.lon, actor, now, id)
      : db
          .prepare(
            'UPDATE people SET lat = NULL, lon = NULL, approximate = 0, placed_by = NULL, updated_at = ?1 WHERE id = ?2 AND placed_by IS NOT NULL',
          )
          .bind(now, id),
    db
      .prepare('INSERT INTO audit (at, actor, action, person_id, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(now, actor, place ? 'person.place' : 'person.unplace', id, '{}'),
  ]);
}
