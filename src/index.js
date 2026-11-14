import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  getScanState,
  setScanState,
  getReportMeta,
  getReportPage,
  getAllReportRows,
  getReportedIds,
  clearRun,
  upsertUsers,
  getSettings,
  saveSettings,
  getProtected,
  setProtected,
  newEntryId,
  saveEntry,
  dropEntry,
  noteRow,
  getEntry,
  getLogPage,
  getLatestFor,
  markActionStarted,
} from './lib/store.js';
import {
  fetchProfiles,
  fetchUserPage,
  diagnose,
  fetchAccessGroups,
  canUseConfluence,
  administersConfluence,
  countLicensedUsers,
  wasActiveWithin,
} from './lib/confluence.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import { normaliseSeatCosts, notListed, CLOSED_ACCOUNT_NAME } from './lib/ui.js';
import { decorate, protectedReasonFor } from './lib/decorate.js';
import { planReclaim, reasonText, fetchUserGroupsLive, removeFromGroups, addToGroups, freedProductsFrom } from './lib/reclaim.js';

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
export const RECLAIM_BATCH = 3; // small, so a batch always finishes inside the resolver's time limit
// A reclaim that started this recently for the same person is taken to be
// still running (a second click, a second tab). Older than this, it is not.
const IN_FLIGHT_MS = 60_000;

export const ACCESS_GROUPS_BY_NAME_WARNING =
  "Confluence didn't let the app filter groups by permission, so the standard access groups were recognised by name. If your site grants Confluence through other groups, those users will show as can't reclaim.";
export const ACCESS_GROUPS_UNREADABLE_WARNING =
  'The app could not read which groups grant Confluence, so it cannot plan any reclaim from this scan. Open Confluence → Settings → Manage apps and update Seat Reclaim if an update is offered, then run a new scan. Do not uninstall the app: a new install starts with an empty History, so nothing could be undone.';

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
    seq: 0,
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
    // Rate limited: keep what was collected so far and let the page wait.
    if (err?.rateLimited) return { ok: true, done: false, retryAfter: err.retryAfter ?? 5 };
    const fresh = await getScanState();
    if (fresh?.run === state.run) {
      await setScanState({ ...fresh, status: 'failed', error: String(err?.message ?? err).slice(0, 300), finishedAt: new Date().toISOString() });
      await clearRun(state.run);
    }
    return { ok: false, done: true, error: String(err?.message ?? err).slice(0, 300) };
  }

  // Re-read before committing: a cancel that landed meanwhile must win.
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') {
    return { ok: false, done: true, error: 'The scan was cancelled.' };
  }
  // Another call (a second tab) listed the same pages and committed first.
  // This one writes nothing and queues nothing; the page asks again and
  // carries on from where that call left the cursor.
  if (fresh.phase !== 'directory' || (fresh.directoryCursor ?? 0) !== (state.directoryCursor ?? 0)) {
    return { ok: true, done: fresh.phase !== 'directory', usersFound: fresh.usersFound ?? 0, nextStart: fresh.directoryCursor ?? 0 };
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
    // If the push fails nothing is thrown away: the run is marked paused with
    // the listing saved, and the page's status poll sends the first event
    // again. The page shows the pause, so nobody watches a spinner with no
    // work behind it.
    try {
      await queue.push({ body: { run: state.run, seq: next.seq ?? 0 } });
    } catch (err) {
      await setScanState({ ...next, paused: true, pauses: 1, pauseReason: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return { ok: true, done: isLast, usersFound, nextStart: start };
});

/**
 * A run whose next event could not be queued waits, with its cursor saved,
 * marked `paused`. Forge refuses a push after 1,000 in one chain of events;
 * a call from the page starts a new chain, so the status poll is what carries
 * a paused run on. The flag is cleared before the push, while no slice is
 * running, so this write cannot collide with a slice's own.
 */
async function resumeScan(state) {
  const claimed = { ...state, paused: false };
  await setScanState(claimed);
  try {
    await queue.push({ body: { run: state.run, seq: state.seq ?? 0 } });
  } catch (err) {
    await setScanState({ ...claimed, paused: true, pauseReason: String(err?.message ?? err).slice(0, 300) });
  }
  return getScanState();
}

define('getStatus', async () => {
  let state = await getScanState();
  if (state?.status === 'running' && state.paused) state = await resumeScan(state);
  const report = await getReportMeta();
  return { ok: true, state: state ?? null, stale: isStale(state), report: report ?? null };
});

define('getPage', async ({ payload, context }) => {
  const index = Math.max(0, Number(payload?.index) || 0);
  return { ok: true, index, rows: await decorate(await getReportPage(index), context) };
});

define('getAllRows', async ({ context }) => {
  const [meta, rows] = await Promise.all([getReportMeta(), getAllReportRows(EXPORT_LIMIT)]);
  return {
    ok: true,
    rows: await decorate(rows, context),
    limit: EXPORT_LIMIT,
    // Users the scan counted whose rows went when their accounts were closed.
    notListed: notListed(meta?.dormantCount, rows.length, EXPORT_LIMIT),
  };
});

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
  // The weekly personal data report does not erase while this may still be
  // running (busy in lib/personal-data.js). A note that cannot be written
  // only means the report does not wait.
  await markActionStarted().catch(() => {});
  await setProtected(accountId, Boolean(payload?.protected), context?.accountId ?? null);
  return { ok: true };
});

// --- reclaim and undo -------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIRM_DELAYS_MS = [0, 1500, 2500];

/**
 * Confluence's own answer after a group change: can the account still use the
 * site? Its permission data can lag the directory by a second or two right
 * after the change, so a first "still has access" is asked again before it is
 * reported. true = seat confirmed free, false = still has access, null = unknown.
 */
async function confirmSeatFreed(accountId) {
  let answer = null;
  for (const ms of CONFIRM_DELAYS_MS) {
    if (ms) await sleep(ms);
    try {
      const stillUse = await canUseConfluence(accountId, { asUser: true });
      answer = stillUse === null ? null : !stillUse;
    } catch {
      answer = null;
    }
    if (answer === true) return true;
  }
  return answer;
}

/**
 * Reclaim seats for up to RECLAIM_BATCH accounts. For each one: check they are
 * on the current list and still inactive, read their groups live, plan again
 * against a live group map (the scan is a snapshot), leave the planned groups
 * as the signed-in admin, ask Confluence whether the account can still use
 * the site, and log exactly what changed.
 */
define('reclaim', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const asked = Array.isArray(payload?.accountIds) ? payload.accountIds : [];
  const ids = [...new Set(asked.map(String))].slice(0, RECLAIM_BATCH);
  if (!ids.length) return { ok: false, error: 'No users selected.' };
  // As for the protected list: the personal data report waits while this may be running.
  await markActionStarted().catch(() => {});

  const meta = await getReportMeta();
  // A reclaim works from the list a scan produced, never from an account ID
  // the page (or anyone calling this directly) happens to send.
  if (!meta) return { ok: false, error: 'There is no list yet. Run a scan first.' };

  const [protectedList, live, reported, latest] = await Promise.all([
    getProtected(),
    // Groups added or changed since the scan would otherwise be missed, and the
    // app would report a seat freed that is not.
    fetchAccessGroups({ asUser: true }).catch(() => null),
    getReportedIds(ids),
    getLatestFor(ids),
  ]);
  const groupsMeta = live && Object.keys(live.groupsMeta).length ? live.groupsMeta : (meta?.groupsMeta ?? {});
  const days = normaliseDays(meta?.days);
  const me = context?.accountId;
  const results = [];
  const pending = []; // group changes that still need Confluence's answer
  const skip = (accountId, reason) =>
    results.push({ accountId, ok: false, skipped: true, error: reasonText({ reclaimable: false, reason }) });
  let retryAfter = null;

  for (const accountId of ids) {
    const at = new Date().toISOString();
    try {
      if (!reported.has(accountId)) {
        skip(accountId, 'not-on-list');
        continue;
      }
      // A second click or a second tab: the first call is still at work on
      // this person. The entry carries its own time, so nothing has to expire.
      const last = latest[accountId];
      if (last?.status === 'pending' && Date.now() - Date.parse(last.at) < IN_FLIGHT_MS) {
        skip(accountId, 'in-flight');
        continue;
      }
      // The list may be weeks old. Someone who has contributed since the scan
      // is no longer inactive, whatever the list says. 'unknown' means the
      // check could not finish, which is never a reason to remove access.
      const active = await wasActiveWithin(accountId, days);
      if (active !== false) {
        skip(accountId, active === true ? 'active-since-scan' : 'unconfirmed-activity');
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
      // Groups are not the whole story: an admin role can be given to a person
      // directly, or come through a group that grants no Confluence. Confluence
      // answers for the person looked up, so it is asked about each one. An
      // answer that cannot be had is never a reason to remove access.
      let admin;
      try {
        admin = await administersConfluence(accountId, { asUser: true });
      } catch (err) {
        if (err?.rateLimited) throw err;
        admin = null;
      }
      if (admin !== false) {
        const reason = admin ? 'admin-role' : 'admin-unconfirmed';
        // An admin stays an admin: the row stops being offered until a new scan.
        if (admin) await noteRow(accountId, 'blocked', reasonText({ reclaimable: false, reason })).catch(() => {});
        skip(accountId, reason);
        continue;
      }
      // The log entry is written BEFORE anything changes, as "pending", so a
      // timeout or dropped connection mid-way can never leave a removed group
      // with no record and no undo. It is updated once Confluence has answered.
      const entry = {
        id: newEntryId(),
        type: 'reclaim',
        accountId,
        by: me ?? null,
        at,
        updatedAt: at,
        status: 'pending',
        freedProducts: [],
        keptProducts: plan.keptProducts,
        groups: plan.remove.map((g) => ({ groupId: g.groupId, name: g.name, products: g.products, ok: false, pending: true })),
        seatFreed: null,
        days: meta?.days ?? null,
      };
      await saveEntry(entry);

      const changes = await removeFromGroups(accountId, plan.remove);
      const okCount = changes.filter((c) => c.ok).length;
      const unknownCount = changes.filter((c) => c.unknown).length;
      const failedChange = changes.find((c) => !c.ok);
      const left = new Set(changes.filter((c) => c.ok).map((c) => c.groupId));
      for (const c of changes) if (c.retryAfter) retryAfter = Math.max(retryAfter ?? 0, c.retryAfter);

      entry.groups = changes;
      entry.freedProducts = freedProductsFrom(changes, plan.keptProducts);
      entry.updatedAt = new Date().toISOString();
      entry.status = okCount === changes.length ? 'reclaimed' : okCount || unknownCount ? 'partial' : 'failed';
      // Confluence's own answer (seatFreed) is asked after the batch, once its
      // permission data has had a moment to catch up; until then it is unknown.
      let logged = true;
      try {
        if (entry.status === 'failed') {
          // Nothing was left and nothing is in doubt, so there is nothing to
          // undo: the reason goes on the person's row and History keeps only
          // real changes. A group managed by an identity provider will refuse
          // every time, so that row stops being offered.
          const everyRefusalIsIdp = changes.every((c) => c.idpManaged);
          try {
            await noteRow(accountId, everyRefusalIsIdp ? 'blocked' : 'failed', failedChange?.error ?? null);
            await dropEntry(entry);
          } catch {
            // The note or the removal could not be stored: keep the entry, as
            // "Not done", rather than leave it reading "Interrupted".
            await saveEntry(entry);
            logged = false;
          }
        } else {
          await saveEntry(entry);
        }
      } catch {
        logged = false;
      }
      if (okCount) pending.push({ entry, index: results.length, userGroups, left, groupsMeta });
      results.push({
        accountId,
        ok: okCount === changes.length,
        partial: okCount > 0 && okCount < changes.length,
        // Confluence asked for a pause before the first group: nothing
        // changed, so the page sends this person again after the wait.
        retry: changes.length > 0 && changes.every((c) => c.rateLimited),
        entryId: entry.status === 'failed' && logged ? null : entry.id,
        freedProducts: entry.freedProducts,
        groupsLeft: changes.filter((c) => c.ok).map((c) => c.name),
        seatFreed: null,
        remainingGroups: [],
        error:
          !logged && okCount
            ? 'The groups were left, but the change could not be written to History. Check the person\'s groups in Atlassian Administration.'
            : (failedChange?.error ?? null),
      });
    } catch (err) {
      if (err?.rateLimited) {
        // Confluence asked for a pause before anything changed for this
        // person. They, and everyone after them in the batch, are handed back
        // to the page to send again after the wait.
        retryAfter = Math.max(retryAfter ?? 0, err.retryAfter ?? 5);
        for (const rest of ids.slice(ids.indexOf(accountId))) {
          results.push({ accountId: rest, ok: false, retry: true, error: 'Confluence asked the app to slow down. Nothing was changed for this person.' });
        }
        break;
      }
      results.push({ accountId, ok: false, error: String(err?.message ?? err) });
    }
  }

  // Everyone whose groups changed is confirmed together, so one slow answer
  // does not hold up the others, and the log entry is updated with the answer.
  await Promise.all(
    pending.map(async ({ entry, index, userGroups, left, groupsMeta: gm }) => {
      const seatFreed = await confirmSeatFreed(entry.accountId);
      entry.seatFreed = seatFreed;
      entry.updatedAt = new Date().toISOString();
      try {
        await saveEntry(entry);
      } catch {
        /* the answer is still returned to the page; History re-asks later */
      }
      results[index].seatFreed = seatFreed;
      // Only groups that grant Confluence explain continued access; the rest
      // (space groups, team groups) would be noise.
      results[index].remainingGroups =
        seatFreed === false ? userGroups.filter((g) => !left.has(g.id) && gm?.[g.id]).map((g) => g.name) : [];
    }),
  );

  // The names are for the result message only. The changes are already made
  // and logged, so a failed lookup must not turn the whole answer into an error.
  let people = null;
  try {
    people = await fetchProfiles(ids);
  } catch {
    /* the page shows the names it already has */
  }
  return {
    ok: true,
    retryAfter,
    results: results.map((r) => ({
      ...r,
      displayName: people ? (people[r.accountId]?.displayName ?? '(unknown)') : null,
    })),
  };
});

/**
 * Put a user back in exactly the groups one reclaim removed. Deliberately not
 * behind the licence gate: a site whose subscription lapsed must still be able
 * to give people their access back.
 */
define('undo', async ({ payload, context }) => {
  // As for reclaim: the personal data report waits while this may be running.
  await markActionStarted().catch(() => {});
  const entry = await getEntry(String(payload?.entryId ?? ''));
  if (!entry || entry.type !== 'reclaim') return { ok: false, error: 'That action was not found.' };
  if (entry.status === 'restored') return { ok: true, already: true };

  // Groups that were left, plus any whose removal got no answer or was
  // interrupted: adding someone who is still a member is harmless.
  const removed = (entry.groups ?? []).filter((g) => g.ok || g.unknown || g.pending);
  if (!removed.length) return { ok: false, error: 'That action changed nothing, so there is nothing to undo.' };
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

const RECHECK_WINDOW_MS = 15 * 60 * 1000;
const RECHECK_MAX = 5;

/**
 * Confluence's directory can lag a group change by more than the few seconds
 * the reclaim waits. Recent entries still marked "not free" or "unknown" are
 * asked again when History is opened, so a slow answer never sticks for good.
 */
async function recheckRecent(entries) {
  const due = entries
    .filter((e) => e.type === 'reclaim' && (e.status === 'reclaimed' || e.status === 'partial') && e.seatFreed !== true)
    .filter((e) => Date.now() - Date.parse(e.updatedAt ?? e.at) < RECHECK_WINDOW_MS)
    .slice(0, RECHECK_MAX);
  // It saves entries, so the personal data report waits while it may be running.
  if (due.length) await markActionStarted().catch(() => {});
  for (const e of due) {
    try {
      const stillUse = await canUseConfluence(e.accountId, { asUser: true });
      if (stillUse === null) continue;
      // The entry is read again just before it is saved, and only the answer
      // is changed: an Undo that landed while Confluence was being asked must
      // not be overwritten with the copy read earlier. Its time is left
      // alone, so an older entry never becomes the person's latest action.
      const now = await getEntry(e.id);
      if (!now || now.status !== e.status) continue;
      await saveEntry({ ...now, seatFreed: !stillUse });
      e.seatFreed = !stillUse;
    } catch {
      /* answer later */
    }
  }
}

define('getHistory', async ({ payload }) => {
  const page = Math.max(0, Number(payload?.page) || 0);
  const { entries, total, pages } = await getLogPage(page);
  await recheckRecent(entries);
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
      // An admin whose account was closed: the personal data report cleared the ID.
      byName: e.byClosed ? CLOSED_ACCOUNT_NAME : name(e.by),
      restoredByName: e.restoredByClosed ? CLOSED_ACCOUNT_NAME : name(e.restoredBy),
    })),
  };
});

export const handler = resolver.getDefinitions();
