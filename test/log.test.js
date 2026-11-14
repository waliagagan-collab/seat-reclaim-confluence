import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite } from './fakes/confluence-site.js';
import { loadServer, reset, call, stored, ADMIN } from './helpers.js';

/**
 * History: every action stays in the log, however many there are, and the
 * log written by the earlier version still shows and can be undone.
 */

let server;
let site;

before(async () => {
  server = await loadServer();
});

beforeEach(() => {
  site = makeSite();
  site.addUser(ADMIN, ['g-users', 'g-site']);
  reset(site);
});

const entry = (n, status = 'reclaimed') => {
  const at = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return {
    id: `${Date.UTC(2026, 0, 1) + n}-e${n}`,
    type: 'reclaim',
    accountId: `u-${n}`,
    by: ADMIN,
    at,
    updatedAt: at,
    status,
    groups: [{ groupId: 'g-users', name: 'confluence-users-acme', products: ['Confluence'], ok: true }],
  };
};

async function allListed(store) {
  const first = await store.getLogPage(0, 25);
  const ids = [];
  for (let p = 0; p < first.pages; p++) ids.push(...(await store.getLogPage(p, 25)).entries.map((e) => e.id));
  return { ids, total: first.total };
}

test('1,200 actions are all kept, newest first, and the oldest can still be undone', async () => {
  const { store } = server;
  for (let n = 0; n < 1200; n++) await store.saveEntry(entry(n));
  const { ids, total } = await allListed(store);
  assert.equal(total, 1200);
  assert.equal(ids.length, 1200);
  assert.equal(new Set(ids).size, 1200, 'no action is listed twice');
  assert.equal(ids[0], entry(1199).id);
  assert.equal(ids[1199], entry(0).id);
  for (const n of [0, 1, 199, 200, 201, 700, 1199]) assert.ok(await store.getEntry(entry(n).id), `entry ${n} is still stored`);
  // No stored value grows without limit.
  assert.ok(stored('log:index').length <= 500);

  site.addUser('u-0', []);
  const undone = await call(server, 'undo', { entryId: entry(0).id });
  assert.equal(undone.ok, true);
  assert.ok(site.groups['g-users'].members.includes('u-0'));
  // Saving an old entry again (the undo did) does not list it twice.
  const after = await allListed(store);
  assert.equal(after.total, 1200);
  assert.equal(new Set(after.ids).size, 1200);
  assert.equal((await store.getEntry(entry(0).id)).status, 'restored');
});

test('the log written by the earlier version (one list of up to 1,000 ids) still shows, and grows without losing anything', async () => {
  const { store } = server;
  // As the earlier version stored it: entries under log:entry:<id>, one index list, newest first.
  const old = [];
  for (let n = 0; n < 1000; n++) {
    const e = entry(n);
    globalThis.__kvs.set(`log:entry:${e.id}`, e);
    old.unshift(e.id);
  }
  globalThis.__kvs.set('log:index', old);

  const before = await call(server, 'getHistory', { page: 0 });
  assert.equal(before.total, 1000);
  assert.equal(before.entries[0].id, entry(999).id);
  assert.equal((await call(server, 'getHistory', { page: 39 })).entries.at(-1).id, entry(0).id);

  await store.saveEntry(entry(1000));
  await store.saveEntry(entry(1001));
  const { ids, total } = await allListed(store);
  assert.equal(total, 1002);
  assert.equal(new Set(ids).size, 1002);
  assert.equal(ids[0], entry(1001).id);
  assert.equal(ids.at(-1), entry(0).id);
  assert.ok(await store.getEntry(entry(0).id), 'the oldest entry was not deleted');

  site.addUser('u-0', []);
  assert.equal((await call(server, 'undo', { entryId: entry(0).id })).ok, true);
});

test('the newest action on a person decides their row, and a note without an entry can replace it', async () => {
  const { store } = server;
  const first = entry(1, 'partial');
  const second = { ...entry(2), accountId: 'u-1' };
  await store.saveEntry(second);
  await store.saveEntry(first); // an older action saved later must not hide the newer one
  assert.equal((await store.getLatestFor(['u-1']))['u-1'].id, second.id);
  await store.noteRow('u-1', 'blocked', 'This group is managed by your identity provider.');
  const latest = (await store.getLatestFor(['u-1']))['u-1'];
  assert.equal(latest.status, 'blocked');
  assert.equal(latest.id, null);
});

test('an entry that changed nothing can be taken back out of the log', async () => {
  const { store } = server;
  await store.saveEntry(entry(1));
  const pending = entry(2, 'pending');
  await store.saveEntry(pending);
  await store.dropEntry(pending);
  const page = await store.getLogPage(0);
  assert.deepEqual(page.entries.map((e) => e.id), [entry(1).id]);
  assert.equal(page.total, 1);
  assert.equal(await store.getEntry(pending.id), undefined);
});

test('History still pages correctly after entries in the middle are taken out, and keeps growing after', async () => {
  const { store } = server;
  for (let n = 0; n < 1200; n++) await store.saveEntry(entry(n));
  // The newest ids hold 1199..750; archive page 2 holds 749..500, page 1 499..250, page 0 249..0.
  assert.deepEqual(stored('log:index:meta'), { archives: 3 });
  const before = (await allListed(store)).ids;
  // From the middle of an archive page, the oldest of all, the newest ids, and a whole archive page.
  const gone = new Set([entry(600).id, entry(0).id, entry(1000).id]);
  for (let n = 250; n < 500; n++) gone.add(entry(n).id);
  for (const id of gone) assert.equal(await store.removeFromHistory(id), 1, id);
  assert.equal(await store.removeFromHistory(entry(600).id), 0, 'already out');
  assert.deepEqual(stored('log:index:meta'), { archives: 3, sizes: [249, 0, 249] });

  const check = async (expected) => {
    const { ids, total } = await allListed(store);
    assert.equal(total, expected.length);
    assert.deepEqual(ids, expected, 'every entry left, once, newest first');
    const first = await store.getLogPage(0, 25);
    for (let p = 0; p < first.pages; p++) {
      const { entries } = await store.getLogPage(p, 25);
      assert.equal(entries.length, p < first.pages - 1 ? 25 : expected.length - 25 * (first.pages - 1), `page ${p} is full`);
    }
  };
  const left = before.filter((id) => !gone.has(id));
  assert.equal(left.length, 1200 - 253);
  await check(left);
  // The History tab reads the same pages.
  const tab = await call(server, 'getHistory', { page: 20 });
  assert.equal(tab.total, left.length);
  assert.deepEqual(tab.entries.map((e) => e.id), left.slice(500, 525));

  // New actions move older ids into new full pages; the shorter ones keep their sizes.
  for (let n = 1200; n < 1500; n++) await store.saveEntry(entry(n));
  const meta = stored('log:index:meta');
  assert.deepEqual(meta.sizes.slice(0, 3), [249, 0, 249]);
  assert.ok(meta.sizes.slice(3).every((s) => s === 250) && meta.archives === meta.sizes.length);
  const newer = Array.from({ length: 300 }, (_, i) => entry(1499 - i).id);
  await check([...newer, ...left]);

  // A call that died before it wrote the count: the next one puts it right.
  globalThis.__kvs.set('log:index:meta', { archives: meta.archives });
  assert.equal(await store.removeFromHistory('not-there'), 0);
  assert.deepEqual(stored('log:index:meta'), meta);
  await check([...newer, ...left]);
});
