import { checkAdmin, refusal } from './lib/admin.js';
import { getReportMeta, getAllReportRows, getSettings, getLogPage } from './lib/store.js';
import { fetchProfiles } from './lib/confluence.js';
import { decorate } from './lib/decorate.js';
import {
  NO_REPORT,
  listOptions,
  filterCandidates,
  reclaimSummary,
  listAnswer,
  historyLine,
  historyLimit,
} from './lib/agent.js';

/**
 * Rovo agent actions. Every one is read-only and runs only for a confirmed
 * Confluence administrator, checked as the calling user exactly like the
 * page's resolvers. Nothing here can reclaim or undo: those stay on the page,
 * behind a confirmation. Inputs come from a language model, so they are never
 * trusted for anything but filtering.
 */

const ROW_LIMIT = 5000;

const action = (fn) => async (payload, context) => {
  const gate = await checkAdmin();
  if (gate?.allowed !== true) return refusal(gate?.reason).error;
  try {
    return await fn(payload ?? {}, context);
  } catch (err) {
    console.error('agent action failed:', err?.message ?? String(err));
    return 'Seat Reclaim could not read its data just now. Try again in a minute, or open the app in Confluence administration → Settings → Apps.';
  }
};

// The page marks "this is you" from the caller's account ID; Rovo passes it in
// the action context, so the agent applies the same rule.
// Agent functions get the caller as `context.principal`; resolvers as `context.accountId`.
const caller = (payload, context) => ({
  accountId: context?.principal?.accountId ?? context?.accountId ?? payload?.context?.accountId,
});

export const getReclaimSummary = action(async (payload, context) => {
  const meta = await getReportMeta();
  if (!meta) return NO_REPORT;
  const [rows, settings] = await Promise.all([
    getAllReportRows(ROW_LIMIT).then((r) => decorate(r, caller(payload, context))),
    getSettings(),
  ]);
  return reclaimSummary(meta, rows, settings);
});

export const listReclaimCandidates = action(async (payload, context) => {
  const meta = await getReportMeta();
  if (!meta) return NO_REPORT;
  const opts = listOptions(payload);
  const rows = await decorate(await getAllReportRows(ROW_LIMIT), caller(payload, context));
  return listAnswer(meta, opts, filterCandidates(rows, opts));
});

export const getReclaimHistory = action(async (payload) => {
  const { entries, total } = await getLogPage(0, historyLimit(payload));
  if (!entries.length) return 'No seats have been reclaimed with Seat Reclaim on this site yet.';
  const people = await fetchProfiles(entries.flatMap((e) => [e.accountId, e.by, e.restoredBy]));
  const name = (id) => (id ? (people[id]?.displayName ?? '(unknown)') : null);
  return { totalActions: total, shown: entries.length, actions: entries.map((e) => historyLine(e, name)) };
});
