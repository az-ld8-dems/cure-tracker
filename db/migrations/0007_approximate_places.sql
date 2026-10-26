-- A person the geocoder could not place can still be put at the middle of their ZIP, worked out from the people it did place there. That
-- place is a guess, so the map draws it another way: approximate is 1 for it, 0 for a place the geocoder found. geocode still says what
-- the geocoder said ('no_match' or 'tie'). An upload that changes the address clears the place and this flag (worker/uploads.ts).
ALTER TABLE people ADD COLUMN approximate INTEGER NOT NULL DEFAULT 0 CHECK (approximate IN (0, 1));
