-- Claimed people (not cured) who have a place, by latitude then longitude, so the map can show who is being worked on without reading the
-- whole table. Partial like people_pool_place (0008): a release or a cure removes the entry.
CREATE INDEX people_claimed_place ON people (lat, lon) WHERE assigned_to IS NOT NULL AND status != 'cured' AND lat IS NOT NULL;
