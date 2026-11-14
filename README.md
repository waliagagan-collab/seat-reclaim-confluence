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
| Write the History entry before the first group is left; keep every entry, with no limit | `saveEntry`, `addToIndex` |
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
and that no other module makes write calls. Runs on Atlassian: no egress.

## Storage

Account IDs, group IDs and group names, and inactivity bands. People's names and emails are
never stored; they are looked up at read time. A report row holds the IDs of the person's
groups that grant Confluence, not their other groups. A History entry holds the account
IDs of the person and the approving admin, the groups left (ID and name) and, when
Confluence refused a group change, Confluence's error text. The protected list holds
account IDs.

History keeps every entry. The newest 500 IDs are in `log:index`; older ones move, 250 at a
time, to `log:index:<n>` pages. Entries and report rows written by earlier versions are read
as they are.

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
