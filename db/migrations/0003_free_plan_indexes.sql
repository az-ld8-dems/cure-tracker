-- Free D1 reads 5 million rows a day and writes 100,000, counting every row an index adds. These indexes let each Find people page, in any
-- of its sorts and with a city or precinct filter, read about the rows it shows (people_pool, from 0002, does the default sort). The
-- worker (worker/api.ts) filters with the same COLLATE NOCASE and the same COALESCE, so SQLite can use them.
CREATE INDEX people_pool_city ON people (city COLLATE NOCASE, COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_pool_precinct ON people (precinct COLLATE NOCASE, COALESCE(status_date, '9999-12-31'), id) WHERE assigned_to IS NULL AND status != 'cured';
CREATE INDEX people_pool_name ON people (last_name COLLATE NOCASE, first_name COLLATE NOCASE, id) WHERE assigned_to IS NULL AND status != 'cured';

-- Nothing selects on status alone any more, and an index costs a row written on every insert and every status change.
DROP INDEX people_status;
