# Privacy & Security tab: Seat Reclaim for Confluence (draft answers)

Draft answers for the personal data parts of the Marketplace Privacy & Security tab, checked against manifest.yml and src/ on 14 November 2026, when the weekly personal data report was added. Nothing here has been entered on the Marketplace. The tab is private, so the answers already there could not be read; answers this file does not mention stay as they are (the drafts in `listing.md`, under "Privacy & Security tab" and the 14 Nov audit's proposed changes). A line starting with CHECK: needs a fact or a decision the code cannot settle.

## Data the app stores

Where: Forge hosted storage (Forge key-value storage, `@forge/kvs`) on the customer's site. Nothing is stored anywhere else.

| What | Personal data | Kept until |
| --- | --- | --- |
| The last list: for each inactive licensed user, the account ID, the product (Confluence), the IDs of their groups that grant Confluence, and how long they have been inactive (a band such as "180–365 days") (`report:dormant:`); and the account IDs on that list, which a reclaim checks against (`report:ids:`) | Yes: account IDs of inactive users | The next scan replaces the list, or uninstall. The row of an account Atlassian reports closed is taken out by the weekly personal data report |
| The list's totals: when the scan started and ended, the period, licensed, active and inactive users, how many guests, which groups grant Confluence (group IDs and names, and which are admin groups), how many items were checked, and warnings: fixed sentences and, when the group list could not be read, Confluence's error text (`report:meta`) | No account ID of its own. A Confluence error text in a warning can quote an account ID | The next scan, or uninstall. An account ID quoted in a warning is replaced with "(closed account)" when Atlassian reports it closed |
| The scan in progress or the last one: phase, positions (offsets and a Confluence page cursor), counters, times, the groups that grant Confluence (IDs and names), warnings, the error text if the scan failed and why a slice could not be queued (`scan:state`) | No account ID of its own. Confluence's error text can quote an account ID | Overwritten by the next scan, or uninstall. A quoted account ID is replaced as above |
| Working data while a scan runs: each licensed user's account ID, the accounts seen contributing, and the inactive users found so far (`scan:{run}:users:`, `scan:{run}:active:`, `scan:{run}:dormant:`) | Yes: account IDs of every licensed user | Deleted when the scan ends, fails or is cancelled. A scan that stopped without ending keeps it until the next scan starts. A closed account is taken out |
| History: one entry per reclaim, with the account ID of the person, of the admin who approved it and of the admin who undid it, the times, the ID and name of each group left, the product freed or kept (and the admin group that keeps it), whether Confluence confirmed the seat as free and, when Confluence refused a change, Confluence's error text (`log:entry:`); and the order of the entries, entry IDs only (`log:index`, `log:index:<n>`, `log:index:meta`) | Yes: account IDs of the person and the admins. Confluence's error text can quote an account ID | For good, so every reclaim can be undone, or uninstall. An entry about an account Atlassian reports closed is deleted by the weekly personal data report |
| The latest action on each person, to mark their row: the entry it belongs to, its outcome and time, or why the last try changed nothing (a fixed sentence, for example that Confluence says the person can administer it, or Confluence's error text) (`log:latest:`) | Yes: account IDs of the people reclaimed or tried | Replaced by the next action on the same person, or uninstall. Taken out for an account Atlassian reports closed |
| The protected list: the account ID of each protected person, when, and the account ID of the admin who protected them (`protected`) | Yes: account IDs of protected people and of admins | Until an admin unprotects the person, or uninstall. A closed person's entry is taken out; a closed admin's account ID is cleared |
| When a reclaim, an undo, History's re-check or a protect last started, a time only (`action:started`) | No | Overwritten by the next one, or uninstall |
| Settings: the yearly price of one Confluence seat, and the date an admin closed the one-time review request (`settings`) | No | Changed again, or uninstall |
| Personal data report: where this week's report is, and the totals of the last one (`pdr:state`, positions and counts only); the account IDs gathered for it (`pdr:ids:<n>`), the closed ones among them (`pdr:closed:<n>`) and those Atlassian says changed their profile (`pdr:updated:<n>`); a lock so two runs never overlap (`pdr:lock`) | Yes, while a report runs: the gathered, closed and changed account IDs | `pdr:ids:`, `pdr:closed:` and `pdr:updated:` are deleted when the report ends, normally within the hour it started. The lock is deleted when a run ends, and is free after 2 minutes if a run was stopped. The totals stay until the next report |

Read but never stored: display names and email addresses (where a user's profile lets apps see them), read from Confluence when the list or History is shown or downloaded, when a reclaim result is shown, or when the Rovo agent answers an admin; the content Confluence returns to the activity search (titles and version details), of which only who created or edited it and when is used.
Changes the app makes on the site: it takes a person out of groups that grant Confluence (reclaim) and puts them back (undo), as the signed-in site admin, after the admin confirms. Nothing else.
Queue events and scheduled triggers: each queue event of a scan carries only the run ID and a sequence number. An hourly scheduled trigger runs the weekly personal data report (below), whatever the licence says.

**Data stored** (the paragraph on the tab, to replace the one there): Account IDs of the inactive users on the last list, with the IDs of their groups that grant Confluence and an inactivity band derived by the app; the IDs and names of the groups that grant Confluence; while a scan runs, the account ID of each licensed user (deleted when the scan ends); the reclaim history (account IDs of the person, the approving admin and the admin who undid it, times, the ID and name of each group changed, whether Confluence confirmed the seat as free and, when Confluence refused a change, Confluence's error text) and the latest action on each person (or why the last try changed nothing); the protected list (account IDs of the protected person and of the admin who protected them, and when); scan progress and its warnings (which can include Confluence's error text), the seat price an admin enters, and the date an admin closed the review request. Display names and email addresses are never stored; they are looked up from Confluence when the list or History is viewed or exported, or when the Rovo agent answers an admin. No page content, comments or attachments are stored. The account IDs are reported to Atlassian once a week, and those of closed accounts are erased. Uninstalling the app deletes all of it.

## Personal data

- Stores personal data: **Yes**. Atlassian account IDs of: the inactive licensed users on the last list; while a scan runs, every licensed user; the people reclaimed and the admins who approved or undid each reclaim (History, kept for good so every reclaim can be undone); the people tried and not reclaimed (the note on their row); and the protected people with the admins who protected them.
- Processes personal data without storing it: display names and email addresses, read from Confluence when the list or History is shown, downloaded or read by the Rovo agent. The agent passes them to Atlassian Rovo, within Atlassian.
- Developer console, Distribution, "Does your app store personal data?": Yes (account IDs are kept longer than 24 hours). On the Marketplace form the same Yes ticks the Personal Data Reporting API acknowledgment, which is true: the app calls it.
- Closed Atlassian accounts: the app uses Forge's personal data reporting API (`privacy.reportPersonalData`, scope `report:personal-data`). Once a week it reports every account ID it keeps, 90 per call; a new report starts 7 days after the last call of the one before, so no account is reported more often than once in 7 days. For each account Atlassian reports closed it erases the account ID everywhere it keeps it: the account's row on the last list is taken out, so it can no longer be reclaimed; every History entry about the person is deleted (Undo could only give a closed account its groups back); their protected-list entry and the note on their row are taken out; the account ID of an admin who approved or undid a reclaim, or protected someone, is cleared, and where History names that admin it shows "Closed account"; an account ID quoted in a stored Confluence error text becomes "(closed account)"; and the account is taken out of the working data of a scan. The totals already shown stay as the scan counted them until the next scan counts again; the page, the download and the Rovo agent say how many users on the list are no longer listed. Erasing waits while a scan is running, and for a minute after a reclaim, an undo, History's re-check or a protect starts. The app keeps no names or emails, so an "updated" answer needs nothing.
- CHECK: the GDPR and CCPA answers already on the tab. `listing.md` says TELCOMA Global is a GDPR processor; this change does not alter that.

## Retention and deletion

- Everything in the table is kept while the app is installed, unless the table says otherwise.
- On uninstall: Atlassian deletes the app's Forge storage for that site under Forge's data deletion rules. We keep no copy and have no access to it from outside the app.
- Closed accounts: erased by the weekly personal data report that names them, normally within the hour of that report's call to Atlassian; if a scan, a reclaim, an undo, History's re-check or a protect is running, once it ends.
- On request: running a new scan replaces the list; unprotecting removes a protected entry; uninstalling deletes everything, History included.

## Outside Atlassian

Unchanged by this change. The app makes no requests outside Atlassian (manifest.yml declares no `permissions.external` and no `remotes`). The weekly report goes to Atlassian's own personal data reporting service.

## Logging

- Logs End-User Data: No. The code logs only these lines: from the hourly trigger, "Personal data report:" with whether it ran, the step it reached, the error message if a call failed (an HTTP status or a fixed sentence), and at the end of a report its totals (how many accounts, closed, values changed, skipped); and from the Rovo agent, "agent action failed:" with the status and the endpoint of the call that failed, without what Confluence quoted. No account ID, name or email is logged.
- Shares logs with third parties: No.

## Scope justifications

One line per scope, in manifest.yml order, ready to paste. The first eight are those of the scope table in `listing.md`, with the two rows the 14 Nov audit proposed (`read:content-details:confluence` and `read:confluence-user`) and the per-person admin check of 14 Nov; the last is new.

- `read:content-details:confluence`: List the site's licensed users (`/search/user`, the list Atlassian Administration counts); ask the same list after a reclaim whether the account can still use the site, and just before a reclaim whether the person can administer Confluence.
- `read:confluence-user`: Profiles at display time; a user's groups during a scan and again just before a reclaim; whether the person using the page is a Confluence administrator (every call).
- `read:confluence-groups`: The groups that grant Confluence, by global permission.
- `search:confluence`: Find who contributed recently (CQL), and check each candidate against all content.
- `read:page:confluence`: Version history of a page, to see who edited a page other people also edited.
- `read:blogpost:confluence`: Version history of a blog post, for the same check.
- `write:confluence-groups`: The one write scope: remove a user from a group that grants Confluence (reclaim) and add them back (undo), both as the signed-in site admin after they confirm.
- `storage:app`: Scan progress, the report, the protected list, the reclaim history and the seat price, in Forge hosted storage.
- `report:personal-data`: Report the account IDs the app keeps to Atlassian once a week (privacy.reportPersonalData), so the data of accounts Atlassian reports closed is erased.
