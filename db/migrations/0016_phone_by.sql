-- Who gave a person their phone number, when it was not the state's sheet: an admin's or organizer's email, for someone whose sheet row had no
-- phone and a number was found some other way. NULL for everyone whose phone came from the sheet (or who has none). An upload that carries a
-- phone for the person replaces the entered one and clears this; one that leaves the phone blank keeps it (worker/uploads.ts).
ALTER TABLE people ADD COLUMN phone_by TEXT;
