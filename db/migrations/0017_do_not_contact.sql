-- Voters who asked not to be contacted. The flag lives on the person, and an upload never touches it (worker/uploads.ts lists the columns it
-- rewrites, and this is not one), so it holds through every later upload, including after the person is cured and listed again. A person with
-- the flag is in no pool, map, count, export or geocoder request, and nobody can claim or be given them (worker/api.ts, POOL_WHERE).
-- The partial indexes of the pool stay as they are: a query that adds `do_not_contact = 0` still implies their conditions.
ALTER TABLE people ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1));
-- The admin's list of them, and nothing else: almost no row is in it.
CREATE INDEX people_do_not_contact ON people (id) WHERE do_not_contact = 1;
