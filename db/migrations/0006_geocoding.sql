-- Where each person lives, as the US Census geocoder places the address (worker/geocode.ts), so Find people can show a map and sort by
-- distance. NULL geocode means not tried yet; an upload that changes a person's address clears these four, so they are looked up again.
ALTER TABLE people ADD COLUMN lat REAL;
ALTER TABLE people ADD COLUMN lon REAL;
ALTER TABLE people ADD COLUMN geocode TEXT CHECK (geocode IN ('match', 'no_match', 'tie'));
ALTER TABLE people ADD COLUMN geocoded_at TEXT;
