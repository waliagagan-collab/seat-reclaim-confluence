import { Queue, InvocationError, InvocationErrorCode } from '@forge/events';
import { fetchContentPage, verifyCandidate, fetchUserGroups, PRODUCT } from './lib/confluence.js';
import {
  SHARDS,
  getScanState,
  setScanState,
  markActive,
  getShardUsers,
  getShardActive,
  appendDormant,
  buildReport,
  clearRun,
} from './lib/store.js';

const queue = new Queue({ key: 'scan-queue' });

/**
 * The scan is a state machine driven by the async event queue:
 *
 *   (directory, in the resolver as the admin) -> content -> verify -> finalize
 *
 * Listing who holds a seat, and which groups grant Confluence, happens before
 * the first event, in src/index.js, because those reads must run as the
 * admin. Each invocation here does a bounded slice, commits its cursor, and
 * re-queues itself. Work inside a slice is accumulated in memory and written
 * to storage ONCE at the end, so a slice costs a handful of storage
 * operations, not hundreds. If a slice dies mid-way, the next event resumes
 * from the last committed cursor; every write is idempotent, so replaying is
 * safe.
 */
const SLICE = {
  contentPages: 12,
  verifyUsers: 30,
  softBudgetMs: 38_000, // stop early; the manifest gives the function 60s
};
const CONTENT_PAGE = 50;
const MAX_CONTENT_PAGES = 400; // sweep ceiling; verify makes a partial sweep harmless
const MAX_TRANSIENT_RETRIES = 6;

export const SWEEP_TRUNCATED_WARNING =
  `This site had more than ${MAX_CONTENT_PAGES * CONTENT_PAGE} pages, posts, comments or files modified in the window, so the activity sweep stopped at the most recent ${MAX_CONTENT_PAGES * CONTENT_PAGE}. Every remaining user was still verified individually against all content on the site, so the list is unaffected — the scan just took longer.`;

export const unverifiedWarning = (n) =>
  `${n} ${n === 1 ? 'user contributes' : 'users contribute'} to more content than the check can examine, so ${n === 1 ? 'that user was' : 'they were'} counted as active rather than risk a wrong name on the list.`;

export const GROUPS_UNREADABLE_WARNING =
  "The app could not read users' groups during the scan, so each person's groups are read live when you reclaim.";

const now = () => Date.now();
const overBudget = (t0) => now() - t0 > SLICE.softBudgetMs;

// @forge/events v2+ invokes a consumer function directly with an AsyncEvent;
// the pushed payload is on `event.body`. Resolvers are not used here.
export async function handler(event) {
  const body = event?.body ?? {};
  const state = await getScanState();
  if (!state || state.status !== 'running' || state.run !== body.run) {
    return; // superseded or cancelled: drop the event, do not re-queue
  }

  try {
    let live;
    switch (state.phase) {
      case 'directory':
        return; // the resolver is still listing users; it pushes the first event when done
      case 'content':
        live = await doContent(state);
        break;
      case 'verify':
        live = await doVerify(state);
        break;
      case 'finalize':
        live = await doFinalize(state);
        break;
      default:
        return await fail(state, `Unknown scan phase "${state.phase}"`);
    }
    // A cancel or a new scan landed while this slice ran: its scratch writes
    // would otherwise sit in storage for ever.
    if (live === false) await clearRun(state.run);
    return undefined;
  } catch (err) {
    if (err.rateLimited) {
      return new InvocationError({
        retryAfter: err.retryAfter,
        retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
      });
    }
    // Nothing was committed, so a retry resumes from the last good cursor.
    // Bounded: an outage should surface as a failed scan, not a scan that
    // spins for the whole retention window.
    const retries = event?.retryContext?.retryCount ?? 0;
    if (err.retryable && retries < MAX_TRANSIENT_RETRIES) {
      return new InvocationError({
        retryAfter: 15 * (retries + 1),
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
      });
    }
    return fail(state, String(err?.message ?? err));
  }
}

/**
 * Commit a patch only if this run is still the live one. A cancel that lands
 * mid-slice must win; without this check the slice would overwrite it with
 * its stale `status: 'running'` snapshot and carry on.
 */
async function commit(state, patch, { requeue = true } = {}) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') return false;
  const next = { ...fresh, ...patch };
  await setScanState(next);
  if (requeue) await queue.push({ body: { run: state.run } });
  return true;
}

async function fail(state, error) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run) return;
  await setScanState({
    ...fresh,
    status: 'failed',
    error,
    finishedAt: new Date().toISOString(),
  });
  // Scratch data from a failed run has no further use; do not leave it behind.
  await clearRun(state.run);
}

// --- content (sweep) --------------------------------------------------------

async function doContent(state) {
  const t0 = now();
  let cursor = state.contentCursor ?? null;
  let pages = state.contentPages ?? 0;
  let scanned = state.itemsScanned ?? 0;
  let done = false;
  let truncated = false;
  const active = new Set();

  for (let i = 0; i < SLICE.contentPages && !overBudget(t0); i++) {
    const page = await fetchContentPage(state.days, cursor, CONTENT_PAGE);
    for (const id of Object.keys(page.activity)) active.add(id);
    scanned += page.count;
    pages += 1;
    cursor = page.nextCursor;

    if (page.isLast) {
      done = true;
      break;
    }
    if (pages >= MAX_CONTENT_PAGES) {
      done = true;
      truncated = true;
      break;
    }
  }

  if (active.size) await markActive(state.run, [...active]);

  return commit(state, {
    contentCursor: cursor,
    contentPages: pages,
    itemsScanned: scanned,
    sweepTruncated: Boolean(state.sweepTruncated) || truncated,
    phase: done ? 'verify' : 'content',
    ...(done ? { verifyShard: 0, verifyIndex: 0, verified: 0, dormantFound: 0, unverified: 0 } : {}),
  });
}

// --- verify -----------------------------------------------------------------

/**
 * For every user the sweep could not vouch for, ask Confluence directly. This
 * is exhaustive across all content, so it is correct even when the sweep was
 * truncated — the sweep only decides how much verification is needed.
 *
 * Each inactive user also gets their groups read, so the page can show which
 * groups a reclaim would remove. The reclaim itself re-reads them live.
 */
async function doVerify(state) {
  const t0 = now();
  let shard = state.verifyShard ?? 0;
  let index = state.verifyIndex ?? 0;
  let verified = state.verified ?? 0;
  let dormantFound = state.dormantFound ?? 0;
  let unverified = state.unverified ?? 0;
  let groupsUnreadable = Boolean(state.groupsUnreadable);
  let checked = 0;

  while (shard < SHARDS && checked < SLICE.verifyUsers && !overBudget(t0)) {
    const users = await getShardUsers(state.run, shard);
    const activeSet = await getShardActive(state.run, shard);
    const ids = Object.keys(users).sort();
    const dormantRows = [];

    while (index < ids.length && checked < SLICE.verifyUsers && !overBudget(t0)) {
      const accountId = ids[index];
      index += 1;
      if (activeSet[accountId]) continue; // sweep already proved them active

      const result = await verifyCandidate(accountId, state.days);
      checked += 1;
      verified += 1;
      if (result.unverified) unverified += 1;
      if (!result.active) {
        dormantFound += 1;
        let groups = null;
        if (!groupsUnreadable) {
          try {
            groups = (await fetchUserGroups(accountId)).map((g) => g.id);
          } catch (err) {
            if (err.rateLimited || err.retryable) throw err;
            // A refusal would repeat for every user. Note it once; the reclaim
            // step reads groups live as the admin instead.
            groupsUnreadable = true;
          }
        }
        dormantRows.push({
          accountId,
          products: [PRODUCT],
          groups,
          bucket: result.bucket,
          label: result.label,
          severity: result.severity,
        });
      }
    }

    if (dormantRows.length) await appendDormant(state.run, shard, dormantRows);

    if (index >= ids.length) {
      shard += 1;
      index = 0;
    }
  }

  const done = shard >= SHARDS;
  return commit(state, {
    verifyShard: shard,
    verifyIndex: index,
    verified,
    dormantFound,
    unverified,
    groupsUnreadable,
    phase: done ? 'finalize' : 'verify',
  });
}

// --- finalize ---------------------------------------------------------------

async function doFinalize(state) {
  // Count seats from the stored user map so the total matches what was audited.
  let totalUsers = 0;
  for (let s = 0; s < SHARDS; s++) {
    totalUsers += Object.keys(await getShardUsers(state.run, s)).length;
  }

  const unverified = state.unverified ?? 0;
  const groupsMeta = state.groupsMeta ?? {};
  const report = await buildReport(state.run, {
    days: state.days,
    products: [{ key: 'confluence', name: PRODUCT }],
    groupsMeta,
    // Which groups grant Confluence, for the page and the agent.
    accessGroups: Object.entries(groupsMeta)
      .map(([id, g]) => ({ id, name: g.name, admin: Boolean(g.admin) }))
      .sort((a, b) => Number(a.admin) - Number(b.admin) || a.name.localeCompare(b.name)),
    accessSource: state.accessSource ?? 'none',
    totalUsers,
    activeUsers: totalUsers - (state.dormantFound ?? 0),
    guests: state.guests ?? 0,
    unverified,
    verified: state.verified ?? 0,
    itemsScanned: state.itemsScanned ?? 0,
    sweepTruncated: Boolean(state.sweepTruncated),
    warnings: [
      ...(state.warnings ?? []),
      ...(state.sweepTruncated ? [SWEEP_TRUNCATED_WARNING] : []),
      ...(unverified ? [unverifiedWarning(unverified)] : []),
      ...(state.groupsUnreadable ? [GROUPS_UNREADABLE_WARNING] : []),
    ],
  });

  return commit(
    state,
    { status: 'complete', phase: 'done', finishedAt: report.generatedAt },
    { requeue: false }
  );
}
