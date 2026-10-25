// Reads the state's sheet (the LD8 tab exported as CSV) and works out what an upload changes, without touching the database: the
// people to add, update, cure or flag. worker/uploads.ts runs the plan. Free of Worker-only globals, so Node tests it. Only erasable
// TypeScript syntax.
import type { Flag, PossibleMatch, Status } from '../src/api.d.ts';

export class ImportError extends Error {
  problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.problems = problems;
  }
}

// What the sheet calls its columns. FIRST, LAST and ADDRESS identify a person, so they must be there; the rest are optional because
// the columns on the real sheets vary, though their names do not.
const REQUIRED = ['FIRST', 'LAST', 'ADDRESS'];

export interface IncomingPerson {
  key: string;
  firstName: string;
  middleName: string;
  lastName: string;
  party: string;
  legdist: string;
  reasonCode: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  precinct: string;
  statusDate: string | null;
}

export interface Sheet {
  people: IncomingPerson[];
  rows: number;
  skippedOtherDistrict: number;
  skippedInvalid: number;
  duplicates: number;
  warnings: string[];
}

// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. The delimiter is a comma, or a tab when the header line has
// more tabs than commas (a sheet pasted as text).
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src.charAt(i + 1) === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const clean = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// The sheet has no stable id, so a person is their normalized first name, last name and address. Middle names, punctuation, case and
// spacing do not count.
export function normalizeKey(first: string, last: string, address: string): string {
  return `${clean(first)}|${clean(last)}|${clean(address)}`;
}

// Cities in and around Maricopa County, as the state writes them. The address is "3302 N 47TH PL PHOENIX, AZ 85018": no comma
// before the city, so the city is found by matching the end of what is left after the state and ZIP.
const CITIES = [
  'APACHE JUNCTION',
  'AVONDALE',
  'BUCKEYE',
  'CAREFREE',
  'CAVE CREEK',
  'CHANDLER',
  'EL MIRAGE',
  'FOUNTAIN HILLS',
  'GILA BEND',
  'GILBERT',
  'GLENDALE',
  'GOODYEAR',
  'GUADALUPE',
  'LAVEEN',
  'LITCHFIELD PARK',
  'MESA',
  'PARADISE VALLEY',
  'PEORIA',
  'PHOENIX',
  'QUEEN CREEK',
  'SALT RIVER',
  'SCOTTSDALE',
  'SUN CITY',
  'SUN CITY WEST',
  'SURPRISE',
  'TEMPE',
  'TOLLESON',
  'WADDELL',
  'WICKENBURG',
  'YOUNGTOWN',
].sort((a, b) => b.length - a.length);

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());

export function splitAddress(address: string): { city: string; zip: string } {
  const m = /^(.*?)[\s,]+[A-Za-z]{2}\s+(\d{5})(?:-\d{4})?\s*$/.exec(address.trim());
  if (!m) return { city: '', zip: '' };
  const stem = (m[1] ?? '').replace(/,\s*$/, '').toUpperCase();
  const zip = m[2] ?? '';
  for (const city of CITIES) {
    if (stem === city || stem.endsWith(` ${city}`) || stem.endsWith(`,${city}`)) return { city: titleCase(city), zip };
  }
  return { city: '', zip };
}

// The status date as the sheet writes it (2026-10-21, 10/21/2026, 10/21/26, with or without a time) to YYYY-MM-DD, or null.
export function parseSheetDate(raw: string): string | null {
  const s = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else if (us) {
    mo = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
    if (y < 100) y += 2000;
  } else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

// Reads the sheet. Throws an ImportError, listing every problem, when a required column is missing or no row is usable.
export function readSheet(text: string): Sheet {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) throw new ImportError('The file is empty.');
  const columns = new Map<string, number>();
  header.forEach((name, i) => {
    const key = name.trim().toUpperCase();
    if (key !== '' && !columns.has(key)) columns.set(key, i);
  });
  const missing = REQUIRED.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new ImportError(`The first row is missing the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`, [
      `Columns found: ${[...columns.keys()].join(', ') || 'none'}`,
    ]);
  }
  const at = (row: string[], name: string): string => {
    const i = columns.get(name);
    return i === undefined ? '' : (row[i] ?? '').trim();
  };

  const people = new Map<string, IncomingPerson>();
  let skippedOtherDistrict = 0;
  let skippedInvalid = 0;
  let duplicates = 0;
  let badDates = 0;
  for (const row of table.slice(1)) {
    const legdist = at(row, 'LEGDIST');
    // A blank LEGDIST is taken as LD8: the file is the LD8 tab. Anything with a number other than 8 is not ours.
    if (legdist !== '' && Number.parseInt(legdist.replace(/\D/g, ''), 10) !== 8) {
      skippedOtherDistrict++;
      continue;
    }
    const firstName = at(row, 'FIRST');
    const lastName = at(row, 'LAST');
    const address = at(row, 'ADDRESS');
    if (firstName === '' || lastName === '' || address === '') {
      skippedInvalid++;
      continue;
    }
    const rawDate = at(row, 'STATUSDATE');
    const statusDate = parseSheetDate(rawDate);
    if (rawDate !== '' && statusDate === null) badDates++;
    const { city, zip } = splitAddress(address);
    const person: IncomingPerson = {
      key: normalizeKey(firstName, lastName, address),
      firstName,
      middleName: at(row, 'MID'),
      lastName,
      party: at(row, 'PARTY'),
      legdist,
      reasonCode: at(row, 'REASONCODE'),
      phone: at(row, 'PHONE'),
      address,
      city,
      zip,
      precinct: at(row, 'PRECINCT_NAME'),
      statusDate,
    };
    const seen = people.get(person.key);
    if (seen) {
      duplicates++;
      // The same person twice: keep the row with the later status date, with its blanks filled in from the other.
      const [later, earlier] = (person.statusDate ?? '') > (seen.statusDate ?? '') ? [person, seen] : [seen, person];
      people.set(person.key, {
        ...later,
        middleName: later.middleName || earlier.middleName,
        party: later.party || earlier.party,
        reasonCode: later.reasonCode || earlier.reasonCode,
        phone: later.phone || earlier.phone,
        precinct: later.precinct || earlier.precinct,
      });
    } else people.set(person.key, person);
  }

  const list = [...people.values()];
  if (list.length === 0) throw new ImportError('No usable rows: every row was another district or had no name or address.');
  const warnings: string[] = [];
  if (badDates > 0) warnings.push(`${badDates} status date${badDates > 1 ? 's' : ''} could not be read and were left blank.`);
  const noCity = list.filter((p) => p.city === '').length;
  if (noCity > 0) warnings.push(`${noCity} address${noCity > 1 ? 'es' : ''} had no city this tool recognizes, so the city is blank.`);
  if (!columns.has('STATUSDATE')) warnings.push('There is no STATUSDATE column, so days uncured will be blank.');
  return { people: list, rows: table.length - 1, skippedOtherDistrict, skippedInvalid, duplicates, warnings };
}

// A person as the database has them: what planUpload needs to tell a changed person from an unchanged one, so an upload writes only the first.
export interface ExistingPerson {
  id: number;
  key: string;
  firstName: string;
  middleName: string;
  lastName: string;
  party: string;
  legdist: string;
  reasonCode: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  precinct: string;
  statusDate: string | null;
  status: Status;
  statusChangedAt: string;
  flag: Flag | null;
  contactedCycles: number;
}

export interface PlannedUpdate {
  id: number;
  incoming: IncomingPerson;
  status: Status;
  flag: Flag | null;
  statusChangedAt: string;
  contactedCycles: number;
}

export interface PlannedAudit {
  personId: number;
  action: 'import.still_uncured' | 'import.reappeared';
  detail: Record<string, unknown>;
}

export interface Plan {
  inserts: IncomingPerson[];
  updates: PlannedUpdate[];
  // Ids of the people who are not on the sheet any more.
  cures: number[];
  audit: PlannedAudit[];
  stillUncured: number;
  reappeared: number;
  // People already known whose details and status the sheet leaves as they are: not rewritten.
  unchanged: number;
  openBefore: number;
  looksPartial: boolean;
  possibleMatches: PossibleMatch[];
}

// How many possible matches an upload preview lists; the preview also says how many there are in all.
export const MATCH_LIMIT = 25;

// What an upload does to the people already known. `graceCycles` is the admins' setting: how many uploads a person a volunteer marked
// contacted may stay on the list before it counts as an unsuccessful cure.
//  - on the sheet, new: added, needs contact.
//  - on the sheet, known: details refreshed. A cured person who is back is reopened and flagged (reappeared).
//  - on the sheet, marked contacted: each upload that still lists them is one cycle. Once they have had more than `graceCycles` of
//    them they are an unsuccessful cure: flagged (still_uncured), back to needs contact, with the same volunteer. The grace is for the
//    state's data being a day or two behind the phone calls.
//  - not on the sheet, not cured yet: cured. Assignment stays, so the volunteer keeps the credit.
export function planUpload(incoming: IncomingPerson[], existing: ExistingPerson[], now: string, graceCycles: number): Plan {
  const byKey = new Map(existing.map((p) => [p.key, p]));
  const onSheet = new Set(incoming.map((p) => p.key));
  const inserts: IncomingPerson[] = [];
  const updates: PlannedUpdate[] = [];
  const audit: PlannedAudit[] = [];
  let stillUncured = 0;
  let reappeared = 0;
  let unchanged = 0;
  for (const p of incoming) {
    const known = byKey.get(p.key);
    if (!known) {
      inserts.push(p);
      continue;
    }
    let { status, flag, statusChangedAt } = known;
    let contactedCycles = 0;
    if (known.status === 'cured') {
      status = 'needs_contact';
      flag = 'reappeared';
      statusChangedAt = now;
      reappeared++;
      audit.push({ personId: known.id, action: 'import.reappeared', detail: { was: 'cured' } });
    } else if (known.status === 'contacted') {
      contactedCycles = known.contactedCycles + 1;
      if (contactedCycles > graceCycles) {
        status = 'needs_contact';
        flag = 'still_uncured';
        statusChangedAt = now;
        contactedCycles = 0;
        stillUncured++;
        audit.push({
          personId: known.id,
          action: 'import.still_uncured',
          detail: { was: 'contacted', since: known.statusChangedAt, graceCycles },
        });
      }
    }
    // Everything a rewrite would set is what the row has already: leave it alone. Each rewritten row is one row written for the table and one
    // for every index, and a day's sheet is mostly the day before's.
    const same =
      status === known.status &&
      flag === known.flag &&
      statusChangedAt === known.statusChangedAt &&
      contactedCycles === known.contactedCycles &&
      p.firstName === known.firstName &&
      p.middleName === known.middleName &&
      p.lastName === known.lastName &&
      p.party === known.party &&
      p.legdist === known.legdist &&
      p.reasonCode === known.reasonCode &&
      p.phone === known.phone &&
      p.address === known.address &&
      p.city === known.city &&
      p.zip === known.zip &&
      p.precinct === known.precinct &&
      p.statusDate === known.statusDate;
    if (same) unchanged++;
    else updates.push({ id: known.id, incoming: p, status, flag, statusChangedAt, contactedCycles });
  }
  const gone = existing.filter((p) => !onSheet.has(p.key) && p.status !== 'cured');
  const openBefore = existing.filter((p) => p.status !== 'cured').length;

  // Someone who disappears while a similar person appears may be one person whose record was corrected, who would otherwise be
  // cured and re-added as a stranger (losing their notes and volunteer). Only reported; nothing is merged.
  const goneByAddress = new Map<string, ExistingPerson[]>();
  const goneByName = new Map<string, ExistingPerson[]>();
  for (const g of gone) {
    const a = `${clean(g.lastName)}|${clean(g.address)}`;
    const n = `${clean(g.firstName)}|${clean(g.lastName)}`;
    goneByAddress.set(a, [...(goneByAddress.get(a) ?? []), g]);
    goneByName.set(n, [...(goneByName.get(n) ?? []), g]);
  }
  const possibleMatches: PossibleMatch[] = [];
  for (const p of inserts) {
    const incomingName = `${p.firstName} ${p.lastName}`;
    for (const g of goneByAddress.get(`${clean(p.lastName)}|${clean(p.address)}`) ?? []) {
      possibleMatches.push({
        kind: 'address',
        existing: { id: g.id, name: `${g.firstName} ${g.lastName}`, address: g.address },
        incoming: { name: incomingName, address: p.address },
      });
    }
    for (const g of goneByName.get(`${clean(p.firstName)}|${clean(p.lastName)}`) ?? []) {
      possibleMatches.push({
        kind: 'moved',
        existing: { id: g.id, name: `${g.firstName} ${g.lastName}`, address: g.address },
        incoming: { name: incomingName, address: p.address },
      });
    }
  }
  return {
    inserts,
    updates,
    cures: gone.map((g) => g.id),
    audit,
    stillUncured,
    reappeared,
    unchanged,
    openBefore,
    // A file that would cure most of the open people is probably a partial export, not a good day.
    looksPartial: openBefore >= 10 && gone.length > openBefore / 2,
    possibleMatches,
  };
}
