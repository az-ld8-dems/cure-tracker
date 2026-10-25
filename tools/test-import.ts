// Checks worker/import.ts: reading the state's sheet and planning an upload. Pure functions, no database.
import assert from 'node:assert/strict';
import {
  describeColumns,
  type ExistingPerson,
  ImportError,
  normalizeKey,
  parseCsv,
  parseSheetDate,
  planUpload,
  readSheet,
  resolveColumns,
  splitAddress,
} from '../worker/import.ts';
import { sheetCsv } from './lib/sheet.ts';

// --- CSV
assert.deepEqual(parseCsv('a,b\n1,2\n'), [
  ['a', 'b'],
  ['1', '2'],
]);
assert.deepEqual(
  parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'),
  [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
  ],
  'quotes, doubled quotes, CRLF',
);
assert.deepEqual(
  parseCsv('a,b\n"two\nlines",2'),
  [
    ['a', 'b'],
    ['two\nlines', '2'],
  ],
  'a newline inside quotes, no final newline',
);
assert.deepEqual(
  parseCsv('﻿a\tb\n1\t2\n\n'),
  [
    ['a', 'b'],
    ['1', '2'],
  ],
  'a BOM, tabs and a blank line',
);

// --- keys: case, punctuation, accents and the middle name do not matter
assert.equal(normalizeKey('Ana', 'Peña', '12 N 1st St., Tempe'), normalizeKey('ANA', 'PENA', '12 n 1st st tempe'));
assert.notEqual(normalizeKey('Ana', 'Pena', '12 N 1st St'), normalizeKey('Ana', 'Pena', '14 N 1st St'));

// --- addresses
assert.deepEqual(splitAddress('3302 N 47TH PL PHOENIX, AZ 85018'), { city: 'Phoenix', zip: '85018' });
assert.deepEqual(splitAddress('1 E MAIN ST APT 4 TEMPE, AZ 85281-1234'), { city: 'Tempe', zip: '85281' });
assert.deepEqual(splitAddress('5 N RD PARADISE VALLEY, AZ 85253'), { city: 'Paradise Valley', zip: '85253' });
assert.deepEqual(splitAddress('7 W RD SUN CITY WEST, AZ 85375'), { city: 'Sun City West', zip: '85375' }, 'the longest city wins');
assert.deepEqual(splitAddress('9 W ELM ST NOWHEREVILLE, AZ 85000'), { city: '', zip: '85000' }, 'an unknown city stays blank');
assert.deepEqual(splitAddress('no state or zip'), { city: '', zip: '' });

// --- dates
assert.equal(parseSheetDate('2026-10-21'), '2026-10-21');
assert.equal(parseSheetDate('10/21/2026'), '2026-10-21');
assert.equal(parseSheetDate('1/5/26 08:30'), '2026-01-05');
assert.equal(parseSheetDate('2026-10-21T14:00:00Z'), '2026-10-21');
assert.equal(parseSheetDate('13/40/2026'), null);
assert.equal(parseSheetDate(''), null);
assert.equal(parseSheetDate('soon'), null);

// --- reading a sheet
const sheet = readSheet(
  sheetCsv([
    { first: 'Ana', last: 'Lee', address: '3302 N 47TH PL PHOENIX, AZ 85018', precinct: 'ARCADIA', phone: '602-555-0101' },
    { first: 'Bo', last: 'Ray', address: '1 E MAIN ST TEMPE, AZ 85281', legdist: '9' },
    { first: 'Cy', last: 'Fox', address: '2 E MAIN ST TEMPE, AZ 85281', legdist: '08' },
    { first: 'Di', last: 'Roe', address: '3 E MAIN ST TEMPE, AZ 85281', legdist: '' },
    { first: '', last: 'Nobody', address: '4 E MAIN ST TEMPE, AZ 85281' },
    { first: 'Ana', last: 'LEE', address: '3302 n 47th pl phoenix az 85018', statusDate: '10/25/2026' },
  ]),
);
assert.equal(sheet.rows, 6);
assert.equal(sheet.skippedOtherDistrict, 1, 'LD9 is skipped, "08" and a blank count as LD8');
assert.equal(sheet.skippedInvalid, 1, 'no first name');
assert.equal(sheet.duplicates, 1);
assert.deepEqual(
  sheet.people.map((p) => p.firstName),
  ['Ana', 'Cy', 'Di'],
);
const ana = sheet.people[0];
assert.ok(ana);
assert.equal(ana.statusDate, '2026-10-25', 'a repeat keeps the later status date');
assert.equal(ana.city, 'Phoenix');
assert.equal(ana.precinct, 'ARCADIA');
assert.equal(ana.phone, '602-555-0101');

// The columns on the real sheets vary: only FIRST, LAST and ADDRESS are needed, in any order, in any case, with extra columns.
const odd = readSheet('Address,extra,last,first\n"1 E MAIN ST TEMPE, AZ 85281",x,Ray,Bo\n');
assert.equal(odd.people.length, 1);
assert.ok(odd.warnings.some((w) => /status date/.test(w)));

assert.throws(
  () => readSheet('FIRST,LAST\nA,B\n'),
  (e: unknown) => e instanceof ImportError && e.message.includes('ADDRESS'),
);
assert.throws(() => readSheet(''), ImportError);
assert.throws(() => readSheet('FIRST,LAST,ADDRESS,LEGDIST\nA,B,C,9\n'), ImportError, 'nothing usable');

// --- planning an upload
const incoming = (first: string, address = '1 E MAIN ST TEMPE, AZ 85281', last = 'Roe') =>
  readSheet(sheetCsv([{ first, last, address }])).people[0] ?? assert.fail('no person');
const known = (
  id: number,
  first: string,
  status: ExistingPerson['status'],
  changedAt: string,
  over: Partial<ExistingPerson> = {},
): ExistingPerson => {
  const p = incoming(first);
  return {
    id,
    key: p.key,
    firstName: first,
    middleName: p.middleName,
    lastName: 'Roe',
    party: p.party,
    legdist: p.legdist,
    reasonCode: p.reasonCode,
    phone: p.phone,
    address: p.address,
    city: p.city,
    zip: p.zip,
    precinct: p.precinct,
    statusDate: p.statusDate,
    status,
    statusChangedAt: changedAt,
    flag: null,
    contactedCycles: 0,
    ...over,
  };
};
const NOW = '2026-10-23T12:00:00.000Z';
const GRACE = 1;

{
  const existing = [
    known(1, 'Stays', 'needs_contact', '2026-10-01T00:00:00.000Z'),
    known(2, 'Gone', 'left_voicemail', '2026-10-01T00:00:00.000Z'),
    known(3, 'Done', 'cured', '2026-10-02T00:00:00.000Z'),
    known(4, 'Back', 'cured', '2026-10-02T00:00:00.000Z'),
    known(5, 'Retry', 'contacted', '2026-10-21T00:00:00.000Z', { contactedCycles: 1 }),
    known(6, 'Recent', 'contacted', '2026-10-22T18:00:00.000Z', { contactedCycles: 0 }),
  ];
  const plan = planUpload(
    [incoming('Stays'), incoming('Back'), incoming('Retry'), incoming('Recent'), incoming('Fresh')],
    existing,
    NOW,
    GRACE,
  );
  assert.deepEqual(
    plan.inserts.map((p) => p.firstName),
    ['Fresh'],
  );
  assert.deepEqual(plan.cures, [2], 'only the open person who left the sheet; the already cured one stays as is');
  const by = (id: number) => plan.updates.find((u) => u.id === id);
  assert.equal(by(1), undefined, 'a person the sheet leaves exactly as they are is not rewritten');
  assert.equal(plan.unchanged, 1);
  assert.deepEqual([by(4)?.status, by(4)?.flag], ['needs_contact', 'reappeared'], 'a cured person who is back is reopened and flagged');
  assert.deepEqual(
    [by(5)?.status, by(5)?.flag, by(5)?.contactedCycles],
    ['needs_contact', 'still_uncured', 0],
    'a second cycle past a grace of 1',
  );
  assert.deepEqual([by(6)?.status, by(6)?.flag, by(6)?.contactedCycles], ['contacted', null, 1], 'the first cycle is within the grace');
  assert.equal(plan.stillUncured, 1);
  assert.equal(plan.reappeared, 1);
  assert.equal(plan.openBefore, 4);
  assert.equal(plan.looksPartial, false);
  assert.deepEqual(plan.audit.map((a) => a.action).sort(), ['import.reappeared', 'import.still_uncured']);

  // Any detail the sheet changes makes it a rewrite; the contact status stays as it was.
  const changed = planUpload(
    [
      { ...incoming('Stays'), phone: '602-555-0199' },
      { ...incoming('Moved'), precinct: 'ELSEWHERE' },
    ],
    [known(1, 'Stays', 'needs_contact', '2026-10-01T00:00:00.000Z'), known(2, 'Moved', 'needs_contact', '2026-10-01T00:00:00.000Z')],
    NOW,
    GRACE,
  );
  assert.deepEqual(changed.updates.map((u) => u.id).sort(), [1, 2]);
  assert.equal(changed.unchanged, 0);
}

// The grace period is how many uploads a contacted person may stay on the list before it is an unsuccessful cure.
{
  const old = '2026-10-01T00:00:00.000Z';
  const run = (grace: number, contactedCycles: number) =>
    planUpload([incoming('A')], [known(1, 'A', 'contacted', old, { contactedCycles })], NOW, grace).updates[0] ?? assert.fail('no update');
  assert.deepEqual(
    [run(0, 0).status, run(0, 0).flag],
    ['needs_contact', 'still_uncured'],
    'no grace: the first upload that still lists them',
  );
  assert.deepEqual([run(2, 0).status, run(2, 0).contactedCycles], ['contacted', 1]);
  assert.deepEqual([run(2, 1).status, run(2, 1).contactedCycles], ['contacted', 2]);
  assert.deepEqual([run(2, 2).status, run(2, 2).flag], ['needs_contact', 'still_uncured'], 'a third upload past a grace of 2');
  // Only people marked contacted count: someone nobody has reached just stays on the list as long as they are listed.
  const waiting = planUpload([incoming('A')], [known(1, 'A', 'left_voicemail', old, { contactedCycles: 5 })], NOW, 0).updates[0];
  assert.deepEqual([waiting?.status, waiting?.flag, waiting?.contactedCycles], ['left_voicemail', null, 0]);
}

// A file that would cure most of the open people looks partial.
{
  const existing = Array.from({ length: 12 }, (_, i) => known(i + 1, `P${i}`, 'needs_contact', '2026-10-01T00:00:00.000Z'));
  assert.equal(planUpload([incoming('P0')], existing, NOW, GRACE).looksPartial, true);
  assert.equal(
    planUpload(
      existing.slice(0, 8).map((e) => incoming(e.firstName)),
      existing,
      NOW,
      GRACE,
    ).looksPartial,
    false,
  );
}

// A corrected record shows up as a possible match, and is not merged.
{
  const old = known(1, 'Jon', 'needs_contact', '2026-10-01T00:00:00.000Z');
  const same = planUpload([incoming('John')], [old], NOW, GRACE);
  assert.deepEqual(
    same.possibleMatches.map((m) => m.kind),
    ['address'],
  );
  const moved = planUpload([incoming('Jon', '99 W OAK ST MESA, AZ 85201')], [old], NOW, GRACE);
  assert.deepEqual(
    moved.possibleMatches.map((m) => m.kind),
    ['moved'],
  );
  assert.deepEqual(moved.cures, [1]);
}

// --- columns: matched by name wherever they are, with the admin's choice, then the saved one, then the name deciding
const shuffled = readSheet(
  'Precinct Name,LAST,Phone Number,first name,Address,Status Date\nNORTH,Ray,602-555-0100,Bo,1 E MAIN ST TEMPE AZ 85281,10/21/2026\n',
);
assert.equal(shuffled.people[0]?.firstName, 'Bo', 'a renamed column is found by its name');
assert.equal(shuffled.people[0]?.precinct, 'NORTH', 'case, spaces and underscores do not matter');
assert.equal(shuffled.people[0]?.phone, '602-555-0100');
assert.equal(shuffled.people[0]?.statusDate, '2026-10-21');
assert.ok(
  shuffled.warnings.some((w) => /party/.test(w)),
  'a missing optional column is said out loud',
);
assert.ok(!shuffled.warnings.some((w) => /middle/.test(w)), 'except the middle name');
assert.equal(shuffled.columns.ready, true);
assert.equal(shuffled.columns.choices.find((c) => c.field === 'precinct')?.header, 'Precinct Name');

const odder = 'NAME1,NAME2,STREET,AREA\nBo,Ray,1 E MAIN ST TEMPE AZ 85281,NORTH\n';
assert.throws(() => readSheet(odder), ImportError, 'unknown headers are not guessed');
const mapped = readSheet(odder, {}, { first: 'NAME1', last: 'NAME2', address: 'STREET', precinct: 'AREA' });
assert.deepEqual(
  [mapped.people[0]?.firstName, mapped.people[0]?.lastName, mapped.people[0]?.precinct],
  ['Bo', 'Ray', 'NORTH'],
  'an admin can match them',
);
const fromSaved = readSheet(odder, { first: 'name1', last: 'NAME2', address: 'STREET' });
assert.equal(fromSaved.people[0]?.firstName, 'Bo', 'a saved choice is used while the file has that header');
const savedGone = readSheet('FIRST,LAST,ADDRESS\nBo,Ray,1 E MAIN ST TEMPE AZ 85281\n', { first: 'NAME1' });
assert.equal(savedGone.people[0]?.firstName, 'Bo', 'a saved header the file lacks falls back to the name');
const picked = readSheet('FIRST,LAST,ADDRESS,PHONE\nBo,Ray,1 E MAIN ST TEMPE AZ 85281,602-555-0100\n', {}, { phone: null });
assert.equal(picked.people[0]?.phone, '', 'an admin can say a field has no column');
assert.throws(() => readSheet('FIRST,LAST,ADDRESS\nA,B,C\n', {}, { phone: 'NOPE' }), /no column named "NOPE"/);
assert.throws(() => readSheet('FIRST,LAST,ADDRESS\nA,B,C\n', {}, { last: 'FIRST' }), /used for both/, 'one column cannot feed two fields');
const missing = describeColumns('A,B\n1,2\n');
assert.equal(missing.ready, false);
assert.deepEqual(missing.headers, ['A', 'B']);
assert.deepEqual(missing.sample, ['1', '2'], 'the first row shows what is in each column');
assert.deepEqual(
  resolveColumns([
    ['x', 'X', '', 'y'],
    ['1', '2', '3', '4'],
  ]).map.headers,
  ['x', 'y'],
  'a repeated or blank header is listed once or not at all',
);

console.log('test-import: ok');
