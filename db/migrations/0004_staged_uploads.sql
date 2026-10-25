-- A sheet on its way in. The admin's browser reads the CSV and sends the people to the Worker a hundred or so at a time, because a free
-- Worker has about 10 ms of CPU a request and parsing a large sheet takes far longer. The rows wait here; one request then compares them
-- with the people and applies the result in one batch (worker/uploads.ts). Only one upload at a time: starting another replaces this.
CREATE TABLE upload_stage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Proves a request belongs to this upload and not to an older one still open in another tab.
  token TEXT NOT NULL,
  filename TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- How many people the browser will send; the upload refuses to apply unless exactly that many arrived.
  expected INTEGER NOT NULL,
  -- What the browser found while reading the file.
  rows INTEGER NOT NULL,
  skipped_other_district INTEGER NOT NULL,
  skipped_invalid INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  warnings TEXT NOT NULL,
  cities TEXT NOT NULL,
  columns TEXT NOT NULL,
  -- The column of the file used for each field, saved as the starting point for the next upload.
  used TEXT NOT NULL
) STRICT;

-- The people of the sheet, as the browser read them. The key is the person (normalized first name, last name and address), as in people.
-- One b-tree and no other index, so staging costs one row written per person.
CREATE TABLE upload_rows (
  key TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  middle_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  party TEXT NOT NULL,
  legdist TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  zip TEXT NOT NULL,
  precinct TEXT NOT NULL,
  status_date TEXT
) STRICT, WITHOUT ROWID;
