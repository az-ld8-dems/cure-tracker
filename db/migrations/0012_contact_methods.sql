-- More ways a volunteer can say they reached someone: a phone call and a text, a voicemail and a text, and three kinds of visit (spoke with the
-- voter, spoke with someone else at the address, left instructions at the door). contact_method has a CHECK, and SQLite cannot change one, so
-- people is rebuilt: the new table is filled from the old, the old is dropped and the new takes its name. Every column and index is as it was
-- (0001, 0006 to 0009, 0011) except that CHECK; the existing values stay valid and 'in_person' now reads "spoke with the voter".
-- notes points at people, and dropping a table a foreign key points at fails (even deferred, the rename does not clear it), so the notes
-- are set aside, notes is dropped and then rebuilt as it was (0001) once people is back; nothing else has a foreign key to people.
CREATE TABLE notes_aside (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, volunteer_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
INSERT INTO notes_aside SELECT id, person_id, volunteer_id, body, created_at FROM notes;
DROP TABLE notes;

CREATE TABLE people_new (
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
  contact_method TEXT CHECK (contact_method IN ('call', 'text', 'call_and_text', 'voicemail_and_text', 'email', 'in_person', 'in_person_other', 'in_person_door', 'other')),
  assigned_to INTEGER REFERENCES volunteers (id),
  flag TEXT CHECK (flag IN ('still_uncured', 'reappeared')),
  -- How many uploads have listed this person since a volunteer last marked them contacted (0 when they are not marked contacted).
  contacted_cycles INTEGER NOT NULL DEFAULT 0,
  cured_at TEXT,
  first_upload_id INTEGER NOT NULL REFERENCES uploads (id),
  last_upload_id INTEGER NOT NULL REFERENCES uploads (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lat REAL,
  lon REAL,
  geocode TEXT CHECK (geocode IN ('match', 'no_match', 'tie')),
  geocoded_at TEXT,
  approximate INTEGER NOT NULL DEFAULT 0 CHECK (approximate IN (0, 1)),
  placed_by TEXT
) STRICT;

INSERT INTO people_new (
  id, key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct, status_date, status,
  status_changed_at, contact_method, assigned_to, flag, contacted_cycles, cured_at, first_upload_id, last_upload_id, created_at, updated_at,
  lat, lon, geocode, geocoded_at, approximate, placed_by
)
SELECT
  id, key, first_name, middle_name, last_name, party, legdist, reason_code, phone, address, city, zip, precinct, status_date, status,
  status_changed_at, contact_method, assigned_to, flag, contacted_cycles, cured_at, first_upload_id, last_upload_id, created_at, updated_at,
  lat, lon, geocode, geocoded_at, approximate, placed_by
FROM people;

DROP TABLE people;
ALTER TABLE people_new RENAME TO people;

CREATE INDEX people_pool ON people (COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_mine ON people (assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX people_flagged ON people (status_changed_at DESC, id) WHERE flag IS NOT NULL AND status != 'cured';
CREATE INDEX people_pool_city ON people (city COLLATE NOCASE, COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_pool_precinct ON people (precinct COLLATE NOCASE, COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_pool_name ON people (last_name COLLATE NOCASE, first_name COLLATE NOCASE, id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_pool_place ON people (lat, lon) WHERE assigned_to IS NULL AND status != 'cured' AND lat IS NOT NULL;
CREATE INDEX people_claimed_place ON people (lat, lon) WHERE assigned_to IS NOT NULL AND status != 'cured' AND lat IS NOT NULL;

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people (id),
  volunteer_id INTEGER NOT NULL REFERENCES volunteers (id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO notes SELECT id, person_id, volunteer_id, body, created_at FROM notes_aside;
DROP TABLE notes_aside;
CREATE INDEX notes_person ON notes (person_id);
