-- People an organizer assigned to a volunteer who has not been told yet. The admin page lists these per volunteer, and one button emails
-- the volunteer once for all of them and clears the flag (worker/mail.ts). Set by assigning or moving someone to another volunteer; cleared by
-- the email, a claim, a release, or a move to the pool or to the person who moved them.
ALTER TABLE people ADD COLUMN notify_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX people_notify_pending ON people (assigned_to) WHERE notify_pending = 1;
