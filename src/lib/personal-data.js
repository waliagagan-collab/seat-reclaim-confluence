import { kvs } from '@forge/kvs';
import { SCAN_KEY, REPORT_META, PROTECTED_KEY, getScanState, getActionStarted, removeFromHistory } from './store.js';
import { STALE_AFTER_MS } from './scan.js';

/**
 * Where this app keeps Atlassian account IDs, for the weekly personal data
 * report (lib/privacy.js), and what is erased when Atlassian says an account
 * was closed:
 *
 *   report:ids:{s}           who is on the last list, the one a reclaim checks against.
 *                            A closed account is taken out.
 *   report:dormant:{i}       a page of the last list: one row per inactive user, by account ID.
 *                            A closed account's row is taken out.
 *   report:meta              the last list's totals. No account ID of its own, but a warning
 *                            can carry Confluence's error text from the scan, and that text
 *                            can quote an account ID: it becomes "(closed account)".
 *   scan:state               the scan in progress or the last one. It names nobody, but its
 *                            error text, its pause reason and its warnings can quote an
 *                            account ID from Confluence: it becomes "(closed account)".
 *   scan:{run}:users:{s}     working data of a scan: licensed users by account ID
 *   scan:{run}:active:{s}    working data: accounts the activity sweep saw contribute
 *   scan:{run}:dormant:{s}   working data: the inactive rows found so far
 *                            A closed account is taken out of each.
 *   protected                the protected list: person -> when, and the admin who protected
 *                            them (`by`). A closed person's entry is taken out; a closed
 *                            admin's `by` is cleared to null.
 *   log:entry:{id}           a History entry: the person reclaimed, the admin who approved it
 *                            (`by`), the admin who undid it (`restoredBy`), the groups left and
 *                            Confluence's error texts. An entry about a closed person is deleted,
 *                            after its id is taken out of History's index (removeFromHistory):
 *                            Undo could only give a closed account its groups back. A closed
 *                            admin's `by` or `restoredBy` is cleared to null, with `byClosed` or
 *                            `restoredByClosed` set so History says "Closed account". Error texts
 *                            get "(closed account)".
 *   log:latest:{s}           the latest action on each person, or why the last try changed
 *                            nothing, which marks their row: a closed person's note is taken out.
 *
 * No account ID is kept in History's index (`log:index`, its archive pages
 * and their count: entry ids only), in settings (the seat price, the day the
 * review request was closed), in action:started (a time) or in a queue event
 * (a run ID and a number). The report's own pdr: values are looked after by
 * lib/privacy.js.
 *
 * The list is not signed evidence: every scan builds it again. So a closed
 * account's row goes, with nothing in its place, and the totals already shown
 * (licensed, active and inactive users) stay as the scan counted them until
 * the next scan counts again. The page, the download and the Rovo agent say
 * how many users on the list are no longer listed (notListed in ui.js).
 *
 * A scan writes the list and its working data, and a reclaim, an undo,
 * History's re-check and a change to the protected list write from what they
 * read a moment before. So erasing waits while any of them may be running
 * (busy), and asks again just before each write.
 */

// --- which value a key holds ----------------------------------------------------

/** Pure: what kind of value a stored key holds, or null when it holds no account ID. */
export function kindOf(key) {
  const k = String(key ?? '');
  if (k === SCAN_KEY) return 'scanState';
  if (k === REPORT_META) return 'reportMeta';
  if (k === PROTECTED_KEY) return 'protected';
  if (/^report:dormant:\d+$/.test(k)) return 'rows';
  if (/^report:ids:\d+$/.test(k)) return 'ids';
  if (/^log:entry:[^:]+$/.test(k)) return 'entry';
  if (/^log:latest:\d+$/.test(k)) return 'latest';
  const m = k.match(/^scan:[^:]+:(users|active|dormant):\d+$/);
  if (!m) return null;
  return m[1] === 'dormant' ? 'rows' : 'byAccount';
}

// --- pure: the account IDs in each kind of value ----------------------------------

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (v) => (Array.isArray(v) ? v : []);
const accountsOf = (v) => (isObject(v) ? Object.keys(v) : []);
const valuesOf = (v) => (isObject(v) ? Object.values(v) : []);

/**
 * An account ID inside a text: Confluence's error messages can quote the one
 * in a query or a group change. Only the two forms Atlassian gives out are
 * read (24 hex digits, or a number, a colon and a UUID), so no word is ever
 * taken for an account ID.
 */
const ID_IN_TEXT = /(?<![A-Za-z0-9:_-])(?:[0-9a-f]{24}|\d{1,10}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9:_-])/gi;
const idsInText = (text) => (typeof text === 'string' ? (text.match(ID_IN_TEXT) ?? []) : []);
/** The texts a scan state keeps: why it failed, why its next slice could not be queued, and its warnings. */
const scanTexts = (s) => [s?.error, s?.pauseReason, ...rowsOf(s?.warnings)];
/** The texts a History entry keeps: Confluence's answer for each group it could not change, and for each it could not put back. */
const entryTexts = (e) => [...rowsOf(e?.groups).map((g) => g?.error), ...rowsOf(e?.restoreErrors)];

const IDS = {
  rows: (v) => rowsOf(v).map((r) => r?.accountId),
  ids: rowsOf,
  byAccount: accountsOf,
  scanState: (s) => scanTexts(s).flatMap(idsInText),
  reportMeta: (m) => rowsOf(m?.warnings).flatMap(idsInText),
  protected: (v) => [...accountsOf(v), ...valuesOf(v).map((p) => p?.by)],
  entry: (e) => [e?.accountId, e?.by, e?.restoredBy, ...entryTexts(e).flatMap(idsInText)],
  latest: (v) => [...accountsOf(v), ...valuesOf(v).flatMap((n) => idsInText(n?.reason))],
};

/** Pure: the account IDs a stored value holds (the engine keeps only those shaped like one). */
export function idsIn(key, value) {
  const kind = kindOf(key);
  return kind ? IDS[kind](value).filter((id) => typeof id === 'string') : [];
}

// --- pure: a value without the closed accounts --------------------------------------

/** What an error text says where it quoted a closed account. */
export const CLOSED_ACCOUNT = '(closed account)';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text with the closed accounts replaced: those in Atlassian's forms, and `also` (the admins a value names) in whatever form. */
function textWithout(text, closed, also = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.replace(ID_IN_TEXT, (id) => (closed.has(id) ? CLOSED_ACCOUNT : id));
  for (const id of also) {
    if (typeof id === 'string' && id && closed.has(id) && out.includes(id)) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9:_-])${escape(id)}(?![A-Za-z0-9:_-])`, 'g'), CLOSED_ACCOUNT);
    }
  }
  return out;
}

const textsWithout = (list, closed) => (Array.isArray(list) ? list.map((t) => textWithout(t, closed)) : list);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SCRUB = {
  rows(v, closed) {
    const all = rowsOf(v);
    const kept = all.filter((r) => !closed.has(r?.accountId));
    return kept.length === all.length ? undefined : kept;
  },
  ids(v, closed) {
    const all = rowsOf(v);
    const kept = all.filter((id) => !closed.has(id));
    return kept.length === all.length ? undefined : kept;
  },
  byAccount(v, closed) {
    if (!accountsOf(v).some((a) => closed.has(a))) return undefined;
    return Object.fromEntries(Object.entries(v).filter(([a]) => !closed.has(a)));
  },
  scanState(s, closed) {
    if (!isObject(s)) return undefined;
    const out = { ...s };
    for (const f of ['error', 'pauseReason']) if (typeof s[f] === 'string') out[f] = textWithout(s[f], closed);
    if (Array.isArray(s.warnings)) out.warnings = textsWithout(s.warnings, closed);
    return same(out, s) ? undefined : out;
  },
  reportMeta(m, closed) {
    if (!isObject(m) || !Array.isArray(m.warnings)) return undefined;
    const out = { ...m, warnings: textsWithout(m.warnings, closed) };
    return same(out, m) ? undefined : out;
  },
  protected(v, closed) {
    if (!isObject(v)) return undefined;
    const out = {};
    for (const [a, p] of Object.entries(v)) {
      if (closed.has(a)) continue;
      out[a] = isObject(p) && closed.has(p.by) ? { ...p, by: null } : p;
    }
    return same(out, v) ? undefined : out;
  },
  entry(e, closed) {
    if (!isObject(e)) return undefined;
    // An entry about a closed person goes (null): see personalDataSources.
    if (closed.has(e.accountId)) return null;
    const also = [e.by, e.restoredBy];
    const out = { ...e };
    if (closed.has(e.by)) Object.assign(out, { by: null, byClosed: true });
    if (closed.has(e.restoredBy)) Object.assign(out, { restoredBy: null, restoredByClosed: true });
    if (Array.isArray(e.groups)) out.groups = e.groups.map((g) => (isObject(g) && typeof g.error === 'string' ? { ...g, error: textWithout(g.error, closed, also) } : g));
    if (Array.isArray(e.restoreErrors)) out.restoreErrors = e.restoreErrors.map((t) => textWithout(t, closed, also));
    return same(out, e) ? undefined : out;
  },
  latest(v, closed) {
    if (!isObject(v)) return undefined;
    const out = {};
    for (const [a, note] of Object.entries(v)) {
      if (closed.has(a)) continue;
      out[a] = isObject(note) && typeof note.reason === 'string' ? { ...note, reason: textWithout(note.reason, closed) } : note;
    }
    return same(out, v) ? undefined : out;
  },
};

/**
 * Pure: a stored value without the closed accounts, undefined when it holds
 * none of them, or null for a History entry about a closed person (it is
 * deleted). A page that loses its last row stays, empty, so the list keeps
 * the number of pages it says it has.
 */
export function scrubbed(key, value, closed) {
  const kind = kindOf(key);
  if (!kind || value === undefined || value === null || !closed?.size) return undefined;
  return SCRUB[kind](value, closed);
}

// --- when erasing waits -------------------------------------------------------------

/**
 * Pure: is a scan running that has moved in the last 20 minutes? A paused
 * scan counts while it is recent: the page picks it up within seconds. One
 * that nobody picked up for 20 minutes, like one that stopped moving, does
 * not hold erasing back; if it goes on later it finds its working data
 * without the closed accounts, which only means fewer users to count.
 */
export function scanLive(state, at = Date.now()) {
  if (state?.status !== 'running') return false;
  const moved = Date.parse(state.updatedAt ?? state.startedAt ?? '');
  return Number.isFinite(moved) && at - moved <= STALE_AFTER_MS;
}

/** A reclaim, an undo, History's re-check or a protect is one resolver call, which Forge stops after 25 seconds. */
export const ACTION_LIVE_MS = 60_000;

/** Pure: may an action that started at `mark.at` still be running? */
export function actionLive(mark, at = Date.now()) {
  const started = Date.parse(mark?.at ?? '');
  return Number.isFinite(started) && at - started < ACTION_LIVE_MS;
}

/**
 * True while a scan runs (it writes its state, its working data and, at the
 * end, the list) or a reclaim, an undo, History's re-check or a protect may
 * (they write History, its index, the notes on rows and the protected list),
 * so erasing waits.
 */
export async function busy(readScan = getScanState, readAction = getActionStarted, now = Date.now) {
  const [scan, action] = await Promise.all([readScan(), readAction()]);
  const at = now();
  return scanLive(scan, at) || actionLive(action, at);
}

export const BUSY_MESSAGE = 'A scan, or a change to History or the protected list, started while closed accounts were being erased; erasing goes on at the next run.';

// --- the sources --------------------------------------------------------------------

/** The characters this app's stored keys use after a prefix (see narrower in privacy.js). */
const KEY_CHARS = '-0123456789:abcdefghijklmnopqrstuvwxyz';
const ENTRY_PREFIX = 'log:entry:';

/**
 * `store` is @forge/kvs, or a stand-in in tests; `live` is busy; `unlist`
 * takes an entry's id out of History's index. Each write asks first whether
 * the app has started writing since the report last asked (it asks at most
 * every 2 seconds), then reads the value again, so neither a scan's write nor
 * a reclaim's is put back to an older copy.
 */
export function personalDataSources(store = kvs, live = busy, unlist = removeFromHistory) {
  const erase = async (key, closed) => {
    if (await live()) throw new Error(BUSY_MESSAGE);
    const fresh = await store.get(key);
    if (fresh === undefined || fresh === null) return false;
    const next = scrubbed(key, fresh, closed);
    if (next === undefined) return false;
    if (next === null) {
      // Off History's index first, then gone: the index never lists an entry
      // that is not there, and one cut short is found again next week.
      await unlist(key.slice(ENTRY_PREFIX.length));
      await store.delete(key);
    } else await store.set(key, next);
    return true;
  };
  const source = (where) => ({
    ...where,
    chars: KEY_CHARS,
    ids: (value, key) => idsIn(key, value),
    scrub: (value, key, closed) => scrubbed(key, value, closed),
    erase,
  });
  return [
    // Who may be reclaimed goes first, so a closed account is never reclaimed while its row is still there.
    source({ prefix: 'report:ids:' }),
    source({ prefix: 'report:dormant:' }),
    source({ key: REPORT_META }),
    source({ prefix: 'scan:' }),
    source({ key: PROTECTED_KEY }),
    // History can hold thousands of entries: read 100 at a time, the most a query gives.
    source({ prefix: ENTRY_PREFIX, pageSize: 100 }),
    source({ prefix: 'log:latest:' }),
  ];
}

export const SOURCES = personalDataSources();
