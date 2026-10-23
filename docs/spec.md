# How the cure tracker works

## People and roles

- **Everyone signed in** sees every person on the list and every note. Access decides who gets in; there is no per-person privacy inside the app.
- **Volunteer**: anyone Access lets in. Their first visit asks for a name. They can claim an unclaimed person, release their own claims, set a status, choose how they reached the person, and add notes on their own people.
- **Admin**: an email in `ADMIN_EMAILS` (`wrangler.jsonc`). Admins can do all of the above on anyone's people, plus: upload the sheet, move one person or all of a volunteer's open people to someone else (or back to the pool), dismiss flags, read the audit log.
- A service token (a machine caller) is refused: the app needs an email.

## Statuses

| Status | Set by | Meaning |
| --- | --- | --- |
| Needs to be contacted | upload (new person), volunteer | nobody has reached them |
| Left voicemail / texted flyer | volunteer | tried, no conversation |
| Contacted | volunteer | the volunteer talked to them; the ballot should be cured |
| Cured | upload only | the state's sheet no longer lists them |

A volunteer can never set Cured: only the state's data can verify it. Claims do not expire and there is no limit.

## The sheet

The admin exports the LD8 tab of the state's workbook as CSV. Columns are matched by name, case-insensitively, in any order, and extra columns are ignored. `FIRST`, `LAST` and `ADDRESS` are required; `MID`, `STATUSDATE`, `PARTY`, `LEGDIST`, `REASONCODE`, `PHONE` and `PRECINCT_NAME` are used when present. The delimiter is a comma, or a tab for a sheet pasted as text.

- Rows with a `LEGDIST` other than 8 are skipped (a blank `LEGDIST` is taken as 8).
- The sheet has no voter id, so **a person is their normalized first name, last name and address** (case, punctuation, accents and the middle name do not count). `normalizeKey` in `worker/import.ts` is the one place to change that.
- The city is read from the address (`3302 N 47TH PL PHOENIX, AZ 85018`) by matching the end against a list of Maricopa-area cities; an unknown city is left blank and the preview says so. Add the city to `CITIES` in `worker/import.ts`.
- The status date (`10/21/2026`, `2026-10-21`, with or without a time) gives "days uncured": the days from it to today in Arizona.
- A row repeated within a file is merged: the later status date wins, blanks are filled from the other row.

### What an upload does

The admin picks the file and presses **Check the file**: nothing is written, and the page shows the counts, warnings and possible matches. **Upload this file** then applies it, all or nothing.

1. A person not seen before is added as **Needs to be contacted**, unclaimed.
2. A known person on the sheet has their details refreshed (phone, address, precinct, status date, ...). Their status and volunteer stay, with two exceptions that **flag** them:
   - **Unsuccessful cure** (flag `still_uncured`): a volunteer marked them Contacted, and the sheet still lists them after the **grace period**. They go back to Needs to be contacted, keep their volunteer, and show on the admin panel. The grace is how many uploads may still list a contacted person before this counts: an admin sets it under **Unsuccessful cures** on the admin page, from 0 (the first upload that lists them) to 30, and it starts at 1, because the state's data runs a little behind the phone calls. Each upload that lists a contacted person is one cycle; changing someone's status starts the count over.
   - **Back after being cured**: a Cured person is on the sheet again. They are reopened as Needs to be contacted, keep their old volunteer, and are flagged.
3. A person who is not on the sheet and not yet Cured becomes **Cured**. They keep their volunteer, so the credit stays.
4. A volunteer answering the flag (changing the status) or an admin dismissing it clears it.

Safeguards:
- A file that would cure more than half of at least ten open people is probably a partial export. The upload is refused unless the admin ticks "Upload it anyway".
- A new person who looks like someone who just disappeared (same last name and address with another first name, or the same name at another address) is listed as a **possible match**. Nothing is merged; the old record is cured and the new one added. An admin can reassign by hand.

## Start over

While trying the tool with test data, an admin can use **Start over** (bottom of the admin page) to delete every voter, every note and the upload history. A dialog asks first. Volunteers, the grace period setting and the audit log stay, and the log gets a row saying how much was deleted. It exists only where the deployment turns it on: `ALLOW_RESET` in `wrangler.jsonc` is `"true"`; set it to `"false"` and deploy before the real sheet goes in, and the route refuses and the section disappears. The API also requires the body `{ "confirm": "delete all voters" }`, so a stray request cannot do it.

## Audit log

Every change writes a row: who, when, what, which person. Joining, renaming, claims, releases, status changes, notes, assignments, reassignments, flag dismissals, uploads and what each upload cured, flagged or reopened. Admins read it newest first on the admin page.

## Limits and things not built

- No distance sorting: the sheet has addresses only and the app calls no outside service. Sort and filter are by days uncured, city, precinct, party and name.
- No notifications, no email, no SMS from the app. Volunteers call or text from their own phones (the phone number is a `tel:` link).
- D1 limits matter for big uploads: an upload is a handful of batched statements (100 rows each), well inside them for a few thousand rows.
