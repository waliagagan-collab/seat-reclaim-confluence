# License Audit for Confluence

Finds licensed Confluence Cloud users who have contributed nothing in a chosen period, so
an admin can reclaim the seats. Read-only: it never removes access and never changes
your site. Sibling of License Audit for Jira (`~/Documents/atlassian-forge-spike`); the
worker, storage, CSV frame and licence gate are the same code.

## The product claim, and how it is kept true

The entire value of a dormant-seat report is that you can **trust the list**. Three rules.

**1. Only things a person DID count, and only inside the window.**

| Signal | Source |
| --- | --- |
| Created a page, blog post, comment, file, whiteboard or database | `history.createdBy` / `createdDate` of recently modified content; `creator = … AND created >= …` per user |
| Edited any of those | `version.by` / `version.when` of recently modified content; `contributor = … AND lastmodified >= …` per user, confirmed against the v2 version history of pages and blog posts |

Content modified recently may have been created years ago by someone else, so the
creator counts only if the creation itself is inside the window. Without that rule a
departed author looks active whenever a colleague touches their old page.

**2. Every candidate is verified against all content, not a sample.** A cheap sweep over
recently modified content proves most users active. Everyone it cannot vouch for gets a
per-user CQL check; when the latest edit on a page was someone else's, the page's version
history decides. A user who touches more content than the check can examine is counted
as active and reported in a warning, so a wrong name never reaches the list.

**3. Seats come from Atlassian's own list.** Confluence has no application-role API and
product access can be granted through any group, so group membership is not a seat count.
The site's user search (`/wiki/rest/api/search/user?cql=type=user`) returns exactly the
accounts that can use the site — verified equal to the **Users** figure for Confluence in
Atlassian Administration on two sites. Apps, deactivated accounts and guests are removed
with a bulk profile check. No configuration, no API key.

The rules live in `src/lib/confluence.js`. It is the single place "active" is defined.

## What Confluence cannot tell an app

- **Viewing.** No API records who read a page. A reader-only user appears dormant. The
  UI, the listing and the docs say so, and point the admin at the last-active date in
  Atlassian Administration as the confirmation step.
- **Logins.** Only the Organizations API has them, behind an org-admin key, and calling
  it would forfeit Runs on Atlassian. Deliberately not done.
- **Version history of comments, attachments, whiteboards, databases.** Comments and
  files are edited by their author or nobody, so the latest version already says who
  acted. Whiteboards and databases have no version API; creation and latest edit count.

## Why the user listing runs as the admin

The site's user search answers the **app** inconsistently: on one test site it returned
nothing to the app while listing every user to the admin; on another it worked. So the
directory phase runs from the resolver (`listUsers`) as the admin who opened the page,
in bounded chunks the frontend calls until `done`. The frontend then hands over to the
background worker, which reads content as the app. The page must stay open for the few
seconds the listing takes; the UI says so. Everything else survives closing the page.

## Architecture

```
globalSettings (UI Kit) ──invoke──> src/index.js  startScan / listUsers (as admin) / getStatus / getPage / getAllRows / diagnose / cancelScan
                                         │ push (after listUsers reports done)
                                         ▼
                             scan-queue ──> src/worker.js   content → verify → finalize
                                            src/lib/confluence.js  all Confluence reads, activity rules, verify probes, self-test
                                            src/lib/store.js       sharded KVS (16 shards), report paging
                                            src/lib/scan.js        pure scan-state rules, licence gate
static/export (Custom UI in a <Frame>)      CSV download — the one thing UI Kit cannot do
```

## Scopes

| Scope | Used for |
| --- | --- |
| `read:content-details:confluence` | `/wiki/rest/api/search/user` — the only scope that endpoint accepts |
| `read:confluence-user` | `/wiki/rest/api/user/bulk` — status, guest flag, name, email |
| `search:confluence` | `/wiki/rest/api/content/search` — sweep and per-user CQL |
| `read:page:confluence`, `read:blogpost:confluence` | `/wiki/api/v2/{pages,blogposts}/{id}/versions` |
| `storage:app` | scan state and report |

Classic and granular scopes together pass `forge lint`. The v1 `/content/{id}/version`
endpoint returns **410** to apps; use v2. Any scope change is a major version:
`forge deploy --approve MAJOR_VERSION_RULE`, then `forge install --upgrade` per site.

## Support features built in

- **Check permissions** button: one cheap call per endpoint the scan needs, each reported
  as ✓ / ✗ with the scope that fixes it. Runs automatically when a scan fails on 401/403.
- Every error names the endpoint that failed, never the query.
- Stuck-scan detection (20 minutes without progress) with a safe restart.

## Deploy

Node 22 (`nvm use`). Registered under the TELCOMA Global developer space; app id in
`manifest.yml`. Install Atlassian's CLI globally (`npm install -g @forge/cli@latest`)
and use the npm scripts, which call it. Never `npx forge`: that is an unrelated package.

```bash
cd ~/Documents/forge-license-audit-confluence && nvm use && npm test && npm run deploy -- -e development
```

Installed for testing on `one-atlas-afgn.atlassian.net` (3 licensed, 3 dormant — matches
the admin hub) and `telcoma.atlassian.net` (1 licensed, 1 active). The page lives under
Confluence administration → Settings → **Apps** → License Audit.

Production: `npm run deploy -- -e production` (Gagan runs this), then the Marketplace
steps in `marketplace/listing.md`.

## Verification status

```bash
npm test       # 31 tests, no network
```

Verified live: user listing equals the admin-hub count on two sites; the scan completes
end to end on both; names and emails resolve at read time; the permission self-test
names a refused endpoint correctly (it caught the 410 on the v1 versions endpoint).

Not yet verified live: the version-history walk (`scanVersions`) on a page edited by
several people inside the window — the test sites have one contributor. Covered by unit
tests; confirm on the first customer-like site.

## Known limits

- Confluence only. Jira activity is not measured.
- Viewing leaves no trace (see above).
- The listing step needs the page open for a few seconds.
- Emails are hidden for users whose profile privacy settings don't share them.
