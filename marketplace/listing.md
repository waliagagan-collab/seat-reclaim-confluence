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

Finds licensed Confluence users who created or edited nothing for 30 to 365 days, checked against every page, and frees their seats after you confirm by taking them out of the groups that grant Confluence. Admins are never touched; every change can be undone.

## Categories and keywords

- Categories: Administrative tools; Data and analytics
- Keywords: Audit, User permissions, Compliance, Reporting

## More details (250–1000)

**Every Confluence seat you pay for should belong to someone who uses Confluence.**

Seat Reclaim lists the licensed users who **created or edited nothing** in a period you choose (no page, blog post, comment or file) and frees their seats after you confirm.

- Which groups grant Confluence comes from Confluence itself, not from a setting you have to get right.
- Each user shows the groups a reclaim would remove, or why it can't: admin groups, you, and your protected list are never touched.
- Select users, check the summary, confirm. Activity and groups are re-checked live first, and Confluence confirms each seat is free.
- History logs every change; Undo restores exactly the groups removed.

Confluence doesn't record who reads a page, so the list shows contributors only; check last-active dates in Atlassian Administration if in doubt.

**Nothing to set up.** No API key. Accounts stay active and pages keep their author. **Runs on Atlassian;** no servers of ours.

## Highlights (title ≤ 50, description ≤ 220)

1. **Free seats, confirmed by Confluence** — Select inactive users, confirm, and the app removes them from the groups that grant Confluence, then asks Confluence to confirm each seat is free.
2. **Check every change before it happens** — A summary lists the groups each person leaves. Activity and groups are re-checked live first. Admins, you and anyone you protect are never touched.
3. **Undo any reclaim** — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups.

## Version step

- Release summary: First release: find inactive Confluence users and free their seats, with undo
- Release notes: Finds licensed Confluence users with no contribution in a period you choose, checked against every page and blog post, and frees their seats after you confirm by taking them out of the groups that grant Confluence. Admin groups, the person running it and protected users are never reclaimed. Confluence confirms each freed seat. History logs every change and Undo restores exactly the groups removed. Includes a read-only Rovo agent.
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
