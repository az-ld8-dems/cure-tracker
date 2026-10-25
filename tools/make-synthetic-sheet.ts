// Writes a made-up copy of the state's sheet, for trying the real site at a realistic size without any real voter. Every name, street and
// phone number is invented: the phone numbers are in the 555-0100 to 555-0199 range the phone companies reserve for fiction, so a volunteer
// who taps one will not ring a stranger. The streets and cities are real names with made-up house numbers, so an address may happen to be
// a real one; nobody lives there as this person.
//
//   node tools/make-synthetic-sheet.ts [--people 10000] [--seed 1] [--day2] [--out synthetic-sheet.csv]
//
// The same seed gives the same sheet. With --day2 it writes the next day's sheet from the same seed: some people gone (cured), some new,
// some changed (a phone, a precinct, a unit written another way, a ZIP corrected) and a few names corrected, to see possible matches. The
// output is a CSV, which is gitignored; it never goes in the repo.
import { writeFileSync } from 'node:fs';
import { type SheetPerson, sheetCsv } from './lib/sheet.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const total = Number(option('people', '10000'));
const seed = Number(option('seed', '1'));
const day2 = args.includes('--day2');
const out = option('out', day2 ? 'synthetic-sheet-day2.csv' : 'synthetic-sheet.csv');
if (!Number.isInteger(total) || total < 1 || total > 100_000) throw new Error('--people must be a whole number from 1 to 100000');

function random(start: number): () => number {
  let a = start;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(seed);
const int = (n: number): number => Math.floor(rnd() * n);
const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
const chance = (p: number): boolean => rnd() < p;

const FIRST = [
  'Aaliyah',
  'Aaron',
  'Abby',
  'Adam',
  'Adriana',
  'Alex',
  'Alicia',
  'Amir',
  'Ana',
  'Andre',
  'Angela',
  'Anita',
  'Anthony',
  'Ariel',
  'Asha',
  'Ben',
  'Beth',
  'Bianca',
  'Blake',
  'Brenda',
  'Brian',
  'Camila',
  'Carlos',
  'Carmen',
  'Casey',
  'Chen',
  'Chloe',
  'Chris',
  'Claire',
  'Cody',
  'Dana',
  'Daniel',
  'Darius',
  'David',
  'Deb',
  'Diego',
  'Dmitri',
  'Dominic',
  'Donna',
  'Drew',
  'Elena',
  'Eli',
  'Elias',
  'Emma',
  'Eric',
  'Esperanza',
  'Eva',
  'Farah',
  'Felix',
  'Fiona',
  'Frank',
  'Gabriel',
  'Gina',
  'Gus',
  'Hana',
  'Hector',
  'Helen',
  'Hugo',
  'Ian',
  'Imani',
  'Ingrid',
  'Irene',
  'Isaac',
  'Ivan',
  'Jada',
  'Jamal',
  'Jane',
  'Javier',
  'Jenna',
  'Jin',
  'Joan',
  'Jorge',
  'Josh',
  'Julia',
  'Kai',
  'Karen',
  'Keisha',
  'Ken',
  'Kim',
  'Lars',
  'Laura',
  'Leo',
  'Lena',
  'Lila',
  'Liam',
  'Lucia',
  'Luz',
  'Maddie',
  'Malik',
  'Marco',
  'Maria',
  'Mei',
  'Mia',
  'Miguel',
  'Mina',
  'Moe',
  'Nadia',
  'Nate',
  'Nia',
  'Noor',
  'Olga',
  'Omar',
  'Pablo',
  'Paige',
  'Pia',
  'Priya',
  'Quinn',
  'Rafael',
  'Raj',
  'Rosa',
  'Ruth',
  'Sam',
  'Sara',
  'Sofia',
  'Tariq',
  'Tess',
  'Theo',
  'Tom',
  'Uma',
  'Vera',
  'Vic',
  'Wes',
  'Xavier',
  'Yara',
  'Zoe',
] as const;
const LAST = [
  'Ames',
  'Baker',
  'Banks',
  'Bell',
  'Brandt',
  'Brooks',
  'Bui',
  'Cabrera',
  'Castillo',
  'Chavez',
  'Choi',
  'Clark',
  'Cohen',
  'Cruz',
  'Dale',
  'Davis',
  'Delgado',
  'Diaz',
  'Dunn',
  'Egan',
  'Ellis',
  'Estrada',
  'Farah',
  'Flores',
  'Fox',
  'Garza',
  'Gil',
  'Gomez',
  'Grant',
  'Gupta',
  'Hall',
  'Hart',
  'Hayes',
  'Herrera',
  'Hill',
  'Huang',
  'Ito',
  'Jain',
  'James',
  'Jensen',
  'Kane',
  'Kerr',
  'Khan',
  'Kim',
  'Klein',
  'Lam',
  'Lee',
  'Lopez',
  'Lund',
  'Mack',
  'Marsh',
  'Mejia',
  'Mora',
  'Nash',
  'Nguyen',
  'Nunez',
  'Okafor',
  'Ortiz',
  'Park',
  'Patel',
  'Perez',
  'Pham',
  'Quinn',
  'Ramos',
  'Reed',
  'Reyes',
  'Rios',
  'Rojas',
  'Ruiz',
  'Salazar',
  'Sandoval',
  'Shah',
  'Silva',
  'Singh',
  'Soto',
  'Stone',
  'Tran',
  'Vance',
  'Vega',
  'Wade',
  'Wells',
  'West',
  'Wong',
  'Yazzie',
  'Young',
  'Zhang',
  'Zimmer',
] as const;
const STREETS = [
  'CAMELBACK RD',
  'INDIAN SCHOOL RD',
  'THOMAS RD',
  'McDOWELL RD',
  'BASELINE RD',
  'UNIVERSITY DR',
  'APACHE BLVD',
  'RURAL RD',
  'MILL AVE',
  'SCOTTSDALE RD',
  'ROOSEVELT ST',
  'MAIN ST',
  'BROADWAY RD',
  'GUADALUPE RD',
  'ELLIOT RD',
  'WARNER RD',
  'DOBSON RD',
  'ALMA SCHOOL RD',
  'MCCLINTOCK DR',
  'PRIEST DR',
  'HAYDEN RD',
  'PIMA RD',
  'SHEA BLVD',
  'BELL RD',
  'GREENWAY RD',
  'ORANGEWOOD AVE',
  'GLENDALE AVE',
  'ARCADIA DR',
  'CHEROKEE ST',
  'SAGUARO LN',
  'MESQUITE CT',
  'PALO VERDE PL',
  'OCOTILLO WAY',
  'COTTONWOOD CIR',
  'DESERT VISTA TRL',
  'CHOLLA ST',
  'IRONWOOD DR',
  'JACARANDA LN',
  'SYCAMORE AVE',
  'WILLOW CREEK RD',
  '7TH ST',
  '16TH ST',
  '24TH ST',
  '32ND ST',
  '44TH ST',
  '48TH ST',
  '51ST AVE',
  '35TH AVE',
  '19TH AVE',
  '7TH AVE',
] as const;
const DIRECTIONS = ['N', 'S', 'E', 'W'] as const;
// City, with ZIPs that belong to it, and how often: the logo says Salt River, Scottsdale, Tempe, Phoenix, Mesa.
const CITIES = [
  {
    name: 'PHOENIX',
    weight: 40,
    zips: ['85008', '85014', '85016', '85018', '85020', '85028', '85032', '85034', '85040', '85044', '85048'],
  },
  { name: 'TEMPE', weight: 20, zips: ['85281', '85282', '85283', '85284', '85288'] },
  { name: 'SCOTTSDALE', weight: 20, zips: ['85250', '85251', '85254', '85257', '85258', '85260'] },
  { name: 'MESA', weight: 18, zips: ['85201', '85203', '85204', '85205', '85210', '85213'] },
  { name: 'CHANDLER', weight: 2, zips: ['85224', '85225', '85226'] },
] as const;
const PLACES = [
  'ARCADIA',
  'BILTMORE',
  'OLD TOWN',
  'ASU WEST',
  'DOBSON',
  'PAPAGO',
  'SOUTH MOUNTAIN',
  'ENCANTO',
  'ALHAMBRA',
  'CAMELBACK EAST',
  'MCCORMICK RANCH',
  'SHEA',
  'PARADISE VALLEY',
  'GAINEY',
  'LAKESHORE',
  'ROOSEVELT',
  'KIWANIS',
  'MARINA HEIGHTS',
  'DOWNTOWN',
  'EASTMARK',
  'FIESTA',
  'DESERT SKY',
  'PIERCE',
  'LINDSAY',
  'NORTHEAST MESA',
  'SAGUARO',
  'COOPER',
  'MORELAND',
  'WILLO',
  'GOLDEN GATE',
  'ZANJERO',
  'LA PRIVADA',
  'ARROWHEAD',
  'RIVERA',
  'PUEBLO',
  'SUNNYSLOPE',
  'MARICOPA',
  'CORONADO',
  'ENCANTO NORTH',
  'GOLFCREST',
] as const;
const PRECINCTS = PLACES.flatMap((p) => [`${p} 1`, `${p} 2`, `${p} 3`]);
const REASONS = ['SIGNATURE MISSING', 'SIGNATURE MISMATCH', 'NO ID', 'LATE', 'OTHER'] as const;
const PARTIES = ['DEM', 'DEM', 'DEM', 'DEM', 'DEM', 'DEM', 'IND', 'IND', 'REP', ''] as const;

const weighted = (): (typeof CITIES)[number] => {
  let n = int(CITIES.reduce((a, c) => a + c.weight, 0));
  for (const c of CITIES) {
    if (n < c.weight) return c;
    n -= c.weight;
  }
  return CITIES[0];
};

// Phone numbers in the range reserved for fiction (555-0100 to 555-0199), in the ways a sheet writes them.
const phone = (): string => {
  const line = `01${String(int(100)).padStart(2, '0')}`;
  const area = pick(['602', '480', '623']);
  return pick([`${area}-555-${line}`, `(${area}) 555-${line}`, `${area}.555.${line}`]);
};

const date = (): string => (chance(0.02) ? '' : `10/${String(1 + int(25)).padStart(2, '0')}/2026`);

function person(): SheetPerson {
  const city = weighted();
  const unit = chance(0.12) ? ` APT ${1 + int(400)}` : '';
  return {
    first: pick(FIRST),
    ...(chance(0.3) ? { mid: String.fromCharCode(65 + int(26)) } : {}),
    last: pick(LAST),
    statusDate: date(),
    party: pick(PARTIES),
    // A few rows say nothing: the importer takes that as LD8. (Other districts are added separately, below.)
    legdist: chance(0.005) ? '' : '8',
    reason: pick(REASONS),
    phone: chance(0.4) ? phone() : '',
    address: `${100 + int(19900)} ${pick(DIRECTIONS)} ${pick(STREETS)}${unit} ${city.name}, AZ ${pick(city.zips)}`,
    precinct: pick(PRECINCTS),
  };
}

// Distinct people: the same first name, last name and address twice would be one person.
const identity = (p: SheetPerson): string => `${p.first}|${p.last}|${p.address}`.toUpperCase();
const seen = new Set<string>();
let people: SheetPerson[] = [];
while (people.length < total) {
  const p = person();
  if (seen.has(identity(p))) continue;
  seen.add(identity(p));
  people.push(p);
}

// The same address as another dump might write it: APT 12 as 12, or the street type spelled out.
const SPELLED: Record<string, string> = {
  ST: 'STREET',
  RD: 'ROAD',
  DR: 'DRIVE',
  AVE: 'AVENUE',
  BLVD: 'BOULEVARD',
  LN: 'LANE',
  CT: 'COURT',
  PL: 'PLACE',
  WAY: 'WAY',
  CIR: 'CIRCLE',
  TRL: 'TRAIL',
};
const respell = (address: string): string =>
  / APT \d+/.test(address)
    ? address.replace(' APT ', ' ')
    : address.replace(/ (ST|RD|DR|AVE|BLVD|LN|CT|PL|CIR|TRL) /, (_m, t: string) => ` ${SPELLED[t] ?? t} `);

if (day2) {
  const next: SheetPerson[] = [];
  const keep = (p: SheetPerson): SheetPerson => ({ ...p });
  for (const p of people) {
    const roll = rnd();
    if (roll < 0.03) continue; // gone from the sheet: cured
    if (roll < 0.06)
      next.push({ ...keep(p), phone: phone() }); // a phone number added or changed
    else if (roll < 0.08) next.push({ ...keep(p), precinct: pick(PRECINCTS) });
    else if (roll < 0.11)
      next.push({ ...keep(p), address: respell(p.address) }); // the same address written another way
    else if (roll < 0.12)
      next.push({ ...keep(p), address: p.address.replace(/AZ (\d{5})/, 'AZ $1-1234') }); // ZIP+4
    else if (roll < 0.1225)
      next.push({ ...keep(p), last: `${p.last}z` }); // a corrected last name: a possible match
    else next.push(keep(p));
  }
  // New people, about two in a hundred.
  for (let n = Math.round(total * 0.02); n > 0; ) {
    const p = person();
    if (seen.has(identity(p))) continue;
    seen.add(identity(p));
    next.push(p);
    n--;
  }
  people = next;
}

// Some rows belong to another district, which the importer leaves out: they come on top of the people, so --people is how many people
// the site ends up with.
const distinct = people.length;
const elsewhere = Math.round(total * 0.015);
for (let n = 0; n < elsewhere; n++) people.push({ ...person(), legdist: pick(['9', '10', '12']) });

// A few rows repeated with another status date: the importer keeps the later one.
const repeats = Math.round(total * 0.003);
for (let n = 0; n < repeats; n++) {
  const p = pick(people);
  people.push({ ...p, statusDate: `10/${String(1 + int(25)).padStart(2, '0')}/2026` });
}

// The sheet comes in no particular order.
for (let i = people.length - 1; i > 0; i--) {
  const j = int(i + 1);
  [people[i], people[j]] = [people[j] as SheetPerson, people[i] as SheetPerson];
}

writeFileSync(out, sheetCsv(people));
console.log(
  `${out}: ${people.length} rows: ${distinct} people${day2 ? ' as of the next day' : ''}, ${elsewhere} rows for other districts, ${repeats} rows repeated; seed ${seed}`,
);
