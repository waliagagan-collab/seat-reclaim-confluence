# Seat Reclaim for Confluence

Finds licensed Confluence Cloud users who have contributed nothing in a chosen period, then
frees their seats safely: the admin reviews the list, confirms, and the app takes each
person out of the groups that grant Confluence. Every change is logged and can be undone.

It reuses the activity engine from License Audit for Confluence (same rules for what counts
as a contribution, same exhaustive per-user check) and the reclaim layer from Seat Reclaim
for Jira. See `src/lib/confluence.js` and `src/lib/reclaim.js`.

## How a seat is reclaimed

Confluence has no application-role API, but its group list can be filtered by the global
permission a group holds: `GET /wiki/rest/api/group?accessType=user|admin|site-admin`.
Members of any of those groups hold a seat. The app reads that list as the admin at scan
time and again at reclaim time, removes the user from the non-admin groups, and then asks
Confluence whether the account can still use the site, so it reports what Confluence says
rather than what it hoped.

After each reclaim the app asks the site's user directory
(`GET /wiki/rest/api/search/user?cql=type=user and user.accountid=...&expand=operations`,
retried for a few seconds) whether the account still holds a seat, because
`/wiki/rest/api/user?expand=operations` keeps reporting access after it is gone.

| Rule | Where |
| --- | --- |
| Never reclaim a Confluence administrator: anyone in a group that Confluence gives admin or site-admin permission, or in a group that grants Confluence and has "admin" in its name (`/admin/i`), is left alone | `planReclaim` |
| Just before each reclaim, ask Confluence whether the person can administer it (the user search with `expand=operations` lists the operations of the person looked up, checked live on 14 Nov 2026). Anyone who can is left alone and their row is marked Can't reclaim; no answer means no change | `administersConfluence`, `reclaim` resolver |
| Never act on the person running the app, or on the protected list | `protectedReasonFor` |
| Act only on accounts on the current list | `getReportedIds`, `reclaim` resolver |
| Re-check activity and re-read the user's groups live before acting; the scan is a snapshot | `reclaim` resolver |
| Only leave groups that grant Confluence | `planReclaim` |
| Confirm with Confluence that the account can no longer use the site | `canUseConfluence` |
| Write the History entry before the first group is left; keep every entry, with no limit (the weekly personal data report removes only entries about closed accounts) | `saveEntry`, `addToIndex` |
| Log exactly which groups were left; undo rejoins exactly those | `saveEntry`, `undo` |
| Group changes run as the signed-in admin (`asUser`), never as the app | `src/lib/reclaim.js` |

The name rule is wide on purpose. It also matches `badminton-club` if that group grants
Confluence. For an app that removes access, a wrong "can't reclaim" is the safe mistake.

Leaving a group also removes anything else that group grants (another product, space
permissions). The confirm dialog says so.

A reclaim that changes nothing (every group refused) leaves no History entry. The reason is
kept on the person's row instead. A group managed by an identity provider refuses every
time, so that row is marked "Can't reclaim".

Someone who contributed to a whiteboard or database that another person changed last is
counted as active: apps cannot read who edited those, so the app does not guess. The same
goes for a page that is gone (404) when its version history is read: the scan carries on and
that person is counted as active. Any other refusal on a history read still fails the scan
with Confluence's message.

A reclaim that got no answer shows as "Interrupted". The row, the export and the Rovo agent
all treat that person as not ready until History has been checked (Undo there puts back every
group that was planned).

The check sees only content the app can see. If a site blocks apps from a space, work done
only in that space is not seen, and the "How it works" panel says so.

Confluence requires a **site admin** for group membership changes. A Confluence admin who is
not a site admin can scan and review, and gets a clear message if they try to reclaim.

If a site's group list cannot be filtered by permission, the standard groups
(`confluence-users-*`, `confluence-admins-*`, `site-admins`, `org-admins`, `administrators`)
are recognised by name and the page says so.

## Permissions

Read scopes as License Audit for Confluence, plus `read:confluence-groups` (the group list)
and one write scope, `write:confluence-groups`, used only for `DELETE` and
`POST /wiki/rest/api/group/userByGroupId`. A test enforces that this is the only write scope
and that no other module makes write calls. The one other scope, `report:personal-data`
(added 14 November 2026), only sends Atlassian the account IDs the app keeps (see "Personal
data reporting" below). Runs on Atlassian: no egress.

## Storage

Account IDs, group IDs and group names, and inactivity bands. People's names and emails are
never stored; they are looked up at read time. A report row holds the IDs of the person's
groups that grant Confluence, not their other groups. A History entry holds the account
IDs of the person, the approving admin and the admin who undid it, the groups left (ID and
name) and, when Confluence refused a group change, Confluence's error text. The protected
list holds the account IDs of each protected person and of the admin who protected them.
The latest action on each person (or why the last try changed nothing, which can be
Confluence's error text) is kept by account ID, to mark their row. The scan state and the
list's warnings can hold Confluence's error text from a scan. The account IDs are reported
to Atlassian once a week, and those of closed accounts are erased (see "Personal data
reporting" below).

History keeps every entry, except an entry about a person whose Atlassian account was
closed. The newest 500 IDs are in `log:index`; older ones move, 250 at a time, to
`log:index:<n>` pages. `log:index:meta` counts the pages, and keeps each page's size once one
holds fewer than 250. Entries and report rows written by earlier versions are read as they
are.

## Personal data reporting

Atlassian asks every app that keeps account IDs to report them, so it can say which
accounts were closed. This app does it with Forge's `privacy.reportPersonalData`, which
needs the scope `report:personal-data` (added 14 November 2026; it makes the next
production deploy a major version).

**When.** An hourly scheduled trigger (`personal-data-report`) runs one slice of the
report, at most 40 seconds, or nothing when this week's report is done. A new report
starts 7 days after the last report call of the one before, so no account is reported
more often than once in 7 days. It runs whatever the licence says. On most sites a
report is done in one run.

**What is reported.** Every account ID the app keeps, 90 per call:

| Stored value | Account IDs in it |
| --- | --- |
| `report:ids:{s}` and `report:dormant:{i}`, the last list | each inactive user |
| `report:meta`, the list's totals | any account ID quoted in a Confluence error text kept in a warning |
| `scan:state`, the scan in progress or the last one | any account ID quoted in a Confluence error text it kept (the error, the pause reason, the warnings); it names nobody itself |
| `scan:{run}:users:{s}`, `:active:{s}`, `:dormant:{s}`, working data of a scan | every licensed user, those seen contributing, the inactive rows so far |
| `protected`, the protected list | each protected person, and the admin who protected them |
| `log:entry:{id}`, a History entry | the person reclaimed, the admin who approved it and the admin who undid it; any account ID in Confluence's error texts |
| `log:latest:{s}`, the latest action on each person | each person reclaimed or tried; any account ID in Confluence's error text |

History's index (`log:index`, `log:index:{n}`, `log:index:meta`: entry IDs and counts only),
`action:started` (when a reclaim, an undo, History's re-check or a protect last started, a
time only), `settings` (the seat price, the day the review request was closed) and the queue
events (a run ID and a number) hold no account ID. `test/personal-data.test.js` checks this
list against every key `src/lib/store.js` defines.

**What is erased for a closed account.**

- Its row on the list and its place in `report:ids` are taken out, so it can no longer be
  reclaimed. Nothing is put in its place: the list is not signed evidence, and every scan
  builds it again.
- Every History entry about the person is deleted, after its ID is taken out of History's
  index and archive pages. Undo could only give a closed account its groups back. History
  still pages through every other entry, 25 at a time.
- Their protected-list entry and the latest-action note on their row are taken out.
- Where the closed account is the admin who approved or undid a reclaim, `by` or
  `restoredBy` in the entry becomes empty (null), and History and the Rovo agent show
  "Closed account". Where it protected someone, that protected entry's `by` becomes empty.
- In a Confluence error text (in History, on a row, in the scan state or in a warning of the
  list) the account ID becomes "(closed account)".
- It is taken out of the working data of a scan.
- The totals already shown (licensed, active and inactive users, the yearly cost) stay as
  the scan counted them. **The next scan counts again.** Until then the page, the download
  and the Rovo agent say how many users on the list are no longer listed because their
  accounts were closed.

The per-person admin check before a reclaim (`administersConfluence`) is not affected: it
asks Confluence live each time, and a row it marked "Can't reclaim" keeps its note unless
that person's own account was closed.

**While the app is writing.** A scan writes the list and its working data; a reclaim, an
undo, History's re-check of recent entries and a change to the protected list each write
from what they read a moment before. So erasing waits while a scan is running and has
moved in the last 20 minutes, and for a minute after a reclaim, an undo, a re-check or a
protect starts (each is one resolver call, which Forge stops after 25 seconds; each notes
when it started in `action:started`). The report asks before each value it changes (`busy`
in `src/lib/personal-data.js`), and the value is read again just before it is written. A
scan that has not moved for 20 minutes (stopped, or paused with nobody on the page) does not
hold erasing back; if it goes on later it finds fewer users to count.

The report's own working values (`pdr:state`, `pdr:lock`, and the gathered, closed and
changed IDs under `pdr:ids:`, `pdr:closed:` and `pdr:updated:`) are deleted when a report
ends, except the state with the totals of the last report. The log line of each run names
the step and, at the end, the totals; never an account ID.

`test/privacy.test.js` is the shared report engine's own test, copied with it.
`test/personal-data.test.js` lists every key the app writes and fails if one holds an
account ID no source reads; it runs scans, reclaims, undos, refusals, the admin check and
weekly reports on the fake site: every account ID written is found, closed accounts are
erased and nobody else is touched, History still pages after an entry in the middle goes,
erasing waits for a scan, a reclaim, an undo, a protect or a re-check, and the page, the
download, History and the agent still work afterwards.

## Large sites

Listing the users runs from the page, as the admin. After that the scan runs in slices on
the Forge queue. Each slice works for up to 220 seconds (the function is allowed 300) and
then queues the next. Forge stops a chain after 1,000 queued events. If a push is refused,
for that or any other reason, the scan is marked paused with its cursor saved, and the
page's status poll queues the next slice. A paused scan continues while the page is open.

## Commands

```bash
npm test                 # unit tests
npm run deploy           # build the CSV frame and deploy to development
forge install --site one-atlas-afgn.atlassian.net --product confluence --environment development
```

App id `58d99f0c-7d3d-4b5e-be99-4c3cd5e15e0e` (Developer Space TELCOMA Global). Development
page on the demo site:
`/wiki/admin/forge/apps/58d99f0c-7d3d-4b5e-be99-4c3cd5e15e0e/8cf918d8-a5fa-43d6-961a-f9d0458a2798/seat-reclaim-confluence-page`.
