-- People an admin has marked as the same person as someone on the sheet being uploaded, because the state corrected their name or
-- address: the old record (person_id) is re-keyed to the sheet's key (new_key) by the upload, instead of being cured while the corrected
-- one is added as a stranger. Kept with the staged sheet, and cleared with it.
CREATE TABLE upload_merges (
  person_id INTEGER PRIMARY KEY,
  new_key TEXT NOT NULL UNIQUE
) STRICT;
