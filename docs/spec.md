# How the cure tracker works

## People and roles

- **Everyone signed in** sees every person on the list and every note. Access decides who gets in; there is no per-person privacy inside the app.
- **Volunteer**: anyone Access lets in. Their first visit asks for a name. They can claim an unclaimed person, release their own claims, set a status, choose how they reached the person, and add notes on their own people.
- **Admin**: an email in the `ADMIN_EMAILS` Worker secret (`npx wrangler secret put ADMIN_EMAILS`, comma-separated; docs/setup.md). Admins can do all of the above on anyone's people, plus: upload the sheet, move one person or all of a volunteer's open people to someone else (or back to the pool), dismiss flags, read the audit log.
- A service token (a machine caller) is refused: the app needs an email.

## Statuses

| Status | Set by | Meaning |
| --- | --- | --- |
| Needs to be contacted | upload (new person), volunteer | nobody has reached them |
| Left voicemail / texted flyer | volunteer | tried, no conversation; with no method chosen, it counts as a phone call |
| Contacted | volunteer | the volunteer talked to them; the ballot should be cured |
| Cured | upload only | the state's sheet no longer lists them |

A volunteer can never set Cured: only the state's data can verify it. Claims do not expire and there is no limit.

## The sheet

The admin exports the LD8 tab of the state's workbook as CSV. Columns are matched by name, in any order, ignoring case and anything that is not a letter or digit (`Precinct Name` and `PRECINCT_NAME` are the same), and extra columns are ignored. `FIRST`, `LAST` and `ADDRESS` are required (also `FIRST NAME`, `LAST NAME`, `RESIDENCE ADDRESS`); `MID`, `STATUSDATE`, `PARTY`, `LEGDIST`, `REASONCODE`, `PHONE` and `PRECINCT_NAME` are used when present, and a warning says what is blank when one is missing. When the state renames a column, the upload page lists the file's columns with a select for each field, with an example value from the first row, so the admin can say which is which. What an upload used is saved (the `column_map` setting) and is the starting point for the next one while the file still has that header; the upload's audit row records it. The delimiter is a comma, or a tab for a sheet pasted as text.

- Rows with a `LEGDIST` other than 8 are skipped (a blank `LEGDIST` is taken as 8).
- The sheet has no voter id, so **a person is their normalized first name, last name and address** (`normalizeKey` in `src/sheet.ts`). Names keep only letters and digits, so `O'Brien`, `O Brien` and `OBRIEN` are one name; accents and the middle name do not count. The address is reduced to the street line, so the state, ZIP (with or without +4), a corrected ZIP or city, and the word before a unit number (`APT 2129`, `UNIT 2129`, `# 2129`, `2129`) do not make a new person, and the words the state spells differently between dumps are made the same (`STREET`/`ST`, `NORTH`/`N`, `P.O. BOX`/`PO BOX`, after USPS Publication 28). Different unit numbers, and a unit left out entirely, are different keys; the second is what **possible matches** are for. The stored and displayed address is still the sheet's own. A person with the same first and last name at the same street address but a different suffix (Jr, Sr) is not merged by the key. If the rules above change, `KEY_VERSION` goes up and the upload page warns that the people already here were keyed the old way (use **Start over** first).
- The city is read from the address (`3302 N 47TH PL PHOENIX, AZ 85018`) by matching the end against a list of Maricopa-area cities; an unknown city is left blank and the preview says so. Add the city to `CITIES` in `worker/import.ts`.
- The status date (`10/21/2026`, `2026-10-21`, with or without a time) gives "days uncured": the days from it to today in Arizona.
- A row repeated within a file is merged: the later status date wins, blanks are filled from the other row.

### Where people live

An admin presses **Look up addresses** (admin page, "Where people live"). The Worker sends each open person's street address (an id, street, city, state and ZIP; never a name, phone number or note) to the US Census Bureau's batch geocoder, two hundred at a time, and stores the coordinates it answers with in `people` (`lat`, `lon`, `geocode`, `geocoded_at`). The page first shows how many are waiting and the first lines of the next request. Someone the geocoder cannot place, or ties on, is marked and not sent again. An upload that changes a person's address clears their coordinates, so they are looked up again; cured people are never sent. A failed request stores nothing and the run goes on where it stopped. Each request has an `geocode` audit row. Locally (the dev server, the tests) a stand-in answers, so nothing reaches the network. This is for the map and distance filter to come; nothing shows the coordinates yet.

### What an upload does

The admin picks the file and presses **Check the file**. The browser reads the CSV (`src/sheet.ts`) and sends the people to the Worker a hundred at a time (`src/upload.ts`), because a free Worker has about 10 ms of CPU a request and could not read a large file; the page shows the progress. They wait in a scratch table (`upload_rows`); no person is changed. The page then shows the counts, warnings and possible matches, which the database works out by comparing the staged people with the people (SQL in `worker/uploads.ts`). **Upload this file** applies it, all or nothing, in one batch, without sending the file again. Only one upload is in flight: choosing a file again replaces the staged one, and the upload refuses to apply unless every person arrived. Because the people are read in key order, ids follow the key, not the sheet's order.

1. A person not seen before is added as **Needs to be contacted**, unclaimed.
2. A known person on the sheet has their details refreshed (phone, address, precinct, status date, ...). Their status and volunteer stay, with two exceptions that **flag** them:
   - **Unsuccessful cure** (flag `still_uncured`): a volunteer marked them Contacted, and the sheet still lists them after the **grace period**. They go back to Needs to be contacted, keep their volunteer, and show on the admin panel. The grace is how many uploads may still list a contacted person before this counts: an admin sets it under **Unsuccessful cures** on the admin page, from 0 (the first upload that lists them) to 30, and it starts at 1, because the state's data runs a little behind the phone calls. Each upload that lists a contacted person is one cycle; changing someone's status starts the count over.
   - **Back after being cured**: a Cured person is on the sheet again. They are reopened as Needs to be contacted, keep their old volunteer, and are flagged.
3. A person who is not on the sheet and not yet Cured becomes **Cured**. They keep their volunteer, so the credit stays.
4. A volunteer answering the flag (changing the status) or an admin dismissing it clears it.

Safeguards:
- A file that would cure more than half of at least ten open people is probably a partial export. The upload is refused unless the admin ticks "Upload it anyway".
- A new person who looks like someone who just disappeared is listed as a **possible match**: the same last name and address with another first name, the same first name and address with another last name, or the same name at another address. The match is by the normalized key, not by similarity: a typo in two of the three parts, a nickname, or `ST` against `STREET` is not found. Each listed pair has a **same person** box. Ticking it (the Worker keeps the marks with the staged sheet and works the counts out again) makes the upload re-key the old record to the sheet's key and update it, instead of curing it and adding the new one as a stranger: the record keeps its id, notes, volunteer, status and history, and an `import.merged` audit row says who they were. Unticked, nothing is merged, as before.

## Start over

While trying the tool with test data, an admin can use **Start over** (bottom of the admin page) to delete every voter, every note and the upload history. A dialog asks first. Volunteers, the grace period setting and the audit log stay, and the log gets a row saying how much was deleted. It exists only where the deployment turns it on: `ALLOW_RESET` in `wrangler.jsonc` is `"true"`; set it to `"false"` and deploy before the real sheet goes in, and the route refuses and the section disappears. The API also requires the body `{ "confirm": "delete all voters" }`, so a stray request cannot do it.

## Audit log

Every change writes a row: who, when, what, which person. Joining, renaming, claims, releases, status changes, notes, assignments, reassignments, flag dismissals, uploads and what each upload cured, flagged or reopened. Admins read it newest first on the admin page.

## Limits and things not built

- No distance sorting yet: Find people sorts and filters by days uncured, city, precinct, party and name. Addresses can be placed on the map by the Census geocoder (above); showing them and sorting by distance come next. The geocoder is the only outside service the Worker calls.
- No notifications, no email, no SMS from the app. Volunteers call or text from their own phones (the phone number is a `tel:` link).
- D1 and Worker limits matter for big uploads (docs/decisions.md, 17): the browser reads the file, each request carries about a hundred people and one SQL statement, and the comparison and the changes are set operations inside D1. `npm run bench` times it on a synthetic 10,000-person sheet. Staging costs about one row written per person and is cleared after.
