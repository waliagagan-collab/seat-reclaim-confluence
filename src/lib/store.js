import { kvs as forgeKvs } from '@forge/kvs';

/**
 * Storage layer.
 *
 * Rule: nothing personal beyond the account ID, and no page content. What is
 * here: account ids, group ids and group names, dormancy bands the app derived
 * itself, and the seat price. The action log and the protected list are the
 * only records a scan cannot regenerate. A log entry holds account ids, the
 * groups left (id and name) and, for a group change Confluence refused,
 * Confluence's error text. Every account ID kept here is reported to Atlassian
 * once a week, and those of closed accounts are erased (lib/personal-data.js).
 * Display names and emails are resolved from Confluence at read time. The worst outcome of any bug
 * is a stale report — never lost customer data. That one rule removes the
 * class of failure behind the angriest reviews on the Marketplace.
 *
 * Values are sharded because a KVS value is size-limited and a large site
 * holds thousands of accounts. A user and every fact about them always land
 * in the same shard, so joins are shard-local.
 */

export const SHARDS = 16;

// A storage call that fails is tried again a few times, with a short wait,
// before the error is passed on. A long background scan should not fail on one
// storage hiccup.
const STORAGE_TRIES = 3;
const STORAGE_WAIT_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retrying(call) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= STORAGE_TRIES) throw err;
      await sleep(STORAGE_WAIT_MS * attempt);
    }
  }
}

const kvs = {
  get: (key) => retrying(() => forgeKvs.get(key)),
  set: (key, value) => retrying(() => forgeKvs.set(key, value)),
  delete: (key) => retrying(() => forgeKvs.delete(key)),
};

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
const reportIdsKey = (s) => `report:ids:${s}`;

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

/**
 * Assemble the final report, page it and publish it. The scratch data is left
 * alone: the caller deletes it once the run is closed.
 *
 * `confirm` is asked after everything has been read and before anything is
 * written. Two copies of the last slice can run at once (queue events are
 * delivered at least once); a copy that is no longer the live one must not
 * publish, and a copy that publishes has read complete data.
 */
export async function buildReport(run, meta, { confirm } = {}) {
  const all = [];
  const idsByShard = [];
  for (let s = 0; s < SHARDS; s++) {
    const rows = (await kvs.get(dormantKey(run, s))) ?? [];
    all.push(...rows);
    idsByShard.push(rows.map((r) => r.accountId));
  }
  if (confirm && !(await confirm())) return null;
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
  // Who is on the report, by shard, so a reclaim can check an account ID
  // against the current list with one read.
  for (let s = 0; s < SHARDS; s++) await kvs.set(reportIdsKey(s), idsByShard[s]);

  const report = {
    ...meta,
    generatedAt: new Date().toISOString(),
    dormantCount: dormant.length,
    dormantByProduct: Object.fromEntries(perProduct),
    pages,
    pageSize: PAGE,
    idShards: SHARDS,
  };
  await kvs.set(REPORT_META, report);

  // Pages left over from a previous, longer report would otherwise linger.
  for (let i = pages; i < (previous?.pages ?? 0); i++) await kvs.delete(reportKey(i));
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

/**
 * Which of these accounts are on the current report. A reclaim acts only on
 * people the last scan listed.
 */
export async function getReportedIds(accountIds) {
  const found = new Set();
  const meta = await kvs.get(REPORT_META);
  if (!meta) return found;
  const wanted = [...new Set((accountIds ?? []).filter(Boolean))];
  if (meta.idShards === SHARDS) {
    for (const [s, ids] of groupByShard(wanted, (id) => id)) {
      const listed = new Set((await kvs.get(reportIdsKey(s))) ?? []);
      for (const id of ids) if (listed.has(id)) found.add(id);
    }
    return found;
  }
  // A report built before the IDs were stored on their own: look through its pages.
  for (let i = 0; i < (meta.pages ?? 0) && found.size < wanted.length; i++) {
    const onPage = new Set((await getReportPage(i)).map((r) => r.accountId));
    for (const id of wanted) if (onPage.has(id)) found.add(id);
  }
  return found;
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

export const PROTECTED_KEY = 'protected';

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

// The index of actions, newest first. `log:index` holds the newest ones. When
// it grows past HEAD_MAX the oldest ids move, ARCHIVE_SIZE at a time, to
// numbered archive pages (a higher number is a newer page). Nothing is ever
// dropped: a reclaim must stay in History, with its Undo, for good. The one
// exception is the entry of a person whose Atlassian account was closed: the
// weekly personal data report takes it out (removeFromHistory), and the page
// that held it is one id shorter from then on.
const LOG_INDEX = 'log:index';
const LOG_INDEX_META = 'log:index:meta';
const HEAD_MAX = 500;
const ARCHIVE_SIZE = 250;
const RECENT_MS = 2 * 60 * 1000;
const archiveKey = (n) => `log:index:${n}`;
const logEntryKey = (id) => `log:entry:${id}`;
const latestKey = (s) => `log:latest:${s}`;

/**
 * Pure: how many ids each archive page holds, oldest page first. A page is
 * written with ARCHIVE_SIZE ids; `sizes` is kept only once one holds fewer.
 */
export const archiveSizes = (meta) =>
  Array.from({ length: meta?.archives ?? 0 }, (_, n) =>
    Number.isInteger(meta?.sizes?.[n]) && meta.sizes[n] >= 0 ? meta.sizes[n] : ARCHIVE_SIZE
  );
const indexMeta = (sizes) =>
  sizes.every((s) => s === ARCHIVE_SIZE) ? { archives: sizes.length } : { archives: sizes.length, sizes };

export const newEntryId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function saveEntry(entry) {
  // Only a new entry goes into the index; an older one may already sit in an
  // archive page, and adding it again would list it twice.
  const known = await kvs.get(logEntryKey(entry.id));
  await kvs.set(logEntryKey(entry.id), entry);
  // Two admins acting in the same second can each read the index before the
  // other's write lands. Re-reading narrows that window to a few milliseconds,
  // and a later save of a recent entry (it cannot be archived yet) heals it;
  // the entry itself is already stored either way.
  if (!known || Date.now() - Date.parse(entry.at ?? 0) < RECENT_MS) {
    await addToIndex(entry.id);
    const check = (await kvs.get(LOG_INDEX)) ?? [];
    if (!check.includes(entry.id)) await addToIndex(entry.id);
  }
  // The latest action per user lets the report mark rows already reclaimed.
  // An undo of an OLDER action must not hide a newer one.
  const key = latestKey(shardOf(entry.accountId));
  const latest = (await kvs.get(key)) ?? {};
  const current = latest[entry.accountId];
  const at = entry.updatedAt ?? entry.at;
  if (!current || current.id === entry.id || String(current.at ?? '') <= String(at ?? '')) {
    latest[entry.accountId] = { id: entry.id, status: entry.status, at };
    await kvs.set(key, latest);
  }
}

async function addToIndex(id) {
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  if (index.includes(id)) return;
  index.unshift(id);
  if (index.length > HEAD_MAX) {
    // The archive pages are written first, then their count, then the shorter
    // head: a call that dies in between repeats ids, it never loses them.
    const sizes = archiveSizes(await kvs.get(LOG_INDEX_META));
    while (index.length > HEAD_MAX) {
      await kvs.set(archiveKey(sizes.length), index.splice(index.length - ARCHIVE_SIZE));
      sizes.push(ARCHIVE_SIZE);
    }
    await kvs.set(LOG_INDEX_META, indexMeta(sizes));
  }
  await kvs.set(LOG_INDEX, index);
}

/**
 * Take an entry's id out of History's index: out of the newest ids and out
 * of every archive page, since a call that died part way can have left an id
 * in two places. The pages are written first, then the count, with each
 * page's size read from the page itself, so whatever a call that died in
 * between left is put right by the next one. The weekly personal data report
 * calls this before it deletes the entry of a closed account. Returns how
 * many copies went.
 */
export async function removeFromHistory(id) {
  let removed = 0;
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  const kept = index.filter((x) => x !== id);
  if (kept.length !== index.length) {
    removed += index.length - kept.length;
    await kvs.set(LOG_INDEX, kept);
  }
  const meta = (await kvs.get(LOG_INDEX_META)) ?? {};
  if (!meta.archives) return removed;
  const sizes = [];
  for (let n = 0; n < meta.archives; n++) {
    const page = (await kvs.get(archiveKey(n))) ?? [];
    const left = page.filter((x) => x !== id);
    if (left.length !== page.length) {
      removed += page.length - left.length;
      await kvs.set(archiveKey(n), left);
    }
    sizes.push(left.length);
  }
  const next = indexMeta(sizes);
  if (JSON.stringify(next) !== JSON.stringify(meta)) await kvs.set(LOG_INDEX_META, next);
  return removed;
}

/**
 * Take back the entry of a reclaim that changed nothing, so History lists
 * only real changes. The entry was written a moment ago, so it is still among
 * the newest ids.
 */
export async function dropEntry(entry) {
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  const at = index.indexOf(entry.id);
  if (at >= 0) {
    index.splice(at, 1);
    await kvs.set(LOG_INDEX, index);
  }
  await kvs.delete(logEntryKey(entry.id));
}

/**
 * A note on a user's row that is not a History entry: why the last try
 * changed nothing. It sits where the latest action sits, so the row shows it.
 *   status 'blocked' - this app cannot reclaim the person (an administrator,
 *                      or a group managed by an identity provider)
 *   status 'failed'  - the last try failed for another reason; it can be tried again
 */
export async function noteRow(accountId, status, reason) {
  const key = latestKey(shardOf(accountId));
  const latest = (await kvs.get(key)) ?? {};
  latest[accountId] = { id: null, status, reason, at: new Date().toISOString() };
  await kvs.set(key, latest);
}

export const getEntry = (id) => kvs.get(logEntryKey(id));

export async function getLogPage(page, size = 25) {
  const index = (await kvs.get(LOG_INDEX)) ?? [];
  const sizes = archiveSizes(await kvs.get(LOG_INDEX_META));
  const total = index.length + sizes.reduce((a, b) => a + b, 0);
  const from = Math.floor(page) * size;
  const ids = [];
  const pagesRead = new Map();
  for (let i = from; i < Math.min(total, from + size); i++) {
    if (i < index.length) {
      ids.push(index[i]);
      continue;
    }
    // Past the newest ids: archive pages, newest page first.
    let offset = i - index.length;
    let n = sizes.length - 1;
    while (n > 0 && offset >= sizes[n]) {
      offset -= sizes[n];
      n -= 1;
    }
    if (!pagesRead.has(n)) pagesRead.set(n, (await kvs.get(archiveKey(n))) ?? []);
    ids.push(pagesRead.get(n)[offset]);
  }
  const entries = [];
  for (const id of ids) {
    const e = id ? await kvs.get(logEntryKey(id)) : null;
    if (e) entries.push(e);
  }
  return { entries, total, pages: Math.max(1, Math.ceil(total / size)) };
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
// When a reclaim, an undo, History's re-check or a change to the protected
// list last started. Only the time, no account: the weekly personal data
// report does not erase while one may still be running (busy in
// personal-data.js), since each writes from what it read a moment before.
// ---------------------------------------------------------------------------

export const ACTION_KEY = 'action:started';

export const markActionStarted = () => kvs.set(ACTION_KEY, { at: new Date().toISOString() });
export const getActionStarted = () => kvs.get(ACTION_KEY);

// ---------------------------------------------------------------------------
// Settings: the yearly price of one Confluence seat. Numbers only.
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export const getSettings = async () => (await kvs.get(SETTINGS_KEY)) ?? { seatCosts: {} };

export async function saveSettings(settings) {
  await kvs.set(SETTINGS_KEY, settings);
  return settings;
}
