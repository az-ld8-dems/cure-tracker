// The reference for what an upload does to the people already known, written as plain functions over arrays. Production does the same in
// SQL (worker/uploads.ts), so it never loads everyone into the Worker; tools/test-upload-sql.ts runs both on the same random data and
// requires the same answer. Only tests import this file. Only erasable TypeScript syntax.
import type { Flag, PossibleMatch, Status } from '../../src/api.d.ts';
import { addressKey, type IncomingPerson, nameKey } from '../../src/sheet.ts';

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
  const goneByFirstAddress = new Map<string, ExistingPerson[]>();
  for (const g of gone) {
    const a = `${nameKey(g.lastName)}|${addressKey(g.address)}`;
    const n = `${nameKey(g.firstName)}|${nameKey(g.lastName)}`;
    const f = `${nameKey(g.firstName)}|${addressKey(g.address)}`;
    goneByAddress.set(a, [...(goneByAddress.get(a) ?? []), g]);
    goneByName.set(n, [...(goneByName.get(n) ?? []), g]);
    goneByFirstAddress.set(f, [...(goneByFirstAddress.get(f) ?? []), g]);
  }
  const possibleMatches: PossibleMatch[] = [];
  for (const p of inserts) {
    const incomingName = `${p.firstName} ${p.lastName}`;
    for (const g of goneByAddress.get(`${nameKey(p.lastName)}|${addressKey(p.address)}`) ?? []) {
      possibleMatches.push({
        kind: 'address',
        existing: { id: g.id, name: `${g.firstName} ${g.lastName}`, address: g.address },
        incoming: { key: p.key, name: incomingName, address: p.address },
        merged: false,
      });
    }
    for (const g of goneByFirstAddress.get(`${nameKey(p.firstName)}|${addressKey(p.address)}`) ?? []) {
      possibleMatches.push({
        kind: 'surname',
        existing: { id: g.id, name: `${g.firstName} ${g.lastName}`, address: g.address },
        incoming: { key: p.key, name: incomingName, address: p.address },
        merged: false,
      });
    }
    for (const g of goneByName.get(`${nameKey(p.firstName)}|${nameKey(p.lastName)}`) ?? []) {
      possibleMatches.push({
        kind: 'moved',
        existing: { id: g.id, name: `${g.firstName} ${g.lastName}`, address: g.address },
        incoming: { key: p.key, name: incomingName, address: p.address },
        merged: false,
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
