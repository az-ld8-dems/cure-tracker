// The shapes the JSON API sends and receives, shared by the Worker (worker/api.ts) and the pages (src/*.ts). Types only: the file is
// erased on both sides.

export type Status = 'needs_contact' | 'left_voicemail' | 'contacted' | 'cured';
// still_uncured (an unsuccessful cure): marked contacted, yet still on the sheet after the admins' grace period. reappeared: was cured, but is on a later upload again.
export type Flag = 'still_uncured' | 'reappeared';
export type ContactMethod = 'call' | 'text' | 'email' | 'in_person' | 'other';

export interface Me {
  id: number;
  email: string;
  // Empty until the volunteer has said what to call them.
  name: string;
  isAdmin: boolean;
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
}

export interface PossibleMatch {
  // address: the same last name at the same address with another first name. moved: the same name at another address.
  kind: 'address' | 'moved';
  existing: { id: number; name: string; address: string };
  incoming: { name: string; address: string };
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
}

export interface ResetResult {
  deleted: { people: number; notes: number; uploads: number };
}

export interface ApiError {
  error: string;
  problems?: string[];
}
