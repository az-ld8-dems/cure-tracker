-- Who gave a person their place, when it was not the geocoder: an admin's email, for someone the geocoder could not place and an admin looked
-- up by hand. NULL for everyone the geocoder placed or guessed. geocode still says what the geocoder said. A person the geocoder later finds
-- loses this; an upload that changes the address clears it with the place (worker/uploads.ts).
ALTER TABLE people ADD COLUMN placed_by TEXT;
