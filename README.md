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
Confluence (`GET /wiki/rest/api/user?accountId=…&expand=operations`) whether the account can
still use the site, so it reports what Confluence says rather than what it hoped.

| Rule | Where |
| --- | --- |
| Never remove anyone from an admin group (admin/site-admin permission, or named `*admin*`) | `planReclaim` |
| Never act on the person running the app, or on the protected list | `protectedReasonFor` |
| Re-check activity and re-read the user's groups live before acting; the scan is a snapshot | `reclaim` resolver |
| Only leave groups that actually free the seat | `planReclaim` |
| Confirm with Confluence that the account can no longer use the site | `canUseConfluence` |
| Log exactly which groups were left; undo rejoins exactly those | `saveEntry`, `undo` |
| Group changes run as the signed-in admin (`asUser`), never as the app | `src/lib/reclaim.js` |

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

Account IDs, group IDs and inactivity bands. Names and emails are looked up at read time.
The action log and protected list hold IDs only.

## Commands

```bash
npm test                 # unit tests
npm run deploy           # build the CSV frame and deploy to development
forge install --site one-atlas-afgn.atlassian.net --product confluence --environment development
```

App id `58d99f0c-7d3d-4b5e-be99-4c3cd5e15e0e` (Developer Space TELCOMA Global). Development
page on the demo site:
`/wiki/admin/forge/apps/58d99f0c-7d3d-4b5e-be99-4c3cd5e15e0e/8cf918d8-a5fa-43d6-961a-f9d0458a2798/seat-reclaim-confluence-page`.
