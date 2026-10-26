// Reads the state's sheet (the LD8 tab exported as CSV): the columns, the people in it and what is wrong with it. The admin's browser
// runs this, so the Worker never pays for parsing a large file (a free Worker has about 10 ms of CPU a request); Node runs it for the
// tests and the dev server. Free of browser and Worker globals. Only erasable TypeScript syntax.
import type { ColumnChoice, ColumnField, ColumnMap, ColumnPick } from './api.d.ts';

export class ImportError extends Error {
  problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.problems = problems;
  }
}

// The columns the importer reads, and what the state has called them. A header matches by name when, ignoring case and anything that is
// not a letter or digit, it is one of `names` ("Precinct Name" and PRECINCT_NAME are the same). First, last and address identify a
// person, so they must be there; the rest are optional because the columns on the real sheets vary.
interface FieldSpec {
  key: ColumnField;
  label: string;
  required: boolean;
  names: string[];
}

export const FIELDS: FieldSpec[] = [
  { key: 'first', label: 'First name', required: true, names: ['FIRST', 'FIRSTNAME'] },
  { key: 'middle', label: 'Middle name', required: false, names: ['MID', 'MIDDLE', 'MIDDLENAME', 'MI'] },
  { key: 'last', label: 'Last name', required: true, names: ['LAST', 'LASTNAME'] },
  { key: 'address', label: 'Address', required: true, names: ['ADDRESS', 'RESIDENCEADDRESS'] },
  { key: 'statusDate', label: 'Status date', required: false, names: ['STATUSDATE'] },
  { key: 'party', label: 'Party', required: false, names: ['PARTY'] },
  { key: 'legdist', label: 'Legislative district', required: false, names: ['LEGDIST', 'LD', 'LEGISLATIVEDISTRICT'] },
  { key: 'reasonCode', label: 'Reason', required: false, names: ['REASONCODE', 'REASON'] },
  { key: 'phone', label: 'Phone', required: false, names: ['PHONE', 'PHONENUMBER'] },
  { key: 'precinct', label: 'Precinct', required: false, names: ['PRECINCTNAME', 'PRECINCT'] },
];

const letters = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
// A header is looked up as written, ignoring case and the spaces around it; with the same header twice, the first one wins.
const sameHeader = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

export interface Columns {
  // The index in each row of the column used for each field; -1 when there is none.
  index: Record<ColumnField, number>;
  map: ColumnMap;
}

// Decides which column of the file feeds each field. `picked` (what an admin chose for this file) wins, then `saved` (what the last
// upload used) when the file still has that header, then the name. A header the file does not have is an ImportError.
export function resolveColumns(table: string[][], saved: ColumnPick = {}, picked: ColumnPick = {}): Columns {
  const header = (table[0] ?? []).map((name) => name.trim());
  const find = (name: string): number => header.findIndex((h) => h !== '' && sameHeader(h, name));
  const index = {} as Record<ColumnField, number>;
  for (const spec of FIELDS) {
    let i = -1;
    if (Object.hasOwn(picked, spec.key)) {
      const want = picked[spec.key];
      if (want) {
        i = find(want);
        if (i < 0) throw new ImportError(`This file has no column named "${want}".`);
      }
    } else {
      const was = saved[spec.key];
      if (was) i = find(was);
      if (i < 0) i = header.findIndex((h) => h !== '' && spec.names.includes(letters(h)));
    }
    index[spec.key] = i;
  }
  const used = new Map<number, string>();
  for (const spec of FIELDS) {
    const i = index[spec.key];
    const other = used.get(i);
    if (i >= 0 && other !== undefined) throw new ImportError(`The column "${header[i]}" is used for both ${other} and ${spec.label}.`);
    if (i >= 0) used.set(i, spec.label);
  }
  const first = table[1] ?? [];
  const headers: string[] = [];
  const sample: string[] = [];
  header.forEach((h, i) => {
    if (h === '' || headers.some((x) => sameHeader(x, h))) return;
    headers.push(h);
    sample.push((first[i] ?? '').trim());
  });
  const choices: ColumnChoice[] = FIELDS.map((spec) => ({
    field: spec.key,
    label: spec.label,
    required: spec.required,
    header: index[spec.key] >= 0 ? (header[index[spec.key] ?? -1] ?? null) : null,
  }));
  return { index, map: { headers, sample, choices, ready: choices.every((c) => !c.required || c.header !== null) } };
}

// The columns of a file and how they would be matched, without reading the rows.
export function describeColumns(text: string, saved: ColumnPick = {}, picked: ColumnPick = {}): ColumnMap {
  const table = parseCsv(text);
  if (table.length === 0) throw new ImportError('The file is empty.');
  return resolveColumns(table, saved, picked).map;
}

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
  columns: ColumnMap;
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

// Spaces and punctuation reduced to single spaces, upper case, without accents.
export const clean = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// Bump when the keys below would come out differently for the same sheet: every person already in the database has a key made the old
// way, so the next upload would see them all as new. The upload page warns while the stored version differs (worker/uploads.ts).
export const KEY_VERSION = 2;

// A name with nothing but its letters and digits: O'Brien, O Brien and OBRIEN are one name, and so are De La Cruz and DeLaCruz.
export function nameKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// How the state and the post office write the same street: STREET and ST, NORTH and N. After USPS Publication 28's standard forms.
const WORDS = new Map(
  Object.entries({
    NORTH: 'N',
    SOUTH: 'S',
    EAST: 'E',
    WEST: 'W',
    NORTHEAST: 'NE',
    NORTHWEST: 'NW',
    SOUTHEAST: 'SE',
    SOUTHWEST: 'SW',
    ALLEY: 'ALY',
    AVENUE: 'AVE',
    AV: 'AVE',
    BOULEVARD: 'BLVD',
    CANYON: 'CYN',
    CENTER: 'CTR',
    CIRCLE: 'CIR',
    CIRC: 'CIR',
    COURT: 'CT',
    CRT: 'CT',
    CREEK: 'CRK',
    CROSSING: 'XING',
    DRIVE: 'DR',
    DRV: 'DR',
    EXPRESSWAY: 'EXPY',
    FREEWAY: 'FWY',
    GARDEN: 'GDN',
    GARDENS: 'GDNS',
    GLEN: 'GLN',
    GROVE: 'GRV',
    HEIGHTS: 'HTS',
    HIGHWAY: 'HWY',
    JUNCTION: 'JCT',
    LANE: 'LN',
    MEADOWS: 'MDWS',
    MOUNTAIN: 'MTN',
    PARKWAY: 'PKWY',
    PKY: 'PKWY',
    PLACE: 'PL',
    PLAZA: 'PLZ',
    POINT: 'PT',
    RIDGE: 'RDG',
    ROAD: 'RD',
    SPRINGS: 'SPGS',
    SQUARE: 'SQ',
    STREET: 'ST',
    TERRACE: 'TER',
    TERR: 'TER',
    TRAIL: 'TRL',
    VALLEY: 'VLY',
    VIEW: 'VW',
    VILLAGE: 'VLG',
    VISTA: 'VIS',
    SAINT: 'ST',
  }),
);

// What introduces an apartment, unit or suite number. The number stays: `APT 2129`, `UNIT 2129`, `# 2129` and `2129` are one address.
const UNIT_WORDS = new Set([
  'APT',
  'APARTMENT',
  'UNIT',
  'STE',
  'SUITE',
  'BLDG',
  'BUILDING',
  'FL',
  'FLOOR',
  'RM',
  'ROOM',
  'LOT',
  'SPC',
  'SPACE',
  'TRLR',
]);

// The address as a key: the street line only, so a ZIP+4, a corrected ZIP or city, or a state does not make a new person, with the
// words the state spells differently from one dump to the next made the same (STREET and ST, APT 2 and 2, PO Box and P.O. BOX). The
// address stored and shown is still the one the sheet had.
export function addressKey(address: string): string {
  let s = clean(address).replace(/\bP O BOX\b|\bPOST OFFICE BOX\b|\bPOBOX\b/g, 'PO BOX');
  // State and ZIP (with or without the +4) at the end.
  const noState = s.replace(/ (AZ|ARIZONA)( \d{5}( \d{4})?)?$/, '');
  if (noState !== s) s = noState;
  // A city at the end, with the street line before it (a ZIP written without a state is dropped first when a city precedes it).
  const noZip = s.replace(/ \d{5}( \d{4})?$/, '');
  for (const stem of [noZip, s]) {
    const city = CITIES.find((c) => stem.endsWith(` ${c}`) && stem.slice(0, -c.length - 1).includes(' '));
    if (city) {
      s = stem.slice(0, -city.length - 1);
      break;
    }
  }
  const tokens = s.split(' ').filter((w, i) => i === 0 || !UNIT_WORDS.has(w));
  return tokens.map((w, i) => (i === 0 ? w : (WORDS.get(w) ?? w))).join(' ');
}

// The sheet has no stable id, so a person is their normalized first name, last name and address (nameKey, addressKey). Middle names,
// punctuation, case and spacing do not count.
export function normalizeKey(first: string, last: string, address: string): string {
  return `${nameKey(first)}|${nameKey(last)}|${addressKey(address)}`;
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

// The street line of an address as the sheet writes it: "3302 N 47TH PL PHOENIX, AZ 85018" is "3302 N 47TH PL" when the city is Phoenix.
// What a geocoder wants in its street field. A unit stays in it.
export function streetLine(address: string, city: string): string {
  const m = /^(.*?)[\s,]+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$/.exec(address.trim());
  let stem = (m?.[1] ?? address).replace(/,\s*$/, '').trim();
  if (city !== '') stem = stem.replace(new RegExp(`[\\s,]+${city.trim().replace(/\s+/g, '\\s+')}$`, 'i'), '');
  return stem.trim();
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

// Reads the sheet. Throws an ImportError, listing every problem, when a required column is missing or no row is usable. `saved` and
// `picked` say which column feeds which field (see resolveColumns).
export function readSheet(text: string, saved: ColumnPick = {}, picked: ColumnPick = {}): Sheet {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) throw new ImportError('The file is empty.');
  const { index, map: columns } = resolveColumns(table, saved, picked);
  const missing = FIELDS.filter((f) => f.required && index[f.key] < 0);
  if (missing.length > 0) {
    throw new ImportError(
      `The first row is missing the column${missing.length > 1 ? 's' : ''} ${missing.map((f) => f.names[0]).join(', ')}.`,
      [`Columns found: ${columns.headers.join(', ') || 'none'}`, 'If the state renamed a column, choose it in the column list.'],
    );
  }
  const at = (row: string[], field: ColumnField): string => {
    const i = index[field];
    return i < 0 ? '' : (row[i] ?? '').trim();
  };

  const people = new Map<string, IncomingPerson>();
  let skippedOtherDistrict = 0;
  let skippedInvalid = 0;
  let duplicates = 0;
  let badDates = 0;
  for (const row of table.slice(1)) {
    const legdist = at(row, 'legdist');
    // A blank LEGDIST is taken as LD8: the file is the LD8 tab. Anything with a number other than 8 is not ours.
    if (legdist !== '' && Number.parseInt(legdist.replace(/\D/g, ''), 10) !== 8) {
      skippedOtherDistrict++;
      continue;
    }
    const firstName = at(row, 'first');
    const lastName = at(row, 'last');
    const address = at(row, 'address');
    if (firstName === '' || lastName === '' || address === '') {
      skippedInvalid++;
      continue;
    }
    const rawDate = at(row, 'statusDate');
    const statusDate = parseSheetDate(rawDate);
    if (rawDate !== '' && statusDate === null) badDates++;
    const { city, zip } = splitAddress(address);
    const person: IncomingPerson = {
      key: normalizeKey(firstName, lastName, address),
      firstName,
      middleName: at(row, 'middle'),
      lastName,
      party: at(row, 'party'),
      legdist,
      reasonCode: at(row, 'reasonCode'),
      phone: at(row, 'phone'),
      address,
      city,
      zip,
      precinct: at(row, 'precinct'),
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
  // Say what is blank because the file has no such column. The middle name is not worth a warning.
  const blank: Partial<Record<ColumnField, string>> = {
    statusDate: 'days uncured will be blank',
    legdist: 'every row is taken as LD8',
    party: 'party will be blank',
    reasonCode: 'the reason will be blank',
    phone: 'phone numbers will be blank',
    precinct: 'precincts will be blank',
  };
  for (const c of columns.choices) {
    const effect = blank[c.field];
    if (c.header === null && effect !== undefined) warnings.push(`No column is matched to ${c.label.toLowerCase()}, so ${effect}.`);
  }
  return { people: list, rows: table.length - 1, skippedOtherDistrict, skippedInvalid, duplicates, warnings, columns };
}

// A person as the database has them: what planUpload needs to tell a changed person from an unchanged one, so an upload writes only the first.
