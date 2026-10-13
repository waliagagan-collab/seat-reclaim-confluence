import { kvs } from '@forge/kvs';

/**
 * Storage layer.
 *
 * Rule: never store anything a customer authored, and nothing personal beyond
 * the account ID. Everything here is account ids, group ids and dormancy bands
 * the app derived itself. The action log and the protected list are the only
 * records a scan cannot regenerate, and they hold account and group ids only.
 * Display names and emails are resolved from Confluence at read time. The worst outcome of any bug
 * is a stale report — never lost customer data. That one rule removes the
 * class of failure behind the angriest reviews on the Marketplace.
 *
 * Values are sharded because a KVS value is size-limited and a large site
 * holds thousands of accounts. A user and every fact about them always land
 * in the same shard, so joins are shard-local.
 */

export const SHARDS = 16;

export const shardOf = (accountId) => {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) {
    h = (h * 31 + accountId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % SHARDS;
};

export const SCAN_KEY = 'scan:state';
export const REPORT_META = 'report:meta';
const usersKey = (run, s) => `scan:${run}:users:${s}`;
const activeKey = (run, s) => `scan:${run}:active:${s}`;
const dormantKey = (run, s) => `scan:${run}:dormant:${s}`;
const reportKey = (i) => `report:dormant:${i}`;

export const getScanState = () => kvs.get(SCAN_KEY);
export const setScanState = (state) =>
  kvs.set(SCAN_KEY, { ...state, updatedAt: new Date().toISOString() });

const groupByShard = (items, idOf) => {
  const m = new Map();
  for (const it of items) {
    const s = shardOf(idOf(it));
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(it);
  }
  return m;
};

/**
 * Upsert users, unioning product membership. Called once per invocation with
 * everything that invocation collected, so a slice costs at most 16 writes.
 */
export async function upsertUsers(run, users) {
  for (const [s, batch] of groupByShard(users, (u) => u.accountId)) {
    const key = usersKey(run, s);
    const existing = (await kvs.get(key)) ?? {};
    for (const u of batch) {
      const prev = existing[u.accountId];
      const products = new Set([...(prev?.products ?? []), ...(u.products ?? [])]);
      existing[u.accountId] = { products: [...products] };
    }
    await kvs.set(key, existing);
  }
}

/** Record accounts the sweep proved active. Presence is the whole fact. */
export async function markActive(run, accountIds) {
  for (const [s, batch] of groupByShard(accountIds, (id) => id)) {
    const key = activeKey(run, s);
    const existing = (await kvs.get(key)) ?? {};
    for (const id of batch) existing[id] = 1;
    await kvs.set(key, existing);
  }
}

export const getShardUsers = async (run, s) => (await kvs.get(usersKey(run, s))) ?? {};
export const getShardActive = async (run, s) => (await kvs.get(activeKey(run, s))) ?? {};

/**
 * Pure: add rows to a shard's dormant list without duplicating an account.
 * A slice that dies after this write but before its cursor commit is replayed
 * from the old cursor, so the same users arrive twice.
 */
export function mergeDormant(existing, rows) {
  const seen = new Set((existing ?? []).map((r) => r.accountId));
  const out = [...(existing ?? [])];
  for (const r of rows ?? []) {
    if (!seen.has(r.accountId)) {
      seen.add(r.accountId);
      out.push(r);
    }
  }
  return out;
}

export async function appendDormant(run, s, rows) {
  if (!rows.length) return;
  const key = dormantKey(run, s);
  const existing = (await kvs.get(key)) ?? [];
  await kvs.set(key, mergeDormant(existing, rows));
}

/**
 * Pure: longest-dormant first. Names are not in storage, so the tie-break is
 * the account ID, which keeps paging deterministic between runs.
 */
export const sortDormant = (rows) =>
  [...rows].sort(
    (a, b) =>
      (b.severity ?? 0) - (a.severity ?? 0) ||
      String(a.accountId).localeCompare(String(b.accountId))
  );

const PAGE = 250;

/** Assemble the final report, page it, publish it, and drop the scratch data. */
export async function buildReport(run, meta) {
  const all = [];
  for (let s = 0; s < SHARDS; s++) {
    all.push(...((await kvs.get(dormantKey(run, s))) ?? []));
  }
  const dormant = sortDormant(all);

  const perProduct = new Map();
  for (const r of dormant) {
    for (const p of r.products ?? []) perProduct.set(p, (perProduct.get(p) ?? 0) + 1);
  }

  const previous = await kvs.get(REPORT_META);
  const pages = Math.max(1, Math.ceil(dormant.length / PAGE));
  for (let i = 0; i < pages; i++) {
    await kvs.set(reportKey(i), dormant.slice(i * PAGE, (i + 1) * PAGE));
  }

  const report = {
    ...meta,
    generatedAt: new Date().toISOString(),
    dormantCount: dormant.length,
    dormantByProduct: Object.fromEntries(perProduct),
    pages,
    pageSize: PAGE,
  };
  await kvs.set(REPORT_META, report);

  // Pages left over from a previous, longer report would otherwise linger.
  for (let i = pages; i < (previous?.pages ?? 0); i++) await kvs.delete(reportKey(i));
  await clearRun(run);
  return report;
}

export const getReportMeta = () => kvs.get(REPORT_META);
export const getReportPage = async (i) => (await kvs.get(reportKey(i))) ?? [];

export async function getAllReportRows(limit) {
  const meta = await kvs.get(REPORT_META);
  const rows = [];
  for (let i = 0; i < (meta?.pages ?? 0) && rows.length < limit; i++) {
    rows.push(...(await getReportPage(i)));
  }
  return rows.slice(0, limit);
}

export async function clearRun(run) {
  for (let s = 0; s < SHARDS; s++) {
    await kvs.delete(usersKey(run, s));
    await kvs.delete(activeKey(run, s));
    await kvs.delete(dormantKey(run, s));
  }
}

// ---------------------------------------------------------------------------
// Protected list: accounts the app must never reclaim
// ---------------------------------------------------------------------------

const PROTECTED_KEY = 'protected';

export const getProtected = async () => (await kvs.get(PROTECTED_KEY)) ?? {};

export async function setProtected(accountId, on, by) {
  const list = await getProtected();
  if (on) list[accountId] = { at: new Date().toISOString(), by };
  else delete list[accountId];
  await kvs.set(PROTECTED_KEY, list);
  return list;
}

// ---------------------------------------------------------------------------
// Action log: every reclaim and undo, newest first
// ---------------------------------------------------------------------------

const LOG_INDEX = 'log:index';
const LOG_CAP = 1000;
const logEntryKey = (id) => `log:entry:${id}`;
const latestKey = (s) => `log:latest:${s}`;

export const newEntryId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function saveEntry(entry) {
  await kvs.set(logEntryKey(entry.id), entry);
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  if (!index.includes(entry.id)) {
    index.unshift(entry.id);
    const dropped = index.splice(LOG_CAP);
    for (const id of dropped) await kvs.delete(logEntryKey(id));
    await kvs.set(LOG_INDEX, index);
  }
  // The latest action per user lets the report mark rows already reclaimed.
  const key = latestKey(shardOf(entry.accountId));
  const latest = (await kvs.get(key)) ?? {};
  latest[entry.accountId] = { id: entry.id, status: entry.status, at: entry.updatedAt ?? entry.at };
  await kvs.set(key, latest);
}

export const getEntry = (id) => kvs.get(logEntryKey(id));

export async function getLogPage(page, size = 25) {
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  const ids = index.slice(page * size, (page + 1) * size);
  const entries = [];
  for (const id of ids) {
    const e = await kvs.get(logEntryKey(id));
    if (e) entries.push(e);
  }
  return { entries, total: index.length, pages: Math.max(1, Math.ceil(index.length / size)) };
}

/** { accountId -> latest action } for the given accounts. */
export async function getLatestFor(accountIds) {
  const out = {};
  const byShard = groupByShard(accountIds ?? [], (id) => id);
  for (const [s, ids] of byShard) {
    const latest = (await kvs.get(latestKey(s))) ?? {};
    for (const id of ids) if (latest[id]) out[id] = latest[id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings: the yearly price of one Confluence seat. Numbers only.
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export const getSettings = async () => (await kvs.get(SETTINGS_KEY)) ?? { seatCosts: {} };

export async function saveSettings(settings) {
  await kvs.set(SETTINGS_KEY, settings);
  return settings;
}
