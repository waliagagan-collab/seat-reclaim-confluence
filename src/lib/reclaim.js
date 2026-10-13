import api, { route } from '@forge/api';
import { fetchUserGroups } from './confluence.js';

/**
 * Reclaiming a Confluence seat means taking the user out of every group that
 * grants Confluence. Which groups those are comes from Confluence itself: its
 * group list can be filtered by the global permission a group holds, and a
 * group with "Can use", Confluence admin or site admin permission gives its
 * members a seat (see fetchAccessGroups in confluence.js). Everything about
 * WHICH groups to leave, and what that frees, is decided by the pure functions
 * at the top of this file, so the rules can be tested without a site.
 *
 * Hard rules:
 *   - Never touch an admin group. Removing someone from site-admins or a
 *     Confluence admin group takes away their admin role, which is not this
 *     app's job, and Atlassian requires admins to lose that role before
 *     product access can be removed anyway.
 *   - Never touch the person running the app, or anyone on the protected list.
 *   - Always read the user's groups live before acting. The scan is a snapshot.
 *   - Record exactly which groups were left, so undo puts the user back in the
 *     same groups and nothing else.
 *   - After acting, ask Confluence whether the account can still use the site,
 *     so the app never claims a seat is free when it is not.
 */

export const PRODUCT = 'Confluence';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Groups named like an admin group are never removed, whatever Confluence says about them. */
export const isAdminGroupName = (name) => /admin/i.test(String(name ?? ''));

/** A group is an admin group if Confluence grants it admin or site-admin permission, or if it is named like one. */
export const isAdminGroup = (g) => Boolean(g?.admin) || isAdminGroupName(g?.name);

/**
 * Pure. Given the groups a user is in right now, decide what reclaiming does.
 *
 * Returns:
 *   reclaimable    - true when at least one product seat would be freed
 *   reason         - why not, when not reclaimable (or 'groups-unknown' when
 *                    the scan could not read the groups and the reclaim step
 *                    will read them live)
 *   remove         - access groups to leave: [{ groupId, name, products }]
 *   freedProducts  - products the user loses access to
 *   keptProducts   - products the user keeps, and the admin group that keeps them
 */
export function planReclaim({ userGroupIds, groupsMeta, protectedReason = null }) {
  if (protectedReason) {
    return { reclaimable: false, reason: protectedReason, remove: [], freedProducts: [], keptProducts: [] };
  }
  // No group map at all means the app could not read which groups grant
  // Confluence: it has nothing to plan from, which is not the same as the
  // user holding no access group.
  if (!groupsMeta || Object.keys(groupsMeta).length === 0) {
    return { reclaimable: false, reason: 'no-role-data', remove: [], freedProducts: [], keptProducts: [] };
  }
  // The scan could not read this person's groups (it happens when the app
  // lacks a permission it gets at reclaim time, as the admin). The reclaim
  // step reads the groups live and plans again, so the person stays selectable.
  if (userGroupIds === null || userGroupIds === undefined) {
    return { reclaimable: true, reason: 'groups-unknown', remove: [], freedProducts: [PRODUCT], keptProducts: [], pending: true };
  }

  const remove = [];
  const keptVia = new Map(); // product -> admin group name that keeps it
  for (const id of new Set(userGroupIds)) {
    const g = groupsMeta?.[id];
    if (!g) continue; // not an access group, so leaving it frees nothing
    const products = g.products?.length ? g.products : [PRODUCT];
    if (isAdminGroup(g)) {
      for (const p of products) if (!keptVia.has(p)) keptVia.set(p, g.name);
    } else {
      remove.push({ groupId: id, name: g.name, products: [...products] });
    }
  }

  const removedProducts = new Set(remove.flatMap((g) => g.products));
  const freedProducts = [...removedProducts].filter((p) => !keptVia.has(p)).sort();
  const keptProducts = [...keptVia.entries()]
    .map(([product, via]) => ({ product, via }))
    .sort((a, b) => a.product.localeCompare(b.product));

  if (freedProducts.length === 0) {
    return {
      reclaimable: false,
      reason: keptVia.size ? 'admin' : 'no-access-groups',
      remove: [],
      freedProducts: [],
      keptProducts,
    };
  }

  // Leaving a group that only grants kept products would change nothing, so
  // only the groups that actually free something are removed.
  const useful = remove.filter((g) => g.products.some((p) => freedProducts.includes(p)));
  return { reclaimable: true, reason: null, remove: useful, freedProducts, keptProducts };
}

/** Pure: why a row can't be reclaimed (or what is still pending), in words an admin can act on. */
export function reasonText(plan, { accessSource = 'permissions' } = {}) {
  if (!plan) return null;
  if (plan.reclaimable && plan.reason !== 'groups-unknown') return null;
  if (plan.reason === 'no-access-groups' && accessSource === 'names') {
    return "Not in any of the standard groups that grant Confluence. This site's group permissions couldn't be read, so groups are recognised by name; if their access comes from a custom group, remove them from it in Atlassian Administration.";
  }
  switch (plan.reason) {
    case 'self':
      return 'This is you. The app never removes the person running it.';
    case 'protected':
      return 'On your protected list.';
    case 'admin': {
      const via = [...new Set((plan.keptProducts ?? []).map((k) => k.via))].join(', ');
      return `Access comes from an admin group (${via}). Remove their admin role in Atlassian Administration first.`;
    }
    case 'no-access-groups':
      return "Not in any group that grants Confluence. Their seat may already be free, or their access comes from a group the app can't see — check Atlassian Administration.";
    case 'no-role-data':
      return "The app couldn't read which groups grant Confluence during the scan, so it can't plan a reclaim. Reinstalling the app usually restores that permission; then run a new scan.";
    case 'groups-unknown':
      return "This person's groups weren't readable during the scan. They are read live when you reclaim.";
    case 'active-since-scan':
      return 'Has contributed to Confluence since the scan, so their seat was left alone. Run a new scan for a current list.';
    case 'unconfirmed-activity':
      return 'Could not confirm this person is still inactive (they contribute to more content than the check can examine), so their seat was left alone.';
    default:
      return 'Cannot be reclaimed.';
  }
}

/** Pure: every message Confluence put in an error body, as one string. */
const errorText = (body) =>
  [
    ...(body?.errorMessages ?? []),
    ...Object.values(body?.errors ?? {}),
    body?.message,
    body?.detail,
    body?.reason,
    body?.data?.errors?.map?.((e) => e?.message?.translation ?? e?.message)?.join(' '),
  ]
    .filter((m) => typeof m === 'string' && m)
    .join(' ');

export const IDP_MANAGED_MESSAGE =
  "This group is managed by your identity provider (for example Okta or Microsoft Entra ID), so Confluence won't change it here. Remove the user from the group in your identity provider instead.";

/**
 * Pure: is this the refusal Confluence gives for a group synced from an
 * identity provider? Those groups are read-only in Atlassian.
 */
export const isIdpManaged = (status, body) =>
  (status === 400 || status === 403) &&
  /not modifiable|identity provider|scim|externally managed|read[- ]?only|managed by/i.test(errorText(body));

/** Pure: words for a failed Confluence call during reclaim or undo. */
export function explainChange(status, body) {
  if (isIdpManaged(status, body)) return IDP_MANAGED_MESSAGE;
  const text = errorText(body);
  const detail = text ? ` (${text})` : '';
  if (status === 403 || status === 401) {
    return `Confluence refused (${status}). Only site admins can change group membership. Ask a site admin to run this.${detail}`;
  }
  if (status === 404) return `Group or user not found (404). It may have been deleted.${detail}`;
  return `Confluence returned ${status}.${detail}`;
}

/**
 * Pure: a group-membership POST that says the user is already in the group
 * counts as restored.
 */
export const alreadyMember = (status, body) => (status === 400 || status === 409) && /already/i.test(errorText(body));

/** Pure: the products a set of group changes actually freed (only groups that were left count). */
export function freedProductsFrom(changes, keptProducts = []) {
  const kept = new Set((keptProducts ?? []).map((k) => k.product));
  const freed = new Set((changes ?? []).filter((c) => c.ok).flatMap((c) => c.products ?? []));
  return [...freed].filter((p) => !kept.has(p)).sort();
}

export const NO_REPLY_MESSAGE =
  "Confluence did not answer. The change may or may not have gone through; check the person's groups in Atlassian Administration before trying again.";

// ---------------------------------------------------------------------------
// Side effects (all as the signed-in admin)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function bodyOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The user's groups right now, read as the admin: [{ id, name }]. Throws with a clear message. */
export const fetchUserGroupsLive = (accountId) => fetchUserGroups(accountId, { asUser: true });

/** Remove one user from the planned groups. Returns per-group results. */
export async function removeFromGroups(accountId, groups) {
  const results = [];
  for (const g of groups) {
    let res;
    try {
      res = await api
        .asUser()
        .requestConfluence(route`/wiki/rest/api/group/userByGroupId?groupId=${g.groupId}&accountId=${accountId}`, {
          method: 'DELETE',
          headers: JSON_HEADERS,
        });
    } catch {
      // No response at all. The removal may have happened, so it is recorded
      // as unknown: undo re-adds it, and the admin is told to check.
      results.push({ groupId: g.groupId, name: g.name, products: g.products, ok: false, unknown: true, error: NO_REPLY_MESSAGE });
      continue;
    }
    const ok = res.ok;
    results.push({
      groupId: g.groupId,
      name: g.name,
      products: g.products,
      ok,
      error: ok ? null : explainChange(res.status, await bodyOf(res)),
    });
  }
  return results;
}

/** Put one user back in the groups a reclaim removed. Returns per-group results. */
export async function addToGroups(accountId, groups) {
  const results = [];
  for (const g of groups) {
    let res;
    try {
      res = await api
        .asUser()
        .requestConfluence(route`/wiki/rest/api/group/userByGroupId?groupId=${g.groupId}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ accountId }),
        });
    } catch {
      results.push({ groupId: g.groupId, name: g.name, ok: false, unknown: true, error: NO_REPLY_MESSAGE });
      continue;
    }
    const body = res.ok ? null : await bodyOf(res);
    const ok = res.ok || alreadyMember(res.status, body);
    results.push({ groupId: g.groupId, name: g.name, ok, error: ok ? null : explainChange(res.status, body) });
  }
  return results;
}
