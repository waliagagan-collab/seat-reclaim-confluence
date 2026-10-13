import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  getScanState,
  setScanState,
  getReportMeta,
  getReportPage,
  getAllReportRows,
  clearRun,
  upsertUsers,
  getSettings,
  saveSettings,
  getProtected,
  setProtected,
  newEntryId,
  saveEntry,
  getEntry,
  getLogPage,
} from './lib/store.js';
import {
  fetchProfiles,
  fetchUserPage,
  diagnose,
  fetchAccessGroups,
  canUseConfluence,
  countLicensedUsers,
  wasActiveWithin,
} from './lib/confluence.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import { normaliseSeatCosts } from './lib/ui.js';
import { decorate, protectedReasonFor } from './lib/decorate.js';
import { planReclaim, reasonText, fetchUserGroupsLive, removeFromGroups, addToGroups } from './lib/reclaim.js';

// Forge bundles this ESM file with webpack, and the CommonJS `@forge/resolver`
// arrives as a namespace object rather than the class. Take the default when
// one is present, so this works under either interop.
const Resolver = ResolverModule?.default ?? ResolverModule;

const resolver = new Resolver();

// Every resolver is admin-only. Defining through this helper means a new
// resolver can't be added without the check.
const define = (key, fn) => resolver.define(key, adminOnly(fn));
const queue = new Queue({ key: 'scan-queue' });

const EXPORT_LIMIT = 5000;
// A resolver call has a hard time limit, so reclaim runs in small batches and
// the page loops. Each user costs a few reads plus one call per group.
export const RECLAIM_BATCH = 5;

export const ACCESS_GROUPS_BY_NAME_WARNING =
  "Confluence didn't let the app filter groups by permission, so the standard access groups were recognised by name. If your site grants Confluence through other groups, those users will show as can't reclaim.";
export const ACCESS_GROUPS_UNREADABLE_WARNING =
  'The app could not read which groups grant Confluence, so it cannot plan any reclaim from this scan. Reinstalling the app usually restores that permission.';

const licenseRefusal = (context) => {
  const gate = licenseGate(context?.license, context?.environmentType);
  return gate.allowed
    ? null
    : { ok: false, unlicensed: true, error: licenseMessage(gate, context?.license) };
};

// --- scan ---------------------------------------------------------------------

define('startScan', async ({ payload, context }) => {
  // The frontend gates too, but a resolver can be invoked directly, so the
  // paid-app check is enforced here as well. Non-production is never blocked.
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const days = normaliseDays(payload?.days);

  const existing = await getScanState();
  if (existing?.status === 'running' && !isStale(existing)) {
    return { ok: false, error: 'A scan is already running.' };
  }

  // Scratch shards from an earlier run (cancelled, failed or stale) are not
  // needed once a new run starts.
  if (existing?.run) await clearRun(existing.run);

  // Which groups grant Confluence, read as the admin. Reclaim plans are built
  // from this, and the reclaim step reads it again live.
  const warnings = [];
  let groupsMeta = {};
  let accessSource = 'none';
  try {
    const access = await fetchAccessGroups({ asUser: true });
    groupsMeta = access.groupsMeta;
    accessSource = access.source;
    if (accessSource === 'names') warnings.push(ACCESS_GROUPS_BY_NAME_WARNING);
    if (!Object.keys(groupsMeta).length) warnings.push(ACCESS_GROUPS_UNREADABLE_WARNING);
  } catch (err) {
    warnings.push(`${ACCESS_GROUPS_UNREADABLE_WARNING} (${err?.message ?? err})`);
  }

  const state = {
    run: `${Date.now()}`,
    status: 'running',
    phase: 'directory',
    days,
    groupsMeta,
    accessSource,
    directoryCursor: 0,
    usersFound: 0,
    guests: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    warnings,
  };
  await setScanState(state);
  // The frontend now calls listUsers until it reports done; that call pushes
  // the first queue event. Nothing runs in the background before then.
  return { ok: true, state };
});

const LIST_PAGES_PER_CALL = 6; // 1,200 users per invoke, well inside the resolver budget
const LIST_BUDGET_MS = 14_000;

/**
 * The directory phase, as the admin. The site's user search is the one list
 * that matches the "Users" figure in Atlassian Administration, and it answers
 * reliably only for a real user, so it cannot run in the worker. Each call
 * does a bounded number of pages and returns; the frontend calls again until
 * `done`, then the background worker takes over.
 */
define('listUsers', async ({ payload }) => {
  const state = await getScanState();
  if (!state || state.status !== 'running' || state.run !== payload?.run) {
    return { ok: false, done: true, error: 'That scan is no longer running.' };
  }
  if (state.phase !== 'directory') return { ok: true, done: true, usersFound: state.usersFound ?? 0 };

  const t0 = Date.now();
  let start = state.directoryCursor ?? 0;
  let guests = state.guests ?? 0;
  let isLast = false;
  const collected = [];
  try {
    for (let i = 0; i < LIST_PAGES_PER_CALL && Date.now() - t0 < LIST_BUDGET_MS; i++) {
      const page = await fetchUserPage(start);
      const profiles = await fetchProfiles(page.users.map((x) => x.accountId));
      for (const x of page.users) {
        const p = profiles[x.accountId];
        if (p?.guest) {
          guests += 1;
          continue;
        }
        if (p && p.active === false) continue;
        collected.push({ accountId: x.accountId });
      }
      start = page.nextStart;
      if (page.isLast) {
        isLast = true;
        break;
      }
    }
    if (collected.length) await upsertUsers(state.run, collected);
  } catch (err) {
    const fresh = await getScanState();
    if (fresh?.run === state.run) {
      await setScanState({ ...fresh, status: 'failed', error: String(err?.message ?? err), finishedAt: new Date().toISOString() });
      await clearRun(state.run);
    }
    return { ok: false, done: true, error: String(err?.message ?? err) };
  }

  // Re-read before committing: a cancel that landed meanwhile must win.
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') {
    return { ok: false, done: true, error: 'The scan was cancelled.' };
  }
  const usersFound = (fresh.usersFound ?? 0) + collected.length;
  const next = {
    ...fresh,
    directoryCursor: start,
    usersFound,
    guests,
    ...(isLast ? { phase: 'content', contentCursor: null, contentPages: 0, itemsScanned: 0 } : {}),
  };
  await setScanState(next);

  if (isLast) {
    // If the push fails the worker will never run, so the state must not be
    // left saying "running" — that showed an admin a spinner for 20 minutes
    // with no work happening behind it.
    try {
      await queue.push({ body: { run: state.run } });
    } catch (err) {
      await setScanState({
        ...next,
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: `Could not queue the scan: ${err?.message ?? err}`,
      });
      await clearRun(state.run);
      return { ok: false, done: true, error: 'Could not start the background scan. Please try again.' };
    }
  }
  return { ok: true, done: isLast, usersFound, nextStart: start };
});

define('getStatus', async () => {
  const [state, report] = await Promise.all([getScanState(), getReportMeta()]);
  return { ok: true, state: state ?? null, stale: isStale(state), report: report ?? null };
});

define('getPage', async ({ payload, context }) => {
  const index = Math.max(0, Number(payload?.index) || 0);
  return { ok: true, index, rows: await decorate(await getReportPage(index), context) };
});

define('getAllRows', async ({ context }) => ({
  ok: true,
  rows: await decorate(await getAllReportRows(EXPORT_LIMIT), context),
  limit: EXPORT_LIMIT,
}));

define('diagnose', async () => ({ ok: true, checks: await diagnose() }));

define('cancelScan', async () => {
  const state = await getScanState();
  if (state?.status === 'running') {
    await setScanState({ ...state, status: 'cancelled', finishedAt: new Date().toISOString() });
    await clearRun(state.run);
  }
  return { ok: true };
});

// --- settings -------------------------------------------------------------------

define('getSettings', async () => ({ ok: true, settings: await getSettings() }));

define('saveSettings', async ({ payload }) => {
  const current = await getSettings();
  const settings = { ...current, seatCosts: normaliseSeatCosts(payload?.seatCosts) };
  return { ok: true, settings: await saveSettings(settings) };
});

// The review request is shown once per site, after the app has done something
// useful. Closing it is remembered here so no admin sees it again.
define('hideReviewPrompt', async () => {
  const current = await getSettings();
  await saveSettings({ ...current, reviewPromptHiddenAt: new Date().toISOString() });
  return { ok: true };
});

// --- seats --------------------------------------------------------------------

/** How many accounts can use Confluence right now, from the site's own list. Shown before and after a reclaim. */
define('getSeatCount', async () => ({ ok: true, at: new Date().toISOString(), ...(await countLicensedUsers()) }));

// --- protected list -------------------------------------------------------------

define('setProtected', async ({ payload, context }) => {
  const accountId = String(payload?.accountId ?? '');
  if (!accountId) return { ok: false, error: 'No account given.' };
  await setProtected(accountId, Boolean(payload?.protected), context?.accountId ?? null);
  return { ok: true };
});

// --- reclaim and undo -------------------------------------------------------------

/**
 * Reclaim seats for up to RECLAIM_BATCH accounts. For each one: check they are
 * still inactive, read their groups live, plan again against a live group map
 * (the scan is a snapshot), leave the planned groups as the signed-in admin,
 * ask Confluence whether the account can still use the site, and log exactly
 * what changed.
 */
define('reclaim', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const ids = [...new Set((payload?.accountIds ?? []).map(String))].slice(0, RECLAIM_BATCH);
  if (!ids.length) return { ok: false, error: 'No users selected.' };

  const [meta, protectedList, live] = await Promise.all([
    getReportMeta(),
    getProtected(),
    // Groups added or changed since the scan would otherwise be missed, and the
    // app would report a seat freed that is not.
    fetchAccessGroups({ asUser: true }).catch(() => null),
  ]);
  const groupsMeta = live && Object.keys(live.groupsMeta).length ? live.groupsMeta : (meta?.groupsMeta ?? {});
  const days = normaliseDays(meta?.days);
  const me = context?.accountId;
  const results = [];

  for (const accountId of ids) {
    const at = new Date().toISOString();
    try {
      // The list may be weeks old. Someone who has contributed since the scan
      // is no longer inactive, whatever the list says. 'unknown' means the
      // check could not finish, which is never a reason to remove access.
      const active = await wasActiveWithin(accountId, days);
      if (active !== false) {
        const reason = active === true ? 'active-since-scan' : 'unconfirmed-activity';
        results.push({ accountId, ok: false, skipped: true, error: reasonText({ reclaimable: false, reason }) });
        continue;
      }
      const userGroups = await fetchUserGroupsLive(accountId);
      const plan = planReclaim({
        userGroupIds: userGroups.map((g) => g.id),
        groupsMeta,
        protectedReason: protectedReasonFor(accountId, protectedList, me),
      });
      if (!plan.reclaimable) {
        results.push({ accountId, ok: false, skipped: true, error: reasonText(plan) });
        continue;
      }
      const changes = await removeFromGroups(accountId, plan.remove);
      const okCount = changes.filter((c) => c.ok).length;

      // Confluence's own answer: can the account still use the site?
      // true = seat confirmed free, false = still has access, null = unknown.
      let seatFreed = null;
      if (okCount) {
        try {
          const stillUse = await canUseConfluence(accountId, { asUser: true });
          seatFreed = stillUse === null ? null : !stillUse;
        } catch {
          seatFreed = null;
        }
      }
      const left = new Set(changes.filter((c) => c.ok).map((c) => c.groupId));
      const remainingGroups = seatFreed === false ? userGroups.filter((g) => !left.has(g.id)).map((g) => g.name) : [];

      const entry = {
        id: newEntryId(),
        type: 'reclaim',
        accountId,
        by: me ?? null,
        at,
        updatedAt: at,
        status: okCount === changes.length ? 'reclaimed' : okCount ? 'partial' : 'failed',
        freedProducts: plan.freedProducts,
        keptProducts: plan.keptProducts,
        groups: changes,
        seatFreed,
        days: meta?.days ?? null,
      };
      if (okCount) await saveEntry(entry); // nothing changed, nothing to undo
      results.push({
        accountId,
        ok: okCount === changes.length,
        entryId: okCount ? entry.id : null,
        freedProducts: plan.freedProducts,
        groupsLeft: changes.filter((c) => c.ok).map((c) => c.name),
        seatFreed,
        remainingGroups,
        error: changes.find((c) => !c.ok)?.error ?? null,
      });
    } catch (err) {
      results.push({ accountId, ok: false, error: String(err?.message ?? err) });
    }
  }

  const people = await fetchProfiles(ids);
  return {
    ok: true,
    results: results.map((r) => ({ ...r, displayName: people[r.accountId]?.displayName ?? '(unknown)' })),
  };
});

/** Put a user back in exactly the groups one reclaim removed. */
define('undo', async ({ payload, context }) => {
  const entry = await getEntry(String(payload?.entryId ?? ''));
  if (!entry || entry.type !== 'reclaim') return { ok: false, error: 'That action was not found.' };
  if (entry.status === 'restored') return { ok: true, already: true };

  const removed = (entry.groups ?? []).filter((g) => g.ok);
  const changes = await addToGroups(entry.accountId, removed);
  const allBack = changes.every((c) => c.ok);
  const at = new Date().toISOString();
  const updated = {
    ...entry,
    status: allBack ? 'restored' : entry.status,
    updatedAt: at,
    restoredAt: allBack ? at : null,
    restoredBy: allBack ? (context?.accountId ?? null) : null,
    restoreErrors: allBack ? [] : changes.filter((c) => !c.ok).map((c) => `${c.name}: ${c.error}`),
  };
  await saveEntry(updated);
  return { ok: allBack, error: allBack ? null : updated.restoreErrors.join(' ') };
});

define('getHistory', async ({ payload }) => {
  const page = Math.max(0, Number(payload?.page) || 0);
  const { entries, total, pages } = await getLogPage(page);
  const people = await fetchProfiles(entries.flatMap((e) => [e.accountId, e.by, e.restoredBy]));
  const name = (id) => (id ? (people[id]?.displayName ?? '(unknown)') : null);
  return {
    ok: true,
    page,
    pages,
    total,
    entries: entries.map((e) => ({
      ...e,
      displayName: name(e.accountId),
      byName: name(e.by),
      restoredByName: name(e.restoredBy),
    })),
  };
});

export const handler = resolver.getDefinitions();
