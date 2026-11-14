import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeSite, item } from './fakes/confluence-site.js';
import { kvs, WhereConditions } from './fakes/forge-kvs.js';
import { privacy } from './fakes/forge-api.js';
import { loadServer, reset, drain, call, stored } from './helpers.js';
import { runSlice, kvsStore } from '../src/lib/privacy.js';

/**
 * The weekly personal data report on a fake site: a scan stores the account
 * IDs of inactive users and, while it runs, of every licensed user; a reclaim
 * and an undo store the person and the admins in History; the protected list
 * stores the person and who protected them; Confluence's error texts can
 * quote an account ID. Atlassian says some accounts were closed; after the
 * report none of their account IDs is left, the other values are as they
 * were, History still pages, and a scan still runs.
 */

let server;
let personal;
let site;

const ALICE = '5b10ac8d82e05b22cc7d4e01'; // inactive, reclaimed, closes her account
const BOB = '5b10ac8d82e05b22cc7d4e02'; // inactive, reclaimed and put back, protected
const CAROL = '5b10ac8d82e05b22cc7d4e03'; // active
const DAN = '5b10ac8d82e05b22cc7d4e04'; // inactive, protected, closes his account
const EVE = '5b10ac8d82e05b22cc7d4e05'; // inactive, a reclaim Confluence refused
const FRANK = '5b10ac8d82e05b22cc7d4e06'; // inactive, an admin role given to him directly
const ADMIN = '712020:2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'; // scans, reclaims and undoes; closes too
const OTHER_ADMIN = '5b10ac8d82e05b22cc7d4e09';
const PEOPLE = [ALICE, BOB, CAROL, DAN, EVE, FRANK, ADMIN, OTHER_ADMIN];

before(async () => {
  server = await loadServer();
  personal = server.personal;
});

beforeEach(() => {
  site = makeSite();
  // A second group that grants Confluence, so a reclaim can be half refused.
  site.groups['g-users2'] = { name: 'confluence-users-contractors', members: [], access: 'user' };
  for (const id of [ADMIN, OTHER_ADMIN]) {
    site.addUser(id, ['g-users', 'g-site']);
    site.lastCreated[id] = 1;
  }
  site.addUser(ALICE, ['g-users', 'g-team']);
  site.addUser(BOB, ['g-users', 'g-users2']);
  site.addUser(CAROL, ['g-users']);
  site.addUser(DAN, ['g-users']);
  // The activity sweep sees Carol edit a page yesterday.
  site.sweep = [item('page', 'p1', CAROL, 1)];
  reset(site);
});

async function scan(by = ADMIN) {
  const started = await call(server, 'startScan', { days: 90 }, by);
  assert.equal(started.ok, true, started.error);
  for (let i = 0; i < 20; i++) {
    const res = await call(server, 'listUsers', { run: started.state.run }, by);
    assert.equal(res.ok, true, res.error);
    if (res.done) break;
  }
  await drain(server);
  return stored('scan:state');
}

async function reclaim(accountId, by) {
  const res = await call(server, 'reclaim', { accountIds: [accountId] }, by);
  assert.equal(res.ok, true, res.error);
  return res.results[0];
}

/** A reclaim, an undo or a protect that started more than a minute ago is over. */
const actionsOver = () => globalThis.__kvs.set('action:started', { at: new Date(Date.now() - 2 * 60_000).toISOString() });

const slice = () => runSlice({ store: kvsStore(kvs, WhereConditions), report: privacy.reportPersonalData, sources: personal.SOURCES, busy: personal.busy });

/** Every slice the hourly trigger would run, until this week's report is done. */
async function runReport() {
  for (let i = 0; i < 50; i++) {
    await slice();
    if (stored('pdr:state')?.phase === 'idle') return stored('pdr:state').last;
  }
  throw new Error('the report did not finish');
}

const appValues = () => [...globalThis.__kvs.entries()].filter(([k]) => !k.startsWith('pdr:'));
const storedText = () => JSON.stringify(appValues());
const listed = () => appValues().filter(([k]) => k.startsWith('report:dormant:')).flatMap(([, rows]) => rows.map((r) => r.accountId)).sort();
const onList = () => appValues().filter(([k]) => k.startsWith('report:ids:')).flatMap(([, ids]) => ids).sort();
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

async function allHistory() {
  const first = await server.store.getLogPage(0, 25);
  const pages = [];
  for (let p = 0; p < first.pages; p++) pages.push((await server.store.getLogPage(p, 25)).entries);
  return { total: first.total, pages, ids: pages.flat().map((e) => e.id) };
}

// --- every key the app writes ------------------------------------------------------

/**
 * Every key the app writes, and whether a source reads it ('source') or it
 * holds no account ID ('none'). The report's own pdr: keys are left out: they
 * belong to lib/privacy.js, which deletes the account IDs it gathered when a
 * report ends.
 */
const KEYS = {
  'scan:state': 'source', // the scan in progress or the last one: Confluence's error texts and warnings
  'scan:{run}:users:{s}': 'source', // working data: licensed users by account ID
  'scan:{run}:active:{s}': 'source', // working data: accounts seen contributing
  'scan:{run}:dormant:{s}': 'source', // working data: inactive rows so far
  'report:meta': 'source', // totals, groups, and warnings that can carry Confluence's error text
  'report:dormant:{i}': 'source', // the last list's rows
  'report:ids:{s}': 'source', // who is on the last list
  protected: 'source', // the protected list: who, when, and the admin who protected them
  'log:index': 'none', // History's newest entry ids
  'log:index:meta': 'none', // how many archive pages, and their sizes
  'log:index:{n}': 'none', // an archive page of entry ids
  'log:entry:{id}': 'source', // a History entry: the person, who approved, who undid, Confluence's texts
  'log:latest:{s}': 'source', // the latest action on each person, or why the last try changed nothing
  'action:started': 'none', // when a reclaim, an undo, a re-check or a protect last started
  settings: 'none', // the seat price, the day the review request was closed
};
const sample = (pattern) => pattern.replace('{run}', '1762000000000').replace('{id}', '1762000000000-abc123').replace(/\{\w+\}/g, '3');
const patternOf = (key) =>
  Object.keys(KEYS).find((p) => new RegExp(`^${p.replace('{id}', '[^:]+').replace(/\{\w+\}/g, '\\d+')}$`).test(key));
const covered = (key) => personal.SOURCES.some((s) => (s.key ? s.key === key : key.startsWith(s.prefix)));

test('every key the app writes is listed, and each is read by a source or holds no account ID', () => {
  // The key names in store.js are the only keys the app writes besides the report's own.
  const store = readFileSync(new URL('../src/lib/store.js', import.meta.url), 'utf8');
  const defined = [...store.matchAll(/^(?:export )?const \w*(?:KEY|META|INDEX|Key)\w* = (?:\([^)]*\) => )?[`'"]([^`'"]+)[`'"]/gm)].map((m) => m[1].replace(/\$\{(\w+)\}/g, '{$1}'));
  assert.deepEqual(defined.sort(), Object.keys(KEYS).sort(), 'a key was added to or taken from store.js: list it here, and give it a source if it can hold an account ID');
  for (const [pattern, what] of Object.entries(KEYS)) {
    const key = sample(pattern);
    assert.equal(patternOf(key), pattern);
    assert.equal(personal.kindOf(key) !== null, what === 'source', pattern);
    assert.equal(covered(key), what === 'source', `${pattern} is walked by a source`);
  }
  // Nothing else in src writes to storage.
  const files = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  for (const file of files('../src/')) {
    if (['../src/lib/store.js', '../src/lib/privacy.js', '../src/lib/personal-data.js', '../src/privacy.js'].includes(file)) continue;
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/@forge\/kvs|\bkvs\.|\bstorage\.(set|get|delete)\b/.test(text), `${file} must not write storage itself`);
  }
});

test('every account ID in every value the app writes is found: scans, reclaims, undos, refusals, the admin check, the protected list, settings', async () => {
  site.addUser(EVE, ['g-users']);
  site.addUser(FRANK, ['g-users'], { adminRole: true });
  await scan();
  assert.equal(stored('scan:state').status, 'complete');
  assert.equal((await call(server, 'saveSettings', { seatCosts: { Confluence: 70 } }, ADMIN)).ok, true);
  assert.equal((await call(server, 'hideReviewPrompt', {}, ADMIN)).ok, true);
  assert.equal((await call(server, 'setProtected', { accountId: DAN, protected: true }, OTHER_ADMIN)).ok, true);
  // A long History, so the next entry moves the oldest ids to an archive page.
  globalThis.__kvs.set('log:index', Array.from({ length: 500 }, (_, n) => `1700000000000-old${n}`));
  assert.equal((await reclaim(ALICE, ADMIN)).ok, true);
  // A reclaim Confluence half refused, quoting the person, and an undo it refused once.
  site.once['DELETE /wiki/rest/api/group/userByGroupId'] = [{ status: 500, body: { message: `Could not remove ${BOB} from the group.` } }];
  const partial = await reclaim(BOB, OTHER_ADMIN);
  assert.equal(partial.partial, true);
  site.once['POST /wiki/rest/api/group/userByGroupId'] = [{ status: 500, body: { message: `Could not add ${BOB}.` } }];
  assert.equal((await call(server, 'undo', { entryId: partial.entryId }, ADMIN)).ok, false);
  assert.ok(stored(`log:entry:${partial.entryId}`).restoreErrors[0].includes(BOB));
  assert.equal((await call(server, 'undo', { entryId: partial.entryId }, ADMIN)).ok, true);
  // A reclaim Confluence refused outright: the reason stays on the row.
  site.once['DELETE /wiki/rest/api/group/userByGroupId'] = [{ status: 400, body: { message: `User ${EVE} cannot be removed from this group.` } }];
  assert.equal((await reclaim(EVE, ADMIN)).ok, false);
  assert.ok((await server.store.getLatestFor([EVE]))[EVE].reason.includes(EVE));
  // Someone Confluence says can administer it: the row is marked, nothing changes.
  assert.equal((await reclaim(FRANK, ADMIN)).skipped, true);
  assert.equal((await server.store.getLatestFor([FRANK]))[FRANK].status, 'blocked');
  // A scan whose groups could not be read, with the admin quoted in the warning.
  site.once['GET /wiki/rest/api/group'] = [{ status: 403, body: { message: `User ${ADMIN} may not list groups.` } }];
  await scan();
  assert.ok(stored('report:meta').warnings.some((w) => w.includes(ADMIN)));
  // A scan Confluence refused, with the admin quoted in the error.
  site.once['GET /wiki/rest/api/content/search'] = [{ status: 400, body: { message: `The value '${ADMIN}' is not valid.` } }];
  await scan();
  assert.equal(stored('scan:state').status, 'failed');
  assert.ok(stored('scan:state').error.includes(ADMIN));

  const seen = new Set();
  for (const [key, value] of globalThis.__kvsSets) {
    const pattern = patternOf(key);
    assert.ok(pattern, `${key} is not in the list of keys`);
    seen.add(pattern);
    const text = JSON.stringify(value);
    const held = PEOPLE.filter((id) => text.includes(id));
    if (KEYS[pattern] === 'none') assert.deepEqual(held, [], `${key} holds no account ID`);
    else for (const id of held) assert.ok(personal.idsIn(key, value).includes(id), `${key}: ${id} is found`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(KEYS).sort(), 'every listed key was written in these runs');
});

// --- the weekly report over a whole site ------------------------------------------

test('closed accounts are erased everywhere; the others stay, and the totals already shown stay', async () => {
  const state = await scan();
  assert.deepEqual(listed(), [ALICE, BOB, DAN]);
  const first = await reclaim(ALICE, ADMIN);
  const second = await reclaim(BOB, OTHER_ADMIN);
  assert.equal((await call(server, 'undo', { entryId: second.entryId }, ADMIN)).ok, true);
  assert.equal((await call(server, 'setProtected', { accountId: DAN, protected: true }, OTHER_ADMIN)).ok, true);
  assert.equal((await call(server, 'setProtected', { accountId: BOB, protected: true }, ADMIN)).ok, true);
  actionsOver();
  const meta = stored('report:meta');
  const bobNote = (await server.store.getLatestFor([BOB]))[BOB];
  const protectedAt = stored('protected')[BOB].at;

  globalThis.__closed = [ALICE, DAN, ADMIN];
  const last = await runReport();
  assert.deepEqual(new Set(globalThis.__reported.map((a) => a.accountId)), new Set([ALICE, BOB, DAN, ADMIN, OTHER_ADMIN]), 'every stored account is reported');
  assert.equal(globalThis.__reported.length, 5, 'once each');
  assert.equal(last.closed, 3);

  for (const id of [ALICE, DAN, ADMIN]) assert.ok(!storedText().includes(id), `${id} is erased`);
  assert.ok(![...globalThis.__kvs.keys()].some((k) => k.startsWith('pdr:ids:') || k.startsWith('pdr:closed:')), 'the gathered IDs go when the report ends');
  assert.deepEqual(listed(), [BOB]);
  assert.deepEqual(onList(), [BOB]);
  assert.deepEqual(stored('report:meta'), meta, 'totals stay as the scan counted them');
  assert.deepEqual(stored('scan:state'), state, 'the scan state names nobody');
  assert.deepEqual(stored('protected'), { [BOB]: { at: protectedAt, by: null } });
  // History: Alice's entry is gone, Bob's stays with the closed admin cleared.
  assert.equal(await server.store.getEntry(first.entryId), undefined);
  const { total, ids } = await allHistory();
  assert.equal(total, 1);
  assert.deepEqual(ids, [second.entryId]);
  const entry = await server.store.getEntry(second.entryId);
  assert.equal(entry.by, OTHER_ADMIN);
  assert.equal(entry.restoredBy, null);
  assert.equal(entry.restoredByClosed, true);
  assert.equal(entry.status, 'restored');
  assert.deepEqual(await server.store.getLatestFor([ALICE, BOB]), { [BOB]: bobNote });

  // The next scan works, and counts again.
  for (const g of Object.values(site.groups)) g.members = g.members.filter((id) => id !== DAN && id !== ADMIN);
  await scan(OTHER_ADMIN);
  assert.equal(stored('scan:state').status, 'complete');
  assert.equal(stored('report:meta').dormantCount, 1);
  assert.deepEqual(listed(), [BOB]);
});

test('no closed account: nothing changes but the report state', async () => {
  await scan();
  await reclaim(ALICE, ADMIN);
  await call(server, 'setProtected', { accountId: DAN, protected: true }, ADMIN);
  actionsOver();
  const keep = new Map(appValues());
  const last = await runReport();
  assert.equal(last.closed, 0);
  assert.equal(last.accounts, 4);
  assert.deepEqual(new Map(appValues()), keep);
});

test('the admin check still holds after the report, and a closed admin\'s blocked note goes', async () => {
  site.addUser(FRANK, ['g-users'], { adminRole: true });
  await scan();
  assert.deepEqual(listed(), [ALICE, BOB, DAN, FRANK]);
  const refused = await reclaim(FRANK, ADMIN);
  assert.equal(refused.skipped, true);
  assert.match(refused.error, /Can administer Confluence/);
  actionsOver();

  globalThis.__closed = [ALICE];
  await runReport();
  assert.ok(!storedText().includes(ALICE));
  // Frank is still refused, and his row still says why.
  assert.equal((await reclaim(FRANK, OTHER_ADMIN)).skipped, true);
  assert.equal(site.removed.length, 0, 'no group was left');
  const rows = (await call(server, 'getAllRows', {}, OTHER_ADMIN)).rows;
  assert.equal(rows.find((r) => r.accountId === FRANK).lastAction.status, 'blocked');

  actionsOver();
  globalThis.__closed = [FRANK];
  globalThis.__kvs.set('pdr:state', { phase: 'idle', last: null });
  await runReport();
  assert.ok(!storedText().includes(FRANK));
  assert.deepEqual(await server.store.getLatestFor([FRANK]), {});
});

test('History still pages correctly after the entries of a closed account in the middle of an archive page go', async () => {
  const { store } = server;
  await scan();
  const entry = (n) => {
    const at = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    return { id: `${Date.UTC(2026, 0, 1) + n}-e${n}`, type: 'reclaim', accountId: `u-${n}`, by: OTHER_ADMIN, at, updatedAt: at, status: 'reclaimed', groups: [{ groupId: 'g-users', name: 'confluence-users-acme', products: ['Confluence'], ok: true }] };
  };
  for (let n = 0; n < 100; n++) await store.saveEntry(entry(n));
  // Alice is reclaimed, put back and reclaimed again: two entries.
  const one = await reclaim(ALICE, ADMIN);
  assert.equal((await call(server, 'undo', { entryId: one.entryId }, ADMIN)).ok, true);
  const two = await reclaim(ALICE, ADMIN);
  for (let n = 100; n < 600; n++) await store.saveEntry(entry(n));
  // Both of hers now sit in the oldest archive page, with 100 older entries after them.
  assert.ok(stored('log:index:0').includes(one.entryId) && stored('log:index:0').includes(two.entryId));
  const before = (await allHistory()).ids;
  actionsOver();

  globalThis.__closed = [ALICE];
  const last = await runReport();
  assert.equal(last.closed, 1);
  assert.ok(!storedText().includes(ALICE));
  const after = await allHistory();
  assert.equal(after.total, 600);
  assert.deepEqual(after.ids, before.filter((id) => id !== one.entryId && id !== two.entryId), 'every other entry, once, newest first');
  after.pages.forEach((p, i) => assert.equal(p.length, i < after.pages.length - 1 ? 25 : 600 - 25 * (after.pages.length - 1), `page ${i} is full`));
  assert.equal(stored('log:index:meta').sizes[0], 248);
  const tab = await call(server, 'getHistory', { page: 23 }, OTHER_ADMIN);
  assert.equal(tab.total, 600);
  assert.equal(tab.entries.at(-1).accountId, 'u-0', 'the oldest entry is still on the last page');
  // An open History page that still shows her entry: Undo says it is gone.
  assert.deepEqual(await call(server, 'undo', { entryId: two.entryId }, OTHER_ADMIN), { ok: false, error: 'That action was not found.' });
});

test('erasing waits while a reclaim, an undo, a protect or History\'s re-check may still be running', async () => {
  await scan();
  const done = await reclaim(ALICE, ADMIN);
  globalThis.__closed = [ALICE];
  for (let i = 0; i < 4; i++) await slice();
  assert.equal(stored('pdr:state').phase, 'erase');
  assert.ok(stored('pdr:state').waits >= 1);
  assert.ok(storedText().includes(ALICE), 'nothing erased within a minute of a reclaim');

  const holds = async (what, act) => {
    actionsOver();
    await act();
    const waits = stored('pdr:state').waits;
    await slice();
    assert.equal(stored('pdr:state').waits, waits + 1, `${what} holds it back too`);
    assert.ok(storedText().includes(ALICE));
  };
  await holds('an undo', async () => assert.equal((await call(server, 'undo', { entryId: done.entryId }, OTHER_ADMIN)).ok, true));
  await holds('a protect', async () => assert.equal((await call(server, 'setProtected', { accountId: DAN, protected: true }, OTHER_ADMIN)).ok, true));
  // History re-asks Confluence about a recent entry it could not confirm, and saves the answer.
  const second = await reclaim(BOB, OTHER_ADMIN);
  assert.equal(second.ok, true);
  globalThis.__kvs.set(`log:entry:${second.entryId}`, { ...stored(`log:entry:${second.entryId}`), seatFreed: null });
  await holds('History\'s re-check', async () => assert.equal((await call(server, 'getHistory', { page: 0 }, OTHER_ADMIN)).ok, true));
  assert.equal(stored(`log:entry:${second.entryId}`).seatFreed, true);

  actionsOver();
  await runReport();
  assert.ok(!storedText().includes(ALICE));
});

test('erasing waits while a scan runs; once it stops moving, its working data is erased too and it can still finish', async () => {
  await scan();
  globalThis.__closed = [ALICE, ADMIN];
  // A new scan, part way: its working data holds every licensed user.
  const started = await call(server, 'startScan', { days: 90 }, ADMIN);
  assert.equal(started.ok, true);
  assert.equal((await call(server, 'listUsers', { run: started.state.run }, ADMIN)).done, true);
  while (stored('scan:state').phase !== 'verify') await server.worker.handler(globalThis.__queue.shift());
  const scratch = [...globalThis.__kvs.keys()].filter((k) => /^scan:\d+:/.test(k));
  assert.ok(scratch.some((k) => k.includes(':users:')) && scratch.some((k) => k.includes(':active:')));

  for (let i = 0; i < 4; i++) await slice();
  assert.equal(stored('pdr:state').phase, 'erase');
  assert.ok(stored('pdr:state').waits >= 1);
  assert.ok(storedText().includes(ALICE), 'nothing erased while the scan runs');

  // The scan stops moving for 20 minutes: erasing goes ahead, working data included.
  globalThis.__kvs.set('scan:state', { ...stored('scan:state'), updatedAt: minutesAgo(21) });
  await runReport();
  assert.ok(!storedText().includes(ALICE) && !storedText().includes(ADMIN));
  assert.equal(stored('scan:state').status, 'running', 'the scan itself is left as it was');

  // Its next event comes after all: it finishes without the closed accounts.
  await drain(server);
  assert.equal(stored('scan:state').status, 'complete');
  assert.deepEqual(listed(), [BOB, DAN]);
  assert.equal(stored('report:meta').totalUsers, 4, 'six licensed, two of them closed');
});

test('an error text or a warning that quotes a closed account says "(closed account)" instead', async () => {
  site.once['GET /wiki/rest/api/group'] = [{ status: 403, body: { message: `User ${ADMIN} may not list groups.` } }];
  await scan();
  site.once['GET /wiki/rest/api/content/search'] = [{ status: 400, body: { message: `The value '${ADMIN}' is not valid.` } }];
  await scan();
  assert.equal(stored('scan:state').status, 'failed');
  const meta = stored('report:meta');
  globalThis.__closed = [ADMIN];
  await runReport();
  const state = stored('scan:state');
  assert.ok(!state.error.includes(ADMIN));
  assert.match(state.error, /The value '\(closed account\)' is not valid\./);
  const after = stored('report:meta');
  assert.ok(!JSON.stringify(after).includes(ADMIN));
  assert.ok(after.warnings.some((w) => w.includes('User (closed account) may not list groups.')));
  assert.deepEqual({ ...after, warnings: meta.warnings }, meta, 'only the warning text changed');
  // The page reads both as they are.
  const status = await call(server, 'getStatus', {}, OTHER_ADMIN);
  assert.equal(status.ok, true);
  assert.match(status.state.error, /\(closed account\)/);
  assert.ok(status.report.warnings.some((w) => /\(closed account\)/.test(w)));
});

// --- busy ---------------------------------------------------------------------------

test('busy: a running scan holds erasing back until it stops moving, and so does a reclaim, an undo or a protect for a minute', async () => {
  const at = Date.parse('2026-11-14T10:00:00.000Z');
  const ago = (min) => new Date(at - min * 60_000).toISOString();
  const { scanLive, actionLive, busy } = personal;
  assert.equal(scanLive({ status: 'running', updatedAt: ago(1) }, at), true);
  assert.equal(scanLive({ status: 'running', updatedAt: ago(20) }, at), true);
  assert.equal(scanLive({ status: 'running', updatedAt: ago(21) }, at), false, 'stopped moving');
  assert.equal(scanLive({ status: 'running', startedAt: ago(2) }, at), true, 'no update yet');
  assert.equal(scanLive({ status: 'running', phase: 'directory', updatedAt: ago(1) }, at), true, 'still listing users from the page');
  assert.equal(scanLive({ status: 'running', paused: true, updatedAt: ago(1) }, at), true, 'paused: the page picks it up');
  assert.equal(scanLive({ status: 'running', paused: true, updatedAt: ago(30) }, at), false, 'paused and left');
  assert.equal(scanLive({ status: 'running' }, at), false, 'no time to go by');
  for (const status of ['complete', 'failed', 'cancelled']) assert.equal(scanLive({ status, updatedAt: ago(1) }, at), false, status);
  assert.equal(scanLive(null, at), false);
  assert.equal(actionLive({ at: ago(0.5) }, at), true);
  assert.equal(actionLive({ at: ago(1) }, at), false, 'a minute on, it has ended');
  assert.equal(actionLive({ at: new Date(at + 5000).toISOString() }, at), true, 'a clock a little ahead');
  for (const mark of [null, undefined, {}, { at: 'soon' }]) assert.equal(actionLive(mark, at), false, JSON.stringify(mark));
  const none = async () => undefined;
  assert.equal(await busy(async () => ({ status: 'running', updatedAt: ago(1) }), none, () => at), true);
  assert.equal(await busy(none, async () => ({ at: ago(0.2) }), () => at), true);
  assert.equal(await busy(none, async () => ({ at: ago(5) }), () => at), false);
  assert.equal(await busy(none, none, () => at), false);
});

test('a write is refused when the app started writing since the report last asked, and reads the value again otherwise', async () => {
  const map = new Map([
    ['report:dormant:0', [{ accountId: ALICE }, { accountId: BOB }]],
    ['log:entry:1-a', { id: '1-a', accountId: ALICE, by: BOB }],
    ['log:entry:2-b', { id: '2-b', accountId: BOB, by: ALICE }],
  ]);
  const done = [];
  const store = {
    get: async (k) => structuredClone(map.get(k)),
    set: async (k, v) => void (map.set(k, v), done.push(['set', k])),
    delete: async (k) => void (map.delete(k), done.push(['delete', k])),
  };
  const unlist = async (id) => void done.push(['unlist', id]);
  const closed = new Set([ALICE]);
  const [, rows] = personal.personalDataSources(store, async () => true, unlist);
  await assert.rejects(rows.erase('report:dormant:0', closed), new RegExp(personal.BUSY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(map.get('report:dormant:0').length, 2);
  const free = personal.personalDataSources(store, async () => false, unlist);
  const source = (prefix) => free.find((s) => s.prefix === prefix);
  assert.equal(await source('report:dormant:').erase('report:dormant:0', closed), true);
  assert.deepEqual(map.get('report:dormant:0'), [{ accountId: BOB }]);
  assert.equal(await source('report:dormant:').erase('report:dormant:0', closed), false, 'nothing left to change');
  assert.equal(await source('report:dormant:').erase('report:dormant:9', closed), false, 'gone since the walk read it');
  // An entry about a closed person leaves History's index before it is deleted.
  done.length = 0;
  assert.equal(await source('log:entry:').erase('log:entry:1-a', closed), true);
  assert.deepEqual(done, [['unlist', '1-a'], ['delete', 'log:entry:1-a']]);
  assert.equal(await source('log:entry:').erase('log:entry:2-b', closed), true);
  assert.deepEqual(map.get('log:entry:2-b'), { id: '2-b', accountId: BOB, by: null, byClosed: true });
});

// --- pure ---------------------------------------------------------------------------

test('the key says what a value holds; the index, settings and other keys hold no account', () => {
  const { kindOf, idsIn } = personal;
  assert.equal(kindOf('scan:state'), 'scanState');
  assert.equal(kindOf('report:meta'), 'reportMeta');
  assert.equal(kindOf('protected'), 'protected');
  assert.equal(kindOf('report:dormant:0'), 'rows');
  assert.equal(kindOf('report:dormant:12'), 'rows');
  assert.equal(kindOf('report:ids:15'), 'ids');
  assert.equal(kindOf('scan:1762000000000:dormant:15'), 'rows');
  assert.equal(kindOf('scan:1762000000000:users:0'), 'byAccount');
  assert.equal(kindOf('scan:1762000000000:active:7'), 'byAccount');
  assert.equal(kindOf('log:entry:1762000000000-abc123'), 'entry');
  assert.equal(kindOf('log:latest:4'), 'latest');
  for (const key of ['settings', 'log:index', 'log:index:0', 'log:index:meta', 'action:started', 'pdr:state', 'pdr:ids:0', 'scan:1762000000000:other:1', 'report:dormant:x', 'report:metadata', 'log:latest:x', 'scan:states', 'protected:1', undefined, null]) {
    assert.equal(kindOf(key), null, String(key));
  }
  // The totals name nobody; only a warning's text is read.
  assert.deepEqual(idsIn('report:meta', { dormantCount: 2, totalUsers: 9, groupsMeta: { 'g-1': { name: 'confluence-users', admin: false } }, warnings: ['Fixed sentence.'] }), []);
});

test('each kind of value gives its account IDs; only closed ones are taken out; a value without one is left alone', () => {
  const { idsIn, scrubbed, CLOSED_ACCOUNT } = personal;
  const closed = new Set([ALICE, ADMIN]);
  // Rows of the list and of the working data, and who is on the list.
  const rows = [{ accountId: ALICE, products: ['Confluence'], groups: ['g-users'], bucket: 'over-365', label: 'Over a year, or never', severity: 3 }, { accountId: BOB, products: ['Confluence'], groups: null, bucket: '90-180' }];
  assert.deepEqual(idsIn('report:dormant:0', rows), [ALICE, BOB]);
  assert.deepEqual(scrubbed('report:dormant:0', rows, closed), [rows[1]]);
  assert.deepEqual(scrubbed('report:dormant:0', [rows[0]], closed), [], 'a page that loses its last row stays, empty');
  assert.equal(scrubbed('report:dormant:0', [rows[1]], closed), undefined);
  assert.deepEqual(scrubbed('scan:1:dormant:2', rows, closed), [rows[1]]);
  assert.deepEqual(idsIn('report:ids:3', [ALICE, BOB]), [ALICE, BOB]);
  assert.deepEqual(scrubbed('report:ids:3', [ALICE, BOB], closed), [BOB]);
  assert.equal(scrubbed('report:ids:3', [BOB, CAROL], closed), undefined);
  // Working data by account.
  const users = { [ALICE]: { products: ['Confluence'] }, [BOB]: { products: ['Confluence'] } };
  assert.deepEqual(idsIn('scan:1:users:3', users), [ALICE, BOB]);
  assert.deepEqual(scrubbed('scan:1:users:3', users, closed), { [BOB]: users[BOB] });
  assert.equal(scrubbed('scan:1:active:3', { [BOB]: 1, [CAROL]: 1 }, closed), undefined);
  assert.deepEqual(scrubbed('scan:1:active:3', { [ALICE]: 1 }, closed), {});
  // The scan state: the account IDs its texts quote.
  const state = {
    run: '1', status: 'failed', phase: 'content', days: 90,
    error: `Confluence rejected the query (400) (/wiki/rest/api/content/search) — The value '${ADMIN}' does not exist. Also ${BOB} and ${ALICE}.`,
    pauseReason: `Push refused for ${ALICE}`,
    warnings: [`The app could not read which groups grant Confluence. (Confluence refused the request (403) — User ${ADMIN} may not)`, 'A fixed sentence.'],
    groupsMeta: { '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b': { name: 'confluence-users', products: ['Confluence'], admin: false } },
  };
  assert.deepEqual(idsIn('scan:state', state), [ADMIN, BOB, ALICE, ALICE, ADMIN]);
  const next = scrubbed('scan:state', state, closed);
  assert.equal(next.error, `Confluence rejected the query (400) (/wiki/rest/api/content/search) — The value '${CLOSED_ACCOUNT}' does not exist. Also ${BOB} and ${CLOSED_ACCOUNT}.`);
  assert.equal(next.pauseReason, `Push refused for ${CLOSED_ACCOUNT}`);
  assert.deepEqual(next.warnings, [`The app could not read which groups grant Confluence. (Confluence refused the request (403) — User ${CLOSED_ACCOUNT} may not)`, 'A fixed sentence.']);
  assert.deepEqual(next.groupsMeta, state.groupsMeta, 'group IDs are not accounts');
  assert.equal(scrubbed('scan:state', { ...state, error: 'Confluence returned 503', pauseReason: null, warnings: ['A fixed sentence.'] }, closed), undefined);
  // Words and other numbers in a text are never taken for an account ID.
  assert.deepEqual(idsIn('scan:state', { error: 'Confluence rejected the query (400): field contributor; request 0123456789abcdef0123456789abcdef' }), []);
  // The totals: only a warning's text changes.
  const meta = { dormantCount: 3, totalUsers: 9, groupsMeta: state.groupsMeta, warnings: state.warnings };
  assert.deepEqual(idsIn('report:meta', meta), [ADMIN]);
  assert.deepEqual(scrubbed('report:meta', meta, closed), { ...meta, warnings: next.warnings });
  assert.equal(scrubbed('report:meta', { ...meta, warnings: ['A fixed sentence.'] }, closed), undefined);
  assert.equal(scrubbed('report:meta', { dormantCount: 3 }, closed), undefined, 'a report from before warnings were kept');

  // The protected list: the person goes; a closed admin who protected someone is cleared.
  const list = { [ALICE]: { at: 't1', by: BOB }, [BOB]: { at: 't2', by: ADMIN }, [CAROL]: { at: 't3', by: BOB } };
  assert.deepEqual(idsIn('protected', list), [ALICE, BOB, CAROL, BOB, ADMIN, BOB]);
  assert.deepEqual(scrubbed('protected', list, closed), { [BOB]: { at: 't2', by: null }, [CAROL]: { at: 't3', by: BOB } });
  assert.equal(scrubbed('protected', { [CAROL]: list[CAROL] }, closed), undefined);

  // A History entry: about a closed person it goes; a closed admin is cleared and marked.
  const entry = {
    id: '1762000000000-abc123', type: 'reclaim', accountId: BOB, by: ADMIN, at: 't', status: 'restored', restoredBy: ALICE, restoredAt: 't2', seatFreed: true,
    keptProducts: [], freedProducts: ['Confluence'],
    groups: [{ groupId: 'g-users', name: 'confluence-users', products: ['Confluence'], ok: true, error: null }, { groupId: 'g-x', name: 'x', products: ['Confluence'], ok: false, error: `Confluence returned 500. (${ADMIN} may not)` }],
    restoreErrors: [`x: Confluence returned 500. (${ALICE})`],
  };
  assert.deepEqual(idsIn('log:entry:1762000000000-abc123', entry), [BOB, ADMIN, ALICE, ADMIN, ALICE]);
  assert.equal(scrubbed('log:entry:1', { ...entry, accountId: ALICE }, closed), null, 'the entry of a closed person goes');
  const kept = scrubbed('log:entry:1', entry, closed);
  assert.equal(kept.accountId, BOB);
  assert.equal(kept.by, null);
  assert.equal(kept.byClosed, true);
  assert.equal(kept.restoredBy, null);
  assert.equal(kept.restoredByClosed, true);
  assert.equal(kept.groups[1].error, `Confluence returned 500. (${CLOSED_ACCOUNT} may not)`);
  assert.deepEqual(kept.groups[0], entry.groups[0]);
  assert.deepEqual(kept.restoreErrors, [`x: Confluence returned 500. (${CLOSED_ACCOUNT})`]);
  assert.equal(scrubbed('log:entry:1', { ...entry, by: CAROL, restoredBy: CAROL, groups: entry.groups.slice(0, 1), restoreErrors: [] }, closed), undefined);
  // An admin's ID in another form is taken out of the entry's texts too.
  assert.equal(scrubbed('log:entry:1', { accountId: BOB, by: 'admin-1', groups: [{ ok: false, error: 'admin-1 may not' }] }, new Set(['admin-1'])).groups[0].error, `${CLOSED_ACCOUNT} may not`);

  // The latest action on each person: the person's note goes; another's text is cleaned.
  const notes = { [ALICE]: { id: 'e1', status: 'reclaimed', at: 't' }, [BOB]: { id: null, status: 'failed', reason: `Confluence returned 400. (${ADMIN} is not allowed)`, at: 't' }, [CAROL]: { id: null, status: 'blocked', reason: 'Can administer Confluence (an admin role given directly or through a group). Remove their admin role in Atlassian Administration first.', at: 't' } };
  assert.deepEqual(idsIn('log:latest:2', notes), [ALICE, BOB, CAROL, ADMIN]);
  assert.deepEqual(scrubbed('log:latest:2', notes, closed), { [BOB]: { ...notes[BOB], reason: `Confluence returned 400. (${CLOSED_ACCOUNT} is not allowed)` }, [CAROL]: notes[CAROL] });
  assert.equal(scrubbed('log:latest:2', { [CAROL]: notes[CAROL] }, closed), undefined);

  // Odd values never throw, and give nothing.
  for (const key of ['report:dormant:0', 'report:ids:0', 'report:meta', 'scan:1:users:0', 'scan:state', 'protected', 'log:entry:1', 'log:latest:0']) {
    for (const value of [null, undefined, 'text', 7, [], {}, [null, 'x'], { x: null }, { warnings: 'x', error: 7 }]) {
      assert.ok(Array.isArray(idsIn(key, value)), key);
      assert.equal(scrubbed(key, value, closed), undefined, `${key} ${JSON.stringify(value)}`);
    }
  }
  assert.equal(scrubbed('report:dormant:0', rows, new Set()), undefined, 'no closed accounts');
  assert.equal(scrubbed('settings', { x: ALICE }, closed), undefined);
});
