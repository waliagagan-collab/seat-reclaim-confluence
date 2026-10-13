# Marketplace listing — License Audit for Confluence

Draft copy for the Atlassian Marketplace listing. Same rules as the Jira listing: the
name trails the product ("… for Confluence"), the description promises only what the
app does, and the scope justification is written the way the reviewer reads it.
Field limits learned from the Jira submission: tagline ≤ 130 characters with no trailing
punctuation, summary ≤ 250, "More details" 250–1000, release summary ≤ 80.

---

## Live listing text (as published 2026-10-11)

The sections further down are the original drafts. This is what the Marketplace shows now.

- **Tagline:** Find inactive Confluence users who still hold a paid seat, see what they cost, and export the list to CSV or Excel
- **Summary:** Lists inactive users on your Confluence Cloud site: licensed users who created or edited nothing for 30 to 365 days, how long each has been inactive, and what those unused seats cost a year. Checked against all content. Read-only.
- **Release summary (2.4.0):** Yearly cost of inactive seats, search and filters, Excel export
- **Release notes (2.4.0):** The page now leads with what inactive seats cost a year: enter the yearly price of one seat and it is saved for the site. Search by name or email and filter by inactivity across the whole list. A progress bar shows while a scan runs. Download the list as Excel as well as CSV.

- **Highlight 2 now ends:** "…Download the full list as CSV or Excel. Or just ask the app's Rovo agent."
- **Release summary (2.5.0):** Rovo agent: ask about unused seats, cost and inactive users
- **Release notes (2.5.0):** Adds a Rovo agent, License Audit for Confluence. In Confluence, open Ask Rovo and choose it to ask how many seats are unused, what they cost a year, and who has contributed nothing, filtered by inactivity or name. It only reads the latest audit report and only answers Confluence admins. No new permissions.

**More details (988 characters):**

**Every Confluence seat you pay for should belong to someone who uses Confluence.**

License Audit lists the licensed users on your site who contributed nothing in a period you choose — no page, blog post, comment or file created or edited — and how long each has been inactive.

**Numbers you can act on.** The licensed-user count is the figure Atlassian Administration shows. Enter what one seat costs to see what inactive seats cost a year. Search and filter the list, and download it as CSV or Excel.

**Numbers you can trust.** A fast sweep of recent content proves most users active; everyone else is verified against all content on the site, including the edit history of pages other people touched.

**Nothing to set up, nothing at risk.** No API key, no organisation token, no settings page. The app holds no write permission, so Confluence itself prevents it from removing anyone's access. It reads, and you decide.

**Runs on Atlassian.** No servers of ours; only account IDs and your seat price are stored.

---

## Name

**License Audit for Confluence**

## Tagline (≤ 130 characters, no trailing punctuation)

Find licensed Confluence users who have contributed nothing for 30–365 days. Zero setup, read-only

## Summary (≤ 250 characters)

Lists the licensed users on your Confluence Cloud site who created or edited nothing in a period you choose, with a dormancy band and CSV download. Installs in one click, needs no API key, and can never change your site.

## Categories

- Admin tools
- Reports

## Keywords

license, licence, inactive users, dormant users, seat optimization, user audit, cost savings, admin, cleanup, confluence users

---

## Description ("More details", 250–1000 characters)

**Every Confluence seat you pay for should belong to someone who uses Confluence.**

License Audit lists the licensed users on your site who contributed nothing in a period you choose — no page, blog post, comment or file created or edited — and how long each has been dormant.

**Numbers you can act on.** The licensed-user count is the figure Atlassian Administration shows. Each dormant user carries a dormancy band and email, sorted longest-dormant first, with CSV download and a saving estimate.

**Numbers you can trust.** A fast sweep of recent content proves most users active; everyone else is verified against all content on the site, including the edit history of pages other people touched.

**Nothing to set up, nothing at risk.** No API key, no organisation token, no settings page. The app holds no write permission, so Confluence itself prevents it from removing anyone's access. It reads, and you decide.

**Runs on Atlassian.** No servers of ours; only account IDs are stored.

## Highlights (three, each with a screenshot)

Screenshots: `assets/2026-10-11/highlight-1-cost.png`, `highlight-2-list.png`, `highlight-3-rules.png`.

**1. See what unused seats cost you**
The licensed-user figure matches Atlassian Administration. Enter what one seat costs
you per year and the page leads with the total: inactive seats and about what they
cost a year.

**2. Find anyone, export everyone**
Search by name or email and filter by how long someone has been inactive: 90–180
days, 180–365 days, over a year or never. Download the full list as CSV or Excel.

**3. Trust the list**
Every candidate is verified against all content on the site, including the edit history
of pages other people changed. The rule for what counts as a contribution is stated in
the app, above the results — including what Confluence cannot see.

---

## Scope justification (entered at submission)

| Scope | Why the app needs it |
| --- | --- |
| `read:content-details:confluence` | List the accounts that can use this Confluence site (the site's user search). This is the only scope that endpoint accepts, and it is the list that matches Atlassian's own licensed-user count. |
| `read:confluence-user` | Read each account's status and guest flag, so deactivated accounts and guests (who hold no licence) are left out; read display name and email at report time. |
| `search:confluence` | Search recently modified pages, blog posts, comments and files for who last edited and created them, and run the per-user verification queries. No page text is read. |
| `read:page:confluence` | Read the version history of a page (author and time of each version) when the latest edit was made by someone else. |
| `read:blogpost:confluence` | The same, for blog posts. |
| `storage:app` | Persist scan progress and the finished report in Forge's Atlassian-hosted storage so scans survive the admin closing the page. |

**Egress:** none. The app makes no requests outside Atlassian. No remote hostnames.

**Data stored:** account IDs and dormancy bands derived by the app — nothing else. Display
names and email addresses are never stored; they are looked up from Confluence when the
report is viewed or exported. No page content, comment text or attachments are ever read
or stored. All stored data is regenerated by every scan and deleted when the app is
uninstalled.

**Stores personal data:** No (account IDs only).

---

## Version step

- Release summary (≤ 80): `First public release: dormant-seat report for Confluence Cloud with CSV download`
- Release notes: Lists licensed users with no Confluence contribution in 30, 60, 90, 180
  or 365 days, verified against all content on the site. Licensed-user count matches
  Atlassian Administration. Dormancy bands, email, CSV download, annual-saving estimate.
  Read-only; no API key or setup. Runs on Atlassian.
- License: Commercial · App version supported: Yes · Standard EULA: Yes
- Documentation URL: `https://www.telcomaglobal.com/p/confluence-license-audit-docs`
- Support: `https://www.telcomaglobal.com/p/license-audit-support` / `support@telcomaglobal.com`
- SLA: `https://www.telcomaglobal.com/p/atlassian-support-sla`
- Privacy policy: `https://www.telcomaglobal.com/p/confluence-license-audit-privacy`

## Pricing

Same as the Jira app: Custom pricing, $7 flat up to 10 users, $0.70 per user per month
at 1–100, scaling down; single = multi-instance; free tier off.

## Marketing assets

- Logo: reuse the nine-seat mark with a distinct accent colour from the Jira app.
- Banner: 1120×548 (hero 1920×1200 for the page design step).
- Highlight screenshots: `assets/2026-10-11/highlight-1-cost.png`, `-2-list.png`, `-3-rules.png` (1840×900), taken 2026-10-11 from the demo site with a sample seat price; personal names and emails blurred. The older `assets/highlight-1..3-*.png` show the previous page.
