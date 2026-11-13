# Marketplace listing — Seat Reclaim for Confluence

Copy for the Atlassian Marketplace listing, checked against the field limits.
Assets: logo-144/512/1024 and banner-1120x548 in `assets/` (build_assets.py); highlights captured 2026-10-13 in `assets/2026-10-13/` (highlight-1-result, highlight-2-confirm, highlight-3-history, 1840x900); stage-1800x886 is the website image.

---

## Name (≤ 60 characters)

Seat Reclaim: Remove Inactive Users & Free Licenses for Confluence

(66 characters — too long. Use: "Seat Reclaim: Free Inactive Confluence Seats & Licenses" = 55.)

## Tagline (≤ 130, no trailing punctuation)

Find Confluence users who contribute nothing and free their seats after you confirm. Logged, confirmed by Confluence, undoable

## Summary (≤ 250)

Finds licensed Confluence users who created or edited nothing for 30 to 365 days and frees their seats after you confirm by taking them out of the groups that grant Confluence. Confluence admins are never reclaimed. Every change can be undone.

## Categories and keywords

- Categories: Administrative tools; Data and analytics
- Keywords: Audit, User permissions, Compliance, Reporting

## More details (250–1000)

**Every Confluence seat you pay for should belong to someone who uses Confluence.**

Seat Reclaim lists the licensed users who **created or edited nothing** in a period you choose (no page, blog post, comment or file) and frees their seats after you confirm.

- Which groups grant Confluence comes from Confluence itself, not from a setting you have to get right.
- Each user shows the groups a reclaim would remove, or why it can't: Confluence admins, you, and your protected list are never reclaimed.
- Select users, check the summary, confirm. Activity and groups are re-checked live first, and Confluence confirms each seat is free.
- History logs every change; Undo restores exactly the groups removed.

Confluence doesn't record who reads a page, so the list shows contributors only; check last-active dates in Atlassian Administration if in doubt.

**Nothing to set up.** No API key. Accounts stay active and pages keep their author. **Runs on Atlassian;** no servers of ours.

## Highlights (title ≤ 50, description ≤ 220)

1. **Free seats, confirmed by Confluence** — Select inactive users, confirm, and the app removes them from the groups that grant Confluence, then asks Confluence to confirm each seat is free.
2. **Check every change before it happens** — A summary lists the groups each person leaves. Activity and groups are re-checked live first. Leaving a group also removes anything else it grants. Confluence admins, you and anyone you protect are never reclaimed.
3. **Undo any reclaim** — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups.

## Version step

- Release summary: First release: find inactive Confluence users and free their seats, with undo
- Release notes: Finds licensed Confluence users with no contribution in a period you choose, checked against all content the app can see, and frees their seats after you confirm by taking them out of the groups that grant Confluence. Confluence administrators, the person running it and protected users are never reclaimed. Confluence confirms each freed seat. History logs every change and Undo restores exactly the groups removed. Includes a read-only Rovo agent.
- License: Commercial. Supported: Yes. EULA: Atlassian's standard EULA.

## Links

- Documentation: https://telcoma.app/apps/seat-reclaim-confluence/docs/
- Support: https://telcoma.app/apps/seat-reclaim-confluence/support/
- Privacy policy: https://telcoma.app/apps/seat-reclaim-confluence/privacy/

## Pricing (per user per month, each band at its own rate)

Same as Seat Reclaim for Jira scaled to Confluence's lower seat price: free ≤10, then
0.60 / 0.35 / 0.22 / 0.16 / 0.13 / 0.11 / 0.10 / 0.09 / 0.08 / 0.07 / 0.06. Multi-instance the same.

## Scope justification

| Scope | Why the app needs it |
| --- | --- |
| `read:content-details:confluence` | List the site's licensed users (`/search/user`, the list Atlassian Administration counts). |
| `read:confluence-user` | Profiles at display time; a user's groups just before a reclaim; whether the account can still use the site afterwards. |
| `read:confluence-groups` | The groups that grant Confluence, by global permission. |
| `search:confluence` | Find who contributed recently (CQL), and check each candidate against all content. |
| `read:page:confluence`, `read:blogpost:confluence` | Version history, to see who edited a page other people also edited. |
| `write:confluence-groups` | The one write scope: remove a user from a group that grants Confluence (reclaim) and add them back (undo), both as the signed-in site admin after they confirm. |
| `storage:app` | Scan progress, the report, the protected list, the reclaim history and the seat price, in Forge hosted storage. |

**Egress:** none. **Runs on Atlassian:** eligible.

## Privacy & Security tab

As Seat Reclaim for Jira, with "Confluence" for "Jira". In-scope EUD: account IDs of inactive users with their inactivity band and group IDs at scan time; the reclaim history; the protected list; the seat price. GDPR processor: Yes. Security contact: support@telcomaglobal.com. Permissions justification: the table above, one bullet per scope.

---

## Proposed changes (audit 14 Nov 2026)

Nothing above this line was changed. The public listing was read on 14 Nov 2026 (`/rest/2/addons/com.telcomaglobal.seat-reclaim-confluence` and `/versions/latest?hosting=cloud`, version 2.4.0, released 12 Nov). "Live" below is what that returned. Full reasons are in `audit-2026-11-14.md`.

### What is live and differs from this file

- **Name** live (59): "Seat Reclaim: Free Inactive Seats & Licenses for Confluence". Neither name in the Name section above is the live one.
- **Summary** live (226): "Finds licensed Confluence users who created or edited nothing for 30 to 365 days, not just an old Last seen or last login date, and frees their seats after you confirm. Admins are never touched, and every change can be undone." Two parts are not true of the code: the app reads no last seen or login date at all, and only Confluence admins are left alone (a Jira or organization admin who is in no Confluence admin group can be reclaimed).
- **More details** live still has the old bullet: "...or why it can't: admin groups, you, and your protected list are never touched."
- **Highlight 2** description live (147): "A summary lists the groups each person leaves. Activity and groups are re-checked live first. Admins, you and anyone you protect are never touched."
- **Release summary and notes** live: "Minor version update" (the default).
- **Hero** live is a YouTube video (`ieJGqy7ph0Q`, "Seat Reclaim for Confluence: free seats held by inactive users"), not a banner. **Gallery** live: no images.
- **Logo** live is the teal chair icon. Since 14 Nov the `assets/logo-*.png` files in this folder are that icon. The two `assets/banner-*.png` files are the first dots design, are not on the listing, and have a text line cut off at the right edge. Do not upload them.
- Tagline, categories, keywords, links, scopes and prices are live as written above.

### Name (58 / 60), optional

Seat Reclaim: Free Inactive Users' Licenses for Confluence

The live name has "Inactive Seats"; admins search for "inactive users" (we are 26th for that search in Confluence, 5th for "license"). This keeps "Licenses" and "Confluence" and adds the exact words "Inactive Users". A second choice, 56: "Seat Reclaim: Free Licenses of Inactive Confluence Users". Links by app number keep working after a rename (`/apps/3455028003` answers 301 to the listing). If you would rather not rename a live listing, keep the live name: it breaks no rule.

### Tagline (125 / 130, no punctuation at the end)

Remove inactive Confluence users from paid seats after you confirm, without deactivating accounts. Every change can be undone

Same shape as the tagline proposed for Seat Reclaim for Jira. It adds "inactive", "paid seats" and "deactivating", which admins search for, and every part is true of the code. The 13 Nov draft (128) is also true; it has none of those three words.

### Summary (242 / 250)

User management for unused licenses: finds inactive Confluence users (nothing created or edited in 30 to 365 days) and frees their seats after you confirm. People who only read are listed too. Confluence admins are never reclaimed. With undo.

The 13 Nov draft said "not just an old last active date" and "Admins are never touched". This keeps its search words (user management, unused licenses), adds "inactive Confluence users", says plainly that readers are listed, and says only what the code does about admins.

### More details (985 characters as the editor counts them, limit 1000; 1050 as markdown)

Seat Reclaim lists licensed users who **created or edited nothing** in a period you choose (no page, blog post, comment or file) and frees their seats after you confirm.

- The groups that grant Confluence are read from Confluence itself.
- Each user shows the groups a reclaim would remove, or why it can't. Confluence admins, you and anyone you protect are never reclaimed.
- Activity and groups are checked again just before each change, and Confluence confirms each seat is free. Leaving a group also removes anything else it grants.
- History logs every change. Undo restores exactly the groups removed.

Confluence doesn't record who reads a page, so people who only read are listed too. Check last-active dates in Atlassian Administration first.

**Nothing to set up.** No API key. Accounts stay active and pages keep their author. **Runs on Atlassian.** Free for up to 10 users.

Only want the report? [License Audit for Confluence](https://marketplace.atlassian.com/apps/1847167122) lists inactive users and what their seats cost, read-only.

What changed from the text above: the opening slogan is gone to make room; "the list shows contributors only" (which reads as the opposite of what is meant) is now "people who only read are listed too"; the warning about what else a group grants is added; "Free for up to 10 users" matches the live price table; the last line is the family link from the 13 Nov draft. Link the words "License Audit for Confluence" to https://marketplace.atlassian.com/apps/1847167122 (answers 301 to that listing).

### Highlights (title 50 or less, description 220 or less)

1. **Free seats, confirmed by Confluence** (35) — Select inactive users, confirm, and the app removes them from the groups that grant Confluence, then asks Confluence to confirm each seat is free. (146)
   Image: NEW SHOT 1 (the page just after a reclaim). Until then keep the live image.
2. **Check every change before it happens** (36) — A summary lists the groups each person leaves. Activity and groups are re-checked live first. Leaving a group also removes anything else it grants. Confluence admins, you and anyone you protect are never reclaimed. (214)
   Image: NEW SHOT 2 (the confirm dialog with today's wording). Until then keep the live image.
3. **Undo any reclaim** (16) — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups. (143)
   Image: NEW SHOT 3 (History with demo names). Until then keep the live image.

Titles and descriptions 1 and 3 are the live text. Description 2 is the text already in this file, not yet on the listing. The 13 Nov plan put `src-2-result.png` on highlight 1 and `src-3-list.png` on highlight 2; neither shows what its highlight says (no result confirmed by Confluence; no confirm summary), so they are not proposed for those places.

### Gallery (caption 220 or less; none live today)

1. growth/listing-screenshots-2026-11-13/out/src-2-result.png (ready now; shoot again as NEW SHOT 5 when the demo site has more people)
   Caption (136): Inactive users and what their seats cost a year, with the groups that grant Confluence. The yearly price of a seat is the one you enter.
2. NEW SHOT 4 (the list with ready, can't reclaim, protected and reclaimed rows)
   Caption (138): Who can be reclaimed and who cannot, with the reason. Confluence admins are never reclaimed, and Protect keeps anyone else you choose out.
3. NEW SHOT 6 (How it works, open)
   Caption (133): How it works, shown on the page: what counts as a contribution, who is never reclaimed, and what is checked again before each change.
4. NEW SHOT 7 (the list filtered to Ready to reclaim, a few rows ticked)
   Caption (158): Search by name or email and filter by time inactive and status. Select all ready picks everyone ready in the filtered list. Download the list as CSV or Excel.
5. NEW SHOT 8 (a scan running)
   Caption (124): Pick the period: no contribution in 30, 60, 90, 180 or 365 days. The scan runs in the background and you can leave the page.
6. NEW SHOT 9 (the Rovo agent answering a question)
   Caption (149): Ask the Rovo agent how many seats can be reclaimed, who is ready and what was undone. It only reads: reclaiming stays on the page, after you confirm.

Not proposed: `src-1-how.png` (it is the same picture as `src-2-result.png` and does not show How it works), `src-3-list.png` and `src-4-history.png` from 13 Nov (reasons in the audit file). The shots are described in `audit-2026-11-14.md`, section 4.

### Version step, for the next production release

- Release summary (68 / 80): History kept for good, long scans pause and resume, clearer messages
- Release notes (497): History keeps every reclaim and undo, with no limit. A reclaim acts only on people on the current list. A reclaim that changes nothing is shown on the person's row, not in History. Very long scans pause and continue while the page is open. Someone who contributed to a whiteboard or database that another person changed last is counted as active. A page deleted during a scan no longer stops it. The page says when its figures are older than the latest reclaim, and How it works is easier to read.

The first five sentences describe what went to production on 12 Nov (its notes say only "Minor version update"). The last two describe the 14 Nov changes, which are in development only: use the whole text for the next production release, or the first five sentences if you edit the notes of 2.4.0 now.

### Scope justification

Two rows change, so that each call is under the scope that covers it:

- `read:content-details:confluence`: List the site's licensed users (`/search/user`, the list Atlassian Administration counts), and ask the same list after a reclaim whether the account can still use the site.
- `read:confluence-user`: Profiles at display time; a user's groups during a scan and again just before a reclaim; whether the person using the page is a Confluence administrator (every call).

### Privacy & Security tab

- Data residency, in-scope End-User Data: Atlassian account IDs of inactive users with their inactivity band and the IDs of their groups that grant Confluence at scan time; the IDs and names of the groups that grant Confluence; the reclaim history (account IDs of the affected user and the approving admin, times, the ID and name of each group changed, whether Confluence confirmed the seat as free and, when Confluence refused a change, Confluence's error text); a note per user when a reclaim changed nothing (the reason, which can be Confluence's error text); the protected list (account IDs of the protected user and of the admin who protected them, and when); and the seat price an admin enters (no personal data). All in Forge hosted storage. Out of scope: scan progress counters and cursors (no personal data). In-scope data stored outside Atlassian: No.
- GDPR processor: Yes. Atlassian account IDs of licensed users, the IDs and names of the groups that grant Confluence, and the history of reclaims and undos (stored); display names and email addresses (read at display time, never stored).
- The public API reports `storesPersonalData: false` for this listing. The app stores Atlassian account IDs. Check the "stores personal data" answer in the listing editor against the answers above.
- Other answers: no change.

### Pricing

No change proposed. The table above matches the live prices (free up to 10 users; $300 a year at 50 users).
