import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite } from './fakes/confluence-site.js';
import { loadServer, reset, drain, call, stored, ADMIN } from './helpers.js';

/**
 * The write path on a fake site: list users, scan through the queue, reclaim,
 * look at History, undo. Storage and the queue are in memory (test/fakes).
 */

let server;
let site;

before(async () => {
  server = await loadServer();
});

beforeEach(() => {
  site = makeSite();
  site.addUser(ADMIN, ['g-users', 'g-site']);
  site.lastCreated[ADMIN] = 1;
  site.addUser('u-idle', ['g-users', 'g-team']); // never contributed
  site.addUser('u-busy', ['g-users']);
  site.lastCreated['u-busy'] = 3;
  site.addUser('u-cadm', ['g-users', 'g-cadm']); // a Confluence admin who never contributed
  reset(site);
});

async function scan() {
  const started = await call(server, 'startScan', { days: 90 });
  assert.equal(started.ok, true);
  for (let i = 0; i < 20; i++) {
    const res = await call(server, 'listUsers', { run: started.state.run });
    assert.equal(res.ok, true, res.error);
    if (res.done) break;
  }
  await drain(server);
  const status = await call(server, 'getStatus');
  assert.equal(status.state.status, 'complete', status.state.error);
  return status.report;
}

const rowsById = async () => Object.fromEntries((await call(server, 'getAllRows')).rows.map((r) => [r.accountId, r]));
const entries = async () => (await call(server, 'getHistory', { page: 0 })).entries;

test('a scan lists the people who contributed nothing and keeps who is on the list', async () => {
  const report = await scan();
  assert.equal(report.totalUsers, 4);
  assert.equal(report.dormantCount, 2);
  assert.ok(report.startedAt, 'the scan start is kept with the report');
  const rows = await rowsById();
  assert.deepEqual(Object.keys(rows).sort(), ['u-cadm', 'u-idle']);
  assert.equal(rows['u-idle'].reclaimable, true);
  assert.deepEqual(rows['u-idle'].removeGroups, ['confluence-users-acme']);
  // A Confluence admin is never offered.
  assert.equal(rows['u-cadm'].reclaimable, false);
  assert.match(rows['u-cadm'].reason, /admin group \(confluence-admins-acme\)/);
  const listed = [...Array(16).keys()].flatMap((s) => stored(`report:ids:${s}`) ?? []);
  assert.deepEqual(listed.sort(), ['u-cadm', 'u-idle']);
});

test('a report row keeps only the groups that grant Confluence, and the page gets no group ids', async () => {
  // Someone in many groups: the stored row must not grow with them.
  for (let n = 0; n < 60; n++) {
    site.groups[`g-x${n}`] = { name: `project-${n}`, members: ['u-idle'], access: null };
  }
  await scan();
  const storedRow = stored('report:dormant:0').find((r) => r.accountId === 'u-idle');
  assert.deepEqual(storedRow.groups, ['g-users']);
  assert.equal('groups' in (await rowsById())['u-idle'], false);
});

test('a row stored by the earlier version, with every group id, still loads and plans the same', async () => {
  await scan();
  const page = stored('report:dormant:0');
  page.find((r) => r.accountId === 'u-idle').groups = ['g-users', 'g-team', 'g-gone', 'g-other'];
  globalThis.__kvs.set('report:dormant:0', page);
  const row = (await rowsById())['u-idle'];
  assert.equal(row.reclaimable, true);
  assert.deepEqual(row.removeGroups, ['confluence-users-acme']);
});

test('the History entry is stored as pending before the group is left, then updated, and Confluence confirms the seat', async () => {
  await scan();
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].seatFreed, true);
  assert.equal(site.removed.length, 1);
  assert.equal(site.removed[0].as, 'user', 'group changes run as the signed-in admin');
  assert.deepEqual(site.removed[0].storedBefore, [{ accountId: 'u-idle', status: 'pending' }]);
  const [entry] = await entries();
  assert.equal(entry.status, 'reclaimed');
  assert.equal(entry.seatFreed, true);
  assert.equal(entry.by, ADMIN);
  assert.equal((await rowsById())['u-idle'].lastAction.status, 'reclaimed');
});

test('undo puts the person back in exactly the groups that were left, and can be repeated', async () => {
  await scan();
  await call(server, 'reclaim', { accountIds: ['u-idle'] });
  const [entry] = await entries();
  const undone = await call(server, 'undo', { entryId: entry.id });
  assert.equal(undone.ok, true);
  assert.deepEqual(site.added.map((a) => a.groupId), ['g-users']);
  assert.equal((await entries())[0].status, 'restored');
  assert.deepEqual(await call(server, 'undo', { entryId: entry.id }), { ok: true, already: true });
  assert.equal((await call(server, 'undo', { entryId: 'nope' })).ok, false);
});

test('an account that is not on the current list is never reclaimed', async () => {
  await scan();
  const res = await call(server, 'reclaim', { accountIds: ['u-busy', 'made-up'] });
  assert.equal(res.ok, true);
  for (const r of res.results) {
    assert.equal(r.skipped, true);
    assert.match(r.error, /Not on the current list\. Run a new scan\./);
  }
  assert.equal(site.removed.length, 0);
  assert.deepEqual(await entries(), []);
});

test('reclaim is refused when there is no list at all', async () => {
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /Run a scan first/);
  assert.equal(site.removed.length, 0);
});

test('a report stored by the earlier version (no ID keys) still allows a reclaim of its rows only', async () => {
  await scan();
  const meta = stored('report:meta');
  delete meta.idShards;
  delete meta.startedAt;
  globalThis.__kvs.set('report:meta', meta);
  for (let s = 0; s < 16; s++) globalThis.__kvs.delete(`report:ids:${s}`);
  const res = await call(server, 'reclaim', { accountIds: ['u-idle', 'u-busy'] });
  assert.equal(res.results.find((r) => r.accountId === 'u-idle').ok, true);
  assert.match(res.results.find((r) => r.accountId === 'u-busy').error, /Not on the current list/);
});

test('a Confluence admin, the person running the reclaim and protected people are refused by the server', async () => {
  site.lastCreated[ADMIN] = 400;
  site.groups['g-site'].members = []; // the caller is on the list as a plain user
  site.addUser('u-prot', ['g-users']);
  await scan();
  await call(server, 'setProtected', { accountId: 'u-prot', protected: true });
  const res = await call(server, 'reclaim', { accountIds: ['u-cadm', ADMIN, 'u-prot'] });
  assert.match(res.results[0].error, /admin group \(confluence-admins-acme\)/);
  assert.match(res.results[1].error, /This is you/);
  assert.match(res.results[2].error, /protected list/);
  assert.equal(site.removed.length, 0);
});

test('someone Confluence says can administer it is never reclaimed, even with no admin group', async () => {
  site.addUser('u-role', ['g-users'], { adminRole: true }); // admin role given directly
  await scan();
  assert.equal((await rowsById())['u-role'].reclaimable, true, 'the groups alone offer them');
  const res = await call(server, 'reclaim', { accountIds: ['u-role'] });
  assert.equal(res.results[0].skipped, true);
  assert.match(res.results[0].error, /Can administer Confluence/);
  assert.equal(site.removed.length, 0);
  assert.deepEqual(await entries(), []);
  const row = (await rowsById())['u-role'];
  assert.equal(row.lastAction.status, 'blocked', 'the row stops being offered');
  assert.match(row.lastAction.reason, /Can administer Confluence/);
});

test('when the admin check gets no answer, the seat is left alone and can be tried again', async () => {
  await scan();
  site.once['GET /wiki/rest/api/search/user'] = [{ status: 500, body: { message: 'Internal error' } }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /Could not confirm that this person is not a Confluence admin/);
  assert.equal(site.removed.length, 0);
  assert.equal((await rowsById())['u-idle'].lastAction, null, 'nothing is noted on the row');
  const again = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(again.results[0].ok, true);
});

test('someone who contributed since the scan is skipped', async () => {
  await scan();
  site.lastCreated['u-idle'] = 0;
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /contributed to Confluence since the scan/);
  assert.equal(site.removed.length, 0);
});

test('a reclaim that changes nothing leaves no History entry; the row carries the reason', async () => {
  await scan();
  const real = site.handle;
  site.handle = (method, p, body, as) =>
    method === 'DELETE' ? { status: 403, body: { message: 'This group is managed by an external identity provider' } } : real(method, p, body, as);
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.results[0].ok, false);
  assert.match(res.results[0].error, /identity provider/);
  assert.deepEqual(await entries(), []);
  assert.equal((await call(server, 'getHistory', { page: 0 })).total, 0);
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction.status, 'blocked');
  assert.match(row.lastAction.reason, /identity provider/);
});

test('a refusal for another reason is shown on the row and can be tried again', async () => {
  await scan();
  site.once['DELETE /wiki/rest/api/group/userByGroupId'] = [{ status: 403, body: { message: 'Not a site admin' } }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /Only site admins/);
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction.status, 'failed');
  assert.deepEqual(await entries(), []);
  const again = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(again.results[0].ok, true);
  assert.equal((await rowsById())['u-idle'].lastAction.status, 'reclaimed');
});

test('a partial reclaim does not count the seat as freed while another group still grants it', async () => {
  site.groups['g-extra'] = { name: 'marketing-readers', members: ['u-idle'], access: 'user' };
  await scan();
  const real = site.handle;
  site.handle = (method, p, body, as) =>
    method === 'DELETE' && p.includes('g-extra') ? { status: 500, body: { message: 'boom' } } : real(method, p, body, as);
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.results[0].partial, true);
  assert.deepEqual(res.results[0].freedProducts, []);
  const [entry] = await entries();
  assert.equal(entry.status, 'partial');
  assert.deepEqual(entry.freedProducts, []);
});

test('when Confluence asks for a pause, nothing is changed and the people are handed back to be sent again', async () => {
  site.addUser('u-idle2', ['g-users']);
  await scan();
  site.once['GET /wiki/rest/api/user/memberof'] = [{ status: 429, headers: { 'Retry-After': '7' }, body: {} }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle', 'u-idle2'] });
  assert.equal(res.ok, true);
  assert.equal(res.retryAfter, 7);
  assert.deepEqual(res.results.map((r) => r.retry), [true, true]);
  assert.equal(site.removed.length, 0);
  site.once['DELETE /wiki/rest/api/group/userByGroupId'] = [{ status: 429, headers: { 'Retry-After': '3' }, body: {} }];
  const second = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(second.retryAfter, 3);
  assert.equal(second.results[0].retry, true);
  assert.deepEqual(await entries(), []);
});

test('a failed name lookup at the end does not throw the results away', async () => {
  await scan();
  await call(server, 'getAllRows'); // (uses the lookup too; the failure below is for the reclaim's last call)
  const real = site.handle;
  let reclaimed = false;
  site.handle = (method, p, body, as) => {
    if (method === 'DELETE') reclaimed = true;
    if (reclaimed && p.startsWith('/wiki/rest/api/user/bulk')) return { status: 429, body: {} };
    return real(method, p, body, as);
  };
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].displayName, null);
});

test('a second call for the same person within a minute of a pending entry is refused', async () => {
  await scan();
  const at = new Date().toISOString();
  await server.store.saveEntry({ id: `${Date.now()}-aaaaaa`, type: 'reclaim', accountId: 'u-idle', at, updatedAt: at, status: 'pending', groups: [] });
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /less than a minute ago/);
  assert.equal(site.removed.length, 0);
});

test('"Reclaimed" does not stick to someone a newer scan lists again', async () => {
  await scan();
  await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal((await rowsById())['u-idle'].lastAction.status, 'reclaimed');
  site.groups['g-users'].members.push('u-idle'); // added back outside the app
  await new Promise((r) => setTimeout(r, 5));
  await scan();
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction, null);
  assert.equal(row.reclaimable, true);
  assert.equal((await call(server, 'reclaim', { accountIds: ['u-idle'] })).results[0].ok, true);
});

test('the History re-check changes only the answer: it does not undo an Undo or move the entry in time', async () => {
  await scan();
  // The directory still lists the person right after the change, so the seat is not confirmed yet.
  const real = site.handle;
  let lag = true;
  site.handle = (method, p, body, as) => {
    const url = new URL(p, 'https://acme.atlassian.net');
    if (lag && url.pathname === '/wiki/rest/api/search/user' && /user\.accountid/.test(url.searchParams.get('cql') ?? '')) {
      return { body: { results: [site.asResult('u-idle')] } };
    }
    return real(method, p, body, as);
  };
  await call(server, 'reclaim', { accountIds: ['u-idle'] });
  const [entry] = await entries(); // this read re-checks too, still lagging
  assert.equal(entry.seatFreed, false);

  // While History is being re-checked, the admin undoes the entry.
  site.handle = async (method, p, body, as) => {
    const url = new URL(p, 'https://acme.atlassian.net');
    if (url.pathname === '/wiki/rest/api/search/user' && /user\.accountid/.test(url.searchParams.get('cql') ?? '')) {
      await call(server, 'undo', { entryId: entry.id });
      return real(method, p, body, as);
    }
    return real(method, p, body, as);
  };
  await call(server, 'getHistory', { page: 0 });
  site.handle = real;
  assert.equal(stored(`log:entry:${entry.id}`).status, 'restored', 'the Undo was not overwritten');

  // A later re-check that only learns the answer leaves the entry's time alone.
  lag = false;
  const at = new Date(Date.now() - 1000).toISOString();
  const partial = { id: `${Date.now()}-bbbbbb`, type: 'reclaim', accountId: 'u-cadm', at, updatedAt: at, status: 'partial', seatFreed: false, groups: [] };
  await server.store.saveEntry(partial);
  await call(server, 'getHistory', { page: 0 });
  assert.equal(stored(`log:entry:${partial.id}`).seatFreed, false, 'u-cadm still holds a seat');
  assert.equal(stored(`log:entry:${partial.id}`).updatedAt, at);
});

test('a short page of a person\'s groups does not end the listing while Confluence links to a next page', async () => {
  await scan();
  const real = site.handle;
  // The first page holds one group that grants nothing and says there is more.
  site.handle = (method, p, body, as) => {
    const url = new URL(p, 'https://acme.atlassian.net');
    if (url.pathname === '/wiki/rest/api/user/memberof' && url.searchParams.get('accountId') === 'u-idle') {
      const all = site.groupsOf('u-idle'); // [confluence-users-acme, team-blue]
      const start = Number(url.searchParams.get('start'));
      return start === 0
        ? { body: { results: [all[1]], _links: { next: '/rest/api/user/memberof?start=1' } } }
        : { body: { results: start === 1 ? [all[0]] : [], _links: {} } };
    }
    return real(method, p, body, as);
  };
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.results[0].ok, true, res.results[0].error);
  assert.deepEqual(site.removed.map((r) => r.groupId), ['g-users']);
});
