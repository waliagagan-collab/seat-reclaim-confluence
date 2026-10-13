import { getReportMeta, getProtected, getLatestFor } from './store.js';
import { fetchProfiles } from './confluence.js';
import { planReclaim, reasonText } from './reclaim.js';

/** Who is protected from reclaim, and why. */
export const protectedReasonFor = (accountId, protectedList, me) =>
  accountId === me ? 'self' : protectedList[accountId] ? 'protected' : null;

/**
 * Stored rows carry account IDs only. Names and emails are attached here, at
 * read time, so they are always current and never sit in storage. Each row
 * also gets its reclaim plan from the scan snapshot and the latest action.
 *
 * The plan ignores the protected list on purpose: `isProtected` is reported
 * beside it, so the page can flip protection on one row without reloading
 * everything. The reclaim resolver enforces the list itself.
 */
export async function decorate(rows, context) {
  const [people, meta, protectedList, latest] = await Promise.all([
    fetchProfiles(rows.map((r) => r.accountId)),
    getReportMeta(),
    getProtected(),
    getLatestFor(rows.map((r) => r.accountId)),
  ]);
  const me = context?.accountId;
  const groupsMeta = meta?.groupsMeta ?? {};
  const accessSource = meta?.accessSource ?? 'permissions';
  return rows.map((r) => {
    const plan = planReclaim({
      userGroupIds: r.groups,
      groupsMeta,
      protectedReason: r.accountId === me ? 'self' : null,
    });
    return {
      ...r,
      displayName: people[r.accountId]?.displayName ?? '(unknown)',
      email: people[r.accountId]?.email ?? null,
      reclaimable: plan.reclaimable,
      pending: Boolean(plan.pending),
      reason: reasonText(plan, { accessSource }),
      freedProducts: plan.freedProducts,
      removeGroups: plan.remove.map((g) => g.name),
      isProtected: Boolean(protectedList[r.accountId]),
      lastAction: latest[r.accountId] ?? null,
    };
  });
}
