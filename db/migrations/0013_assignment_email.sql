-- When a volunteer was last emailed that someone assigned them a voter (worker/mail.ts). One email per volunteer per throttle window, so an
-- organizer assigning ten people in a row sends one message, not ten.
ALTER TABLE volunteers ADD COLUMN notified_at TEXT;
