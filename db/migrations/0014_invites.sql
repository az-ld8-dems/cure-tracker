-- People an admin emailed instructions for signing in (worker/invites.ts). The email is the key; whether they have signed in is read from
-- `volunteers`, not stored. `last_sent_at` is null when the send failed, so the admin page can say so.
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  last_sent_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0
) STRICT;
