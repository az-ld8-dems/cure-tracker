-- Cure tracker schema. Every table is STRICT. Times are UTC ISO strings; status_date is the date column of the state's sheet (YYYY-MM-DD).

CREATE TABLE volunteers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE uploads (
  id INTEGER PRIMARY KEY,
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  rows INTEGER NOT NULL,
  added INTEGER NOT NULL,
  cured INTEGER NOT NULL,
  still_uncured INTEGER NOT NULL,
  reappeared INTEGER NOT NULL
) STRICT;

-- One row per voter who needs (or needed) curing. `key` is the normalized first name, last name and address: the sheet has no stable id.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  middle_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL,
  party TEXT NOT NULL DEFAULT '',
  legdist TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  precinct TEXT NOT NULL DEFAULT '',
  status_date TEXT,
  status TEXT NOT NULL DEFAULT 'needs_contact' CHECK (status IN ('needs_contact', 'left_voicemail', 'contacted', 'cured')),
  status_changed_at TEXT NOT NULL,
  contact_method TEXT CHECK (contact_method IN ('call', 'text', 'email', 'in_person', 'other')),
  assigned_to INTEGER REFERENCES volunteers (id),
  flag TEXT CHECK (flag IN ('still_uncured', 'reappeared')),
  -- How many uploads have listed this person since a volunteer last marked them contacted (0 when they are not marked contacted).
  contacted_cycles INTEGER NOT NULL DEFAULT 0,
  cured_at TEXT,
  first_upload_id INTEGER NOT NULL REFERENCES uploads (id),
  last_upload_id INTEGER NOT NULL REFERENCES uploads (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX people_assigned_to ON people (assigned_to);
CREATE INDEX people_status ON people (status);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people (id),
  volunteer_id INTEGER NOT NULL REFERENCES volunteers (id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX notes_person ON notes (person_id);

-- Settings an admin controls, one row each. grace_cycles: how many uploads a person marked contacted may stay on the list before it counts
-- as an unsuccessful cure (absent: 1).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Every change anyone makes. person_id has no foreign key on purpose: the log outlives what it describes.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  person_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX audit_person ON audit (person_id);
