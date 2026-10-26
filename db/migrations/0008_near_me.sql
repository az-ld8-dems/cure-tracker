-- Where a volunteer is, so Find people can show who is nearest. Only ever rounded to 0.01 degrees (about 0.7 miles) before it is stored, and
-- the volunteer can clear it. It is never shown to anyone else and never written to the audit log.
ALTER TABLE volunteers ADD COLUMN home_lat REAL;
ALTER TABLE volunteers ADD COLUMN home_lon REAL;

-- People in the pool who have a place, by latitude then longitude: a "within N miles" search reads a band of the map instead of the whole
-- pool. Partial on the pool, like the others (worker/api.ts POOL_WHERE), so a claim removes the entry.
CREATE INDEX people_pool_place ON people (lat, lon) WHERE assigned_to IS NULL AND status != 'cured' AND lat IS NOT NULL;
