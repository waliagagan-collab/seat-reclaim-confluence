import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  statusOf,
  normaliseStatus,
  listOptions,
  filterCandidates,
  reclaimSummary,
  listAnswer,
  candidateLine,
  historyLine,
  historyLimit,
  MAX_LIMIT,
} from '../src/lib/agent.js';

const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');

const ready = {
  accountId: 'r', displayName: 'Ria Ready', email: 'ria@x.com', bucket: 'over-365', label: 'Over a year, or never',
  reclaimable: true, pending: false, isProtected: false, freedProducts: ['Confluence'],
  removeGroups: ['confluence-users-site'], reason: null, lastAction: null,
};
const admin = {
  accountId: 'a', displayName: 'Ada Admin', email: null, bucket: '90-180', label: '90–180 days',
  reclaimable: false, isProtected: false, freedProducts: [], removeGroups: [],
  reason: 'Access comes from an admin group (org-admins). Remove their admin role in Atlassian Administration first.', lastAction: null,
};
const done = {
  accountId: 'd', displayName: 'Dev Done', email: null, bucket: 'over-365', label: 'Over a year, or never',
  reclaimable: true, isProtected: false, freedProducts: ['Confluence'], removeGroups: ['confluence-users-site'],
  reason: null, lastAction: { status: 'reclaimed' },
};
const rows = [ready, admin, done];

test('status groups match the page: ready, blocked, already reclaimed', () => {
  assert.equal(statusOf(ready), 'ready');
  assert.equal(statusOf(admin), 'blocked');
  assert.equal(statusOf(done), 'reclaimed');
  assert.equal(statusOf({ ...ready, isProtected: true }), 'blocked');
  // A partial reclaim left groups behind, so the user can be reclaimed again.
  assert.equal(statusOf({ ...ready, lastAction: { status: 'partial' } }), 'ready');
  assert.equal(statusOf({ ...ready, lastAction: { status: 'restored' } }), 'ready');
});

test('status words from the agent are understood', () => {
  assert.equal(normaliseStatus('ready'), 'ready');
  assert.equal(normaliseStatus('ready to reclaim'), 'ready');
  assert.equal(normaliseStatus("can't reclaim"), 'blocked');
  assert.equal(normaliseStatus('cannot'), 'blocked');
  assert.equal(normaliseStatus('already reclaimed'), 'reclaimed');
  assert.equal(normaliseStatus('all'), null);
  assert.equal(normaliseStatus(''), null);
  assert.equal(listOptions({ limit: 999 }).limit, MAX_LIMIT);
});

test('candidates filter by status, days and search', () => {
  const ids = (o) => filterCandidates(rows, { ...listOptions({}), ...o }).map((u) => u.accountId);
  assert.deepEqual(ids({ status: 'ready' }), ['r']);
  assert.deepEqual(ids({ minDays: 365 }), ['r', 'd']);
  assert.deepEqual(ids({ search: 'ADA' }), ['a']);
});

test('a candidate line shows the groups reclaiming would remove, or why it cannot', () => {
  assert.deepEqual(candidateLine(ready).wouldLeaveGroups, ['confluence-users-site']);
  assert.equal(candidateLine(ready).reason, null);
  assert.equal(candidateLine({ ...ready, pending: true, removeGroups: [] }).groupsReadAtReclaim, true);
  // The plan ignores the protected list; the line must still say why.
  assert.equal(candidateLine({ ...ready, isProtected: true }).status, "Can't reclaim");
  assert.match(candidateLine({ ...ready, isProtected: true }).reason, /protected list/);
  assert.deepEqual(candidateLine(admin).wouldLeaveGroups, []);
  assert.match(candidateLine(admin).reason, /admin group/);
  assert.equal(candidateLine(done).status, 'Already reclaimed');
});

test('the summary counts groups and prices only a saved price', () => {
  const meta = {
    generatedAt: '2026-10-13T12:00:00Z', days: 90, totalUsers: 10,
    accessGroups: [{ id: 'g', name: 'confluence-users-site', admin: false }, { id: 'o', name: 'org-admins', admin: true }],
  };
  const s = reclaimSummary(meta, rows, { seatCosts: { Confluence: 120 } });
  assert.equal(s.licensedUsers, 10);
  assert.equal(s.readyToReclaim, 1);
  assert.equal(s.cannotReclaim, 1);
  assert.equal(s.alreadyReclaimed, 1);
  assert.equal(s.estimatedYearlySaving, 120);
  assert.equal(s.whyNot.length, 1);
  assert.deepEqual(s.groupsThatGrantConfluence[1], { group: 'org-admins', adminGroupNeverRemoved: true });
  assert.equal(reclaimSummary(meta, rows, { seatCosts: {} }).estimatedYearlySaving, null);
  assert.match(reclaimSummary(meta, rows, { seatCosts: {} }).pricesNote, /No seat price/);
  assert.equal(reclaimSummary(meta, [admin, done], { seatCosts: {} }).estimatedYearlySaving, 0);
});

test('the list answer notes when more match than were shown', () => {
  const a = listAnswer({ days: 90 }, listOptions({ limit: 1 }), rows);
  assert.equal(a.matchingUsers, 3);
  assert.equal(a.shown, 1);
  assert.match(a.note, /first 1 of 3/);
});

test('history lines name people, say whether Confluence confirmed the seat, and whether it was undone', () => {
  const name = (id) => ({ u1: 'Ria Ready', me: 'Gagan' })[id] ?? null;
  const h = historyLine({ accountId: 'u1', by: 'me', status: 'restored', at: 't1', restoredAt: 't2', restoredBy: 'me', seatFreed: true, groups: [{ name: 'confluence-users-site', ok: true }, { name: 'x', ok: false }] }, name);
  assert.equal(h.outcome, 'Undone');
  assert.equal(h.user, 'Ria Ready');
  assert.deepEqual(h.groupsLeft, ['confluence-users-site']);
  assert.equal(h.confluenceConfirmedSeatFree, true);
  assert.equal(h.undoneBy, 'Gagan');
  assert.equal(historyLine({ accountId: 'u1', status: 'reclaimed', seatFreed: null, groups: [] }, name).confluenceConfirmedSeatFree, null);
  assert.equal(historyLimit({}), 10);
  assert.equal(historyLimit({ limit: 500 }), 25);
});

test('the agent entry point loads and exports every handler the manifest names', async () => {
  const mod = await import('../src/agent.js');
  const handlers = [...manifest.matchAll(/handler:\s*agent\.(\w+)/g)].map((m) => m[1]);
  assert.equal(handlers.length, 3);
  for (const h of handlers) assert.equal(typeof mod[h], 'function', `agent.${h} must be exported`);
});

test('the agent cannot change access: GET actions only, and no reclaim or undo code', () => {
  const verbs = [...manifest.matchAll(/actionVerb:\s*(\w+)/g)].map((m) => m[1]);
  assert.equal(verbs.length, 3);
  assert.ok(verbs.every((v) => v === 'GET'));
  for (const fn of ['removeFromGroups', 'addToGroups', 'saveEntry', 'setProtected', 'queue.push']) {
    assert.ok(!agentSource.includes(fn), `agent.js must not use ${fn}`);
  }
  assert.ok(!/required:\s*true/.test(manifest.split('rovo:agent:')[1].split('  function:')[0]));
});
