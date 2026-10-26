-- Who may organize which precincts (move people between volunteers) without being a site admin. Site admins come from the ADMIN_EMAILS secret and
-- need no row. A volunteer with a row for '*' organizes every precinct; otherwise one row per precinct, spelled as the state's sheet spells it
-- (compared ignoring case). People with a blank precinct can be moved by anyone who organizes anything. No rows means a plain volunteer.
CREATE TABLE organizers (
  volunteer_id INTEGER NOT NULL REFERENCES volunteers (id),
  precinct TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (volunteer_id, precinct)
) STRICT;
