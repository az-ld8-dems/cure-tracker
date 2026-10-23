// Synthetic copies of the state's sheet, for tests and the dev server. Every name, address and phone number is made up; real voter data
// never goes in this repo. The columns are the ones on the real sheet.
export const COLUMNS = ['FIRST', 'MID', 'LAST', 'STATUSDATE', 'PARTY', 'LEGDIST', 'REASONCODE', 'PHONE', 'ADDRESS', 'PRECINCT_NAME'];

export interface SheetPerson {
  first: string;
  mid?: string;
  last: string;
  statusDate?: string;
  party?: string;
  legdist?: string;
  reason?: string;
  phone?: string;
  address: string;
  precinct?: string;
}

const quote = (s: string): string => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function sheetCsv(people: SheetPerson[]): string {
  const lines = [COLUMNS.join(',')];
  for (const p of people) {
    lines.push(
      [
        p.first,
        p.mid ?? '',
        p.last,
        p.statusDate ?? '10/21/2026',
        p.party ?? 'DEM',
        p.legdist ?? '8',
        p.reason ?? 'SIGNATURE MISSING',
        p.phone ?? '',
        p.address,
        p.precinct ?? '',
      ]
        .map(quote)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

const FIRST = ['Alex', 'Beth', 'Carlos', 'Dana', 'Eli', 'Farah', 'Gus', 'Hana', 'Ivan', 'Jo', 'Kim', 'Luz', 'Moe', 'Nia', 'Omar', 'Pia'];
const LAST = [
  'Ames',
  'Baker',
  'Cruz',
  'Dunn',
  'Egan',
  'Fox',
  'Gil',
  'Hart',
  'Ito',
  'Jain',
  'Kerr',
  'Lund',
  'Mora',
  'Nash',
  'Ortiz',
  'Park',
];
const STREETS = [
  'N 47TH PL',
  'E MAIN ST',
  'W CAMELBACK RD',
  'S RURAL RD',
  'E APACHE BLVD',
  'N SCOTTSDALE RD',
  'W UNIVERSITY DR',
  'E BASELINE RD',
];
const PLACES = [
  { city: 'PHOENIX', zip: '85018', precinct: 'ARCADIA' },
  { city: 'TEMPE', zip: '85281', precinct: 'ASU WEST' },
  { city: 'SCOTTSDALE', zip: '85251', precinct: 'OLD TOWN' },
  { city: 'MESA', zip: '85201', precinct: 'DOBSON' },
  { city: 'PHOENIX', zip: '85016', precinct: 'BILTMORE' },
];

// n distinct made-up people, the same ones every time.
export function syntheticPeople(n: number): SheetPerson[] {
  const out: SheetPerson[] = [];
  for (let i = 0; i < n; i++) {
    const place = PLACES[i % PLACES.length];
    if (!place) throw new Error('no places');
    out.push({
      first: FIRST[i % FIRST.length] ?? 'Sam',
      last: `${LAST[Math.floor(i / FIRST.length) % LAST.length] ?? 'Smith'}${i >= FIRST.length * LAST.length ? i : ''}`,
      statusDate: `10/${String(1 + (i % 20)).padStart(2, '0')}/2026`,
      party: i % 7 === 0 ? 'IND' : i % 11 === 0 ? 'REP' : 'DEM',
      phone: i % 5 === 0 ? '' : `602-555-${String(100 + i).padStart(4, '0')}`,
      address: `${100 + i * 3} ${STREETS[i % STREETS.length] ?? ''} ${place.city}, AZ ${place.zip}`,
      precinct: place.precinct,
    });
  }
  return out;
}
