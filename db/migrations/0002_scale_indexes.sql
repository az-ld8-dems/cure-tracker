-- Indexes for the lists the pages read, so a page touches the rows it shows and not the whole table.
-- people_pool: "Find people", the open people nobody has claimed. Its order is the default sort (longest uncured first), so that
-- page stops reading after the first rows. The condition and the COALESCE must match worker/api.ts (POOL_WHERE, DAYS_ORDER).
CREATE INDEX people_pool ON people (COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';

-- people_mine: one volunteer's people. It also serves everything people_assigned_to did, so that one goes. It leaves out the unclaimed
-- people on purpose: with them, SQLite would pick it for the pool query over people_pool and sort the pool by hand.
CREATE INDEX people_mine ON people (assigned_to, status) WHERE assigned_to IS NOT NULL;
DROP INDEX people_assigned_to;

-- people_flagged: the admin's list of people an upload flagged, newest first.
CREATE INDEX people_flagged ON people (status_changed_at DESC, id) WHERE flag IS NOT NULL AND status != 'cured';
