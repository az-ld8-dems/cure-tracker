-- When a volunteer was last emailed that people were assigned to them (worker/mail.ts); the admin page shows it next to the button.
ALTER TABLE volunteers ADD COLUMN notified_at TEXT;
