// The shapes the JSON API sends and receives, shared by the Worker (worker/api.ts) and the pages (src/*.ts). Types only: the file is
// erased on both sides.

export type Status = 'needs_contact' | 'left_voicemail' | 'contacted' | 'cured';
// still_uncured (an unsuccessful cure): marked contacted, yet still on the sheet after the admins' grace period. reappeared: was cured, but is on a later upload again.
export type Flag = 'still_uncured' | 'reappeared';
export type ContactMethod =
  | 'call'
  | 'text'
  | 'call_and_text'
  | 'voicemail_and_text'
  | 'email'
  | 'in_person'
  | 'in_person_cured'
  | 'in_person_other'
  | 'in_person_door'
  | 'other';

export interface Me {
  id: number;
  email: string;
  // Empty until the volunteer has said what to call them.
  name: string;
  isAdmin: boolean;
  // The precincts the volunteer may organize (move people between volunteers in): all of them for a site admin, null for a plain volunteer.
  // A scope with `all` includes people whose sheet row has no precinct.
  organizes: { all: boolean; precincts: string[] } | null;
  // The place the volunteer saved for "near me", rounded to about a mile; only they ever see it. null until they save one.
  // `near` says where that is in words (the town and ZIP of the nearest person waiting), when anyone is within 25 miles.
  location: { lat: number; lon: number; near: string | null } | null;
}

export interface Volunteer {
  id: number;
  email: string;
  name: string;
}

export interface Person {
  id: number;
  firstName: string;
  middleName: string;
  lastName: string;
  party: string;
  reasonCode: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  precinct: string;
  // The status date from the state's sheet (YYYY-MM-DD), and the days from it to today in Arizona; null when the sheet had none or the person is cured.
  statusDate: string | null;
  daysUncured: number | null;
  status: Status;
  statusChangedAt: string;
  contactMethod: ContactMethod | null;
  assignedTo: number | null;
  flag: Flag | null;
  notesCount: number;
  // Only in a "within N miles" search: how far, and whether that is a guess (the person has the middle of their ZIP, not their own place).
  distanceMiles?: number;
  approximate?: boolean;
}

// One page of GET /api/people. `hasMore` says there are people after this page (the page asks for one more than it shows, which is cheaper
// than counting). `facets` (the pool scope, when asked for with facets=1) lists the values the filters offer.
export interface PeoplePage {
  people: Person[];
  hasMore: boolean;
  facets?: { cities: string[]; parties: string[]; precincts: string[]; precinctsByCity: Record<string, string[]> };
}

export interface Note {
  id: number;
  body: string;
  createdAt: string;
  volunteerId: number;
  volunteerName: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  personId: number | null;
  personName: string | null;
  detail: Record<string, unknown>;
}

export interface PersonDetail {
  person: Person;
  // The volunteer who has them (null in the pool), and when that volunteer last claimed them, changed their status, wrote a note or had them moved.
  claimedBy: Volunteer | null;
  lastActivityAt: string | null;
  notes: Note[];
  history: AuditEntry[];
}

export interface VolunteerStats extends Volunteer {
  lastSeenAt: string;
  // Everyone assigned to them who is not cured yet, then the same people split by status, plus how many of their people are cured.
  assigned: number;
  needsContact: number;
  leftVoicemail: number;
  contacted: number;
  cured: number;
  flagged: number;
}

export interface UploadRecord {
  id: number;
  uploadedBy: string;
  filename: string;
  createdAt: string;
  rows: number;
  added: number;
  cured: number;
  stillUncured: number;
  reappeared: number;
}

export interface AdminSettings {
  // How many uploads a person a volunteer marked contacted may stay on the list before it counts as an unsuccessful cure.
  graceCycles: number;
  // Whether the reset (delete every voter) is turned on in this deployment.
  resetEnabled: boolean;
}

export interface AdminStats {
  totals: {
    needsContact: number;
    leftVoicemail: number;
    contacted: number;
    cured: number;
    // Open people nobody has claimed.
    unassigned: number;
    flagged: number;
  };
  volunteers: VolunteerStats[];
  flagged: Person[];
  lastUpload: UploadRecord | null;
  // Where people live: open people not looked up yet, people placed on the map, and people the geocoder could not place. `sample` is
  // what a request to the geocoder looks like for the next few people waiting: an id and an address, nothing else.
  // `matched` are placed exactly; `approximate` are placed roughly (a match the Census calls non-exact, or the middle of their ZIP);
  // `noPlace` have no place at all; `byHand` an admin placed (they count as placed exactly); `unmatched` are the people the geocoder could not
  // place (no match or a tie), whatever they have for now.
  geocode: {
    waiting: number;
    matched: number;
    approximate: number;
    noPlace: number;
    byHand: number;
    unmatched: number;
    sample: string[];
  };
}

// What one geocoding request did. `next` is where to go on from (the id to pass as `after`), null when no one is left.
export interface GeocodeProgress {
  sent: number;
  matched: number;
  noMatch: number;
  unanswered: number;
  // People the geocoder could not place who were put at the middle of their ZIP when the run ended.
  approximated: number;
  next: number | null;
}

// A person the geocoder could not place, for an admin to look up by hand.
export interface UnplacedPerson {
  id: number;
  name: string;
  address: string;
  reason: 'no_match' | 'tie';
  approximate: boolean;
  // Set when an admin placed this person by hand: where, so it can be corrected or taken away.
  byHand: { lat: number; lon: number } | null;
}

export interface UnplacedPage {
  people: UnplacedPerson[];
  next: number | null;
}

export interface PossibleMatch {
  // address: the same last name at the same address with another first name. surname: the same first name at the same address with
  // another last name. moved: the same name at another address.
  kind: 'address' | 'surname' | 'moved';
  existing: { id: number; name: string; address: string };
  // `key` names the person on the sheet when asking for a merge.
  incoming: { key: string; name: string; address: string };
  // Whether the admin has marked them as the same person: the upload then updates the existing record instead of curing it and adding
  // the new one.
  merged: boolean;
}

export interface MergePair {
  id: number;
  key: string;
}

// The columns of the state's sheet that the importer reads. `header` is the column of the file used for the field, or null when the file
// has none.
export type ColumnField =
  | 'first'
  | 'middle'
  | 'last'
  | 'address'
  | 'statusDate'
  | 'party'
  | 'legdist'
  | 'reasonCode'
  | 'phone'
  | 'precinct';

export interface ColumnChoice {
  field: ColumnField;
  label: string;
  required: boolean;
  header: string | null;
}

// The file's own headers (each once, as written) with the first row's value under each, and what each field is matched to. `ready` is
// whether every required field has a column.
export interface ColumnMap {
  headers: string[];
  sample: string[];
  choices: ColumnChoice[];
  ready: boolean;
}

// What an admin picks: a header of the file for a field, or null for "none". A field left out is matched by the saved choice or by name.
export type ColumnPick = Partial<Record<ColumnField, string | null>>;

// What the browser tells the Worker when it starts sending a sheet: what it found in the file, which the Worker cannot check, and how
// many people will follow.
export interface StageStart {
  filename: string;
  // KEY_VERSION in src/sheet.ts: how the keys of these people were made.
  keyVersion: number;
  expected: number;
  rows: number;
  skippedOtherDistrict: number;
  skippedInvalid: number;
  duplicates: number;
  warnings: string[];
  cities: { city: string; count: number }[];
  columns: ColumnMap;
  // The column of the file used for each field.
  used: ColumnPick;
}

// `chunk` is how many people the Worker takes in one request.
export interface StageStarted {
  token: string;
  chunk: number;
}

export interface UploadPreview {
  // Rows of the sheet that were read, and how many were left out: another legislative district, no name or address, or a repeat of
  // a person already in the same file.
  rows: number;
  skippedOtherDistrict: number;
  skippedInvalid: number;
  duplicates: number;
  added: number;
  updated: number;
  // People not on the sheet any more, who become cured.
  cured: number;
  stillUncured: number;
  reappeared: number;
  // Open people before this upload, and whether the file looks like a partial one (it would cure most of them).
  openBefore: number;
  looksPartial: boolean;
  warnings: string[];
  possibleMatches: PossibleMatch[];
  possibleMatchCount: number;
  cities: { city: string; count: number }[];
  columns: ColumnMap;
}

export interface ResetResult {
  deleted: { people: number; notes: number; uploads: number };
}

export interface ApiError {
  error: string;
  problems?: string[];
}

// GET /api/map: the open pool inside a box, as [id, latitude, longitude, 1 when the place is a guess]; `more` when the box held more than
// the Worker will send, and `tiles` when the basemap file is in place.
export interface MapPins {
  // [id, latitude, longitude, 1 for a guessed place, who has them: 0 nobody, 1 a volunteer, 2 a volunteer who has done nothing for stalledDays].
  pins: [number, number, number, 0 | 1, 0 | 1 | 2][];
  stalledDays: number;
  more: boolean;
  tiles: boolean;
  // With facets=1 (the first request): the values the filters offer, as on the list.
  facets?: NonNullable<PeoplePage['facets']>;
}

// What a volunteer organizes: every precinct (all), or the listed ones.
export interface OrganizerGrant {
  volunteerId: number;
  all: boolean;
  precincts: string[];
}

// Everyone's grants, and the precincts the open people are in (a grant outside them no longer matches anyone).
export interface OrganizerList {
  grants: OrganizerGrant[];
  precincts: string[];
  // The volunteers who are site admins: they organize everything, with or without a grant.
  siteAdmins: number[];
}
