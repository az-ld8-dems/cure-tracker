// Checks how the pages write things in words: names and addresses (src/common.ts) and audit log rows (src/audit-text.ts).
import assert from 'node:assert/strict';
import type { AuditEntry } from '../src/api.d.ts';
import { describeAudit } from '../src/audit-text.ts';
import { addressText, personName, titleCase } from '../src/common.ts';

assert.equal(titleCase("O'BRIEN-SMITH"), "O'Brien-Smith");
assert.equal(personName({ firstName: 'ANA', lastName: 'PEÑA' }), 'Ana Peña');

// Addresses keep directions, PO and the state as capitals, and ordinals lowercase.
assert.equal(addressText('3302 N 47TH PL PHOENIX, AZ 85018'), '3302 N 47th Pl Phoenix, AZ 85018');
assert.equal(addressText('12 NE 3RD AVE APT 4 TEMPE, AZ 85281'), '12 NE 3rd Ave Apt 4 Tempe, AZ 85281');
assert.equal(addressText('PO BOX 77 MESA, AZ 85201'), 'PO Box 77 Mesa, AZ 85201');
assert.equal(addressText('9 SW ELM ST SUN CITY WEST, AZ 85375'), '9 SW Elm St Sun City West, AZ 85375');

const volunteers = new Map([[1, 'Vera Vale']]);
const who = (id: number | null) => (id === null ? 'the pool' : (volunteers.get(id) ?? 'Someone'));
const say = (action: string, detail: Record<string, unknown> = {}) =>
  describeAudit({ id: 1, at: '', actor: 'a@example.com', action, personId: null, personName: null, detail } satisfies AuditEntry, who);

assert.equal(say('claim'), 'claimed');
assert.equal(say('release', { from: 1 }), 'released back to the pool');
assert.equal(say('status', { from: 'needs_contact', to: 'left_voicemail' }), 'marked left a message (was needs to be contacted)');
assert.equal(say('note'), 'added a note');
assert.equal(say('assign', { from: null, to: 1 }), 'moved from the pool to Vera Vale');
assert.equal(say('reassign', { from: 1, to: null, count: 1 }), 'moved 1 person from Vera Vale to the pool');
assert.equal(say('reassign', { from: 1, to: null, count: 6 }), 'moved 6 people from Vera Vale to the pool');
assert.equal(
  say('organizer.set', { volunteer: 1, from: { all: false, precincts: [] }, to: { all: false, precincts: ['101', '102'] } }),
  'changed what Vera Vale organizes: precincts 101, 102 (was nothing)',
);
assert.equal(
  say('organizer.set', { volunteer: 1, from: { all: true, precincts: [] }, to: { all: false, precincts: [] } }),
  'changed what Vera Vale organizes: nothing (was all precincts)',
);
assert.equal(say('flag.dismiss'), 'dismissed the flag');
assert.equal(say('import.cured'), 'cured: no longer on the state’s sheet');
assert.equal(say('import.still_uncured'), 'unsuccessful cure: still on the sheet after contact');
assert.equal(
  say('import.merged', { was: { name: 'Bo Roe', address: '1 E Main St' }, now: { name: 'Bo Rowe', address: '1 E Main St' } }),
  'marked as the same person as Bo Rowe, 1 E Main St on the state’s sheet (was Bo Roe, 1 E Main St)',
);
assert.equal(say('import.reappeared'), 'back on the sheet after being cured');
assert.equal(
  say('upload', { filename: 'day2.csv', added: 1, cured: 3, stillUncured: 1, reappeared: 0 }),
  'uploaded day2.csv: 1 added, 3 cured, 1 unsuccessful cure, 0 back after being cured',
);
assert.equal(say('settings', { graceCycles: { from: 1, to: 2 } }), 'set the grace period to 2 uploads (was 1)');
assert.equal(say('settings', { graceCycles: { from: 2, to: 1 } }), 'set the grace period to 1 upload (was 2)');
assert.equal(say('reset', { people: 40, notes: 1, uploads: 2 }), 'deleted all voters (40 people, 1 note, 2 uploads)');
assert.equal(say('volunteer.join'), 'signed in for the first time');
assert.equal(say('invite.send', { email: 'a@example.com' }), 'emailed sign-in instructions to a@example.com');
assert.equal(say('volunteer.rename', { from: '', to: 'Vera Vale' }), 'now called Vera Vale');
assert.equal(say('something.new'), 'something new', 'an action nobody wrote words for is still readable');

console.log('test-format: ok');
