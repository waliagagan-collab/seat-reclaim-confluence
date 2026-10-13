/**
 * Pure helpers for the Rovo agent. The agent reads the last scan, the reclaim
 * plan and the action log. It never reclaims or undoes anything: that happens
 * only on the Seat Reclaim page, after the admin confirms. No Forge imports,
 * so these rules run under plain Node tests.
 */
import { yearlySaving } from './ui.js';

export const PRODUCT = 'Confluence';
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const HISTORY_DEFAULT = 10;
export const HISTORY_MAX = 25;

export const NO_REPORT =
  'No scan has been run on this site yet. A Confluence admin can run one in Confluence administration → Settings → Apps → Seat Reclaim; it takes a few minutes.';

const text = (v) => String(v ?? '').trim();

/** Pure: a positive number from whatever the agent sends ("180", 180, "180 days"), else null. */
export function positive(v) {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pure: the lower bound in days of a stored band, e.g. '90-180' -> 90, 'over-365' -> 365. */
export function bandFloor(bucket) {
  const m = String(bucket ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Pure: the same three groups the page's status filter uses. */
export function statusOf(u) {
  if (u?.lastAction?.status === 'reclaimed') return 'reclaimed';
  return u?.reclaimable && !u?.isProtected ? 'ready' : 'blocked';
}

/** Pure: why a blocked user is blocked, with the protected list applied. */
export const blockReason = (u) => (u?.isProtected ? 'On your protected list.' : (u?.reason ?? 'Cannot be reclaimed.'));

const STATUS_WORDS = { ready: 'Ready to reclaim', blocked: "Can't reclaim", reclaimed: 'Already reclaimed' };

/** Pure: what the admin typed for a status -> ready | blocked | reclaimed | null (all). */
export function normaliseStatus(v) {
  const s = text(v).toLowerCase();
  if (!s || /all|any|every/.test(s)) return null;
  // "already" contains "ready", so it is checked first.
  if (/already|done|removed|previously/.test(s)) return 'reclaimed';
  if (/can'?t|cannot|blocked|\bnot\b|admin|protect/.test(s)) return 'blocked';
  if (/ready|\bcan\b|eligible|reclaimable/.test(s)) return 'ready';
  if (/reclaimed/.test(s)) return 'reclaimed';
  return null;
}

/** Pure: the list action's inputs, cleaned and capped. */
export function listOptions(payload) {
  return {
    status: normaliseStatus(payload?.status),
    search: text(payload?.search).slice(0, 100),
    minDays: positive(payload?.minimumDaysInactive),
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.round(positive(payload?.limit) ?? DEFAULT_LIMIT))),
  };
}

/** Pure: filters over decorated rows (they already carry names and plans). */
export function filterCandidates(rows, { status, search, minDays }) {
  const q = text(search).toLowerCase();
  return (rows ?? []).filter(
    (u) =>
      (!status || statusOf(u) === status) &&
      (!q || `${u.displayName ?? ''} ${u.email ?? ''}`.toLowerCase().includes(q)) &&
      (!minDays || bandFloor(u.bucket) >= minDays)
  );
}

export const stamp = (meta) => ({
  reportGeneratedAt: meta?.generatedAt ?? null,
  scanPeriodDays: meta?.days ?? null,
});

/** Pure: one candidate as the agent shows it. */
export const candidateLine = (u) => ({
  name: u.displayName ?? '(unknown)',
  email: u.email ?? null,
  inactiveFor: u.label ?? null,
  status: STATUS_WORDS[statusOf(u)],
  wouldLeaveGroups: statusOf(u) === 'ready' ? (u.removeGroups ?? []) : [],
  groupsReadAtReclaim: statusOf(u) === 'ready' && u.pending ? true : undefined,
  reason: statusOf(u) === 'blocked' ? blockReason(u) : null,
  partlyReclaimed: u.lastAction?.status === 'partial' || undefined,
});

/** Pure: the reclaim summary over decorated rows. */
export function reclaimSummary(meta, rows, settings) {
  const groups = { ready: [], blocked: [], reclaimed: [] };
  for (const u of rows ?? []) groups[statusOf(u)].push(u);

  const reasons = {};
  for (const u of groups.blocked) {
    const r = blockReason(u);
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  const price = settings?.seatCosts?.[PRODUCT] ?? null;
  const ready = groups.ready.length;
  return {
    ...stamp(meta),
    licensedUsers: meta?.totalUsers ?? null,
    inactiveUsers: (rows ?? []).length,
    readyToReclaim: ready,
    cannotReclaim: groups.blocked.length,
    alreadyReclaimed: groups.reclaimed.length,
    whyNot: Object.entries(reasons).map(([reason, users]) => ({ reason, users })),
    yearlyPriceOfOneSeat: price,
    // Nothing ready means nothing to save; blank would read as "no price saved".
    estimatedYearlySaving: ready ? yearlySaving({ [PRODUCT]: ready }, { [PRODUCT]: price }) : 0,
    pricesNote: price
      ? 'The seat price is the yearly price an admin saved in Seat Reclaim, in their billing currency.'
      : 'No seat price is saved, so there is no saving figure. An admin can enter one on the Seat Reclaim page.',
    groupsThatGrantConfluence: (meta?.accessGroups ?? []).map((g) => ({ group: g.name, adminGroupNeverRemoved: Boolean(g.admin) })),
    warnings: meta?.warnings ?? [],
    note: 'Reclaiming happens only on the Seat Reclaim page, after you confirm. Every reclaim is logged and can be undone there.',
  };
}

/** Pure: the list action's answer. */
export function listAnswer(meta, opts, matching) {
  const shown = matching.slice(0, opts.limit);
  return {
    ...stamp(meta),
    filters: {
      status: opts.status ? STATUS_WORDS[opts.status] : null,
      search: opts.search || null,
      minimumDaysInactive: opts.minDays,
    },
    matchingUsers: matching.length,
    shown: shown.length,
    users: shown.map(candidateLine),
    note:
      matching.length > shown.length
        ? `Showing the first ${shown.length} of ${matching.length}, longest inactive first. Ask for more (up to ${MAX_LIMIT}).`
        : null,
  };
}

const ACTION_WORDS = { reclaimed: 'Reclaimed', partial: 'Partly reclaimed', failed: 'Failed', restored: 'Undone' };

/** Pure: one log entry as the agent shows it; `name` maps account IDs to display names. */
export const historyLine = (e, name) => ({
  user: name(e.accountId),
  outcome: ACTION_WORDS[e.status] ?? e.status ?? null,
  at: e.at ?? null,
  by: name(e.by),
  groupsLeft: (e.groups ?? []).filter((g) => g.ok).map((g) => g.name),
  confluenceConfirmedSeatFree: e.seatFreed === true ? true : e.seatFreed === false ? false : null,
  undoneAt: e.restoredAt ?? null,
  undoneBy: e.restoredBy ? name(e.restoredBy) : null,
});

export const historyLimit = (payload) =>
  Math.min(HISTORY_MAX, Math.max(1, Math.round(positive(payload?.limit) ?? HISTORY_DEFAULT)));
