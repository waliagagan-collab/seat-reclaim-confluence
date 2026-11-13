import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite, item } from './fakes/confluence-site.js';
import { loadServer, reset, drain, call, stored, ADMIN } from './helpers.js';

/**
 * The scan on a fake site: the user listing the page drives, then the queue
 * worker slice by slice, with duplicate events, a queue that refuses a push,
 * storage that fails and group reads that are refused.
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
  site.addUser('u-idle', ['g-users']);
  site.addUser('u-busy', ['g-users']);
  site.lastCreated['u-busy'] = 3;
  site.addUser('u-idle2', ['g-users', 'g-team']);
  reset(site);
});

const state = () => stored('scan:state');
const status = () => call(server, 'getStatus');
const listed = async () => (await call(server, 'getAllRows')).rows.map((r) => r.accountId).sort();

/** Start a scan and list the users, as the page does, up to the first queue event. */
async function start() {
  const started = await call(server, 'startScan', { days: 90 });
  for (let i = 0; i < 20; i++) {
    const res = await call(server, 'listUsers', { run: started.state.run });
    assert.equal(res.ok, true, res.error);
    if (res.done) break;
  }
  return started.state.run;
}

test('a scan starts with sequence number 0', async () => {
  const started = await call(server, 'startScan', { days: 90 });
  assert.equal(started.state.seq, 0);
});

test('two copies of every event still make one correct scan: the copy that commits second writes and pushes nothing', async () => {
  await start();
  let rounds = 0;
  while (globalThis.__queue.length && rounds++ < 50) {
    const events = globalThis.__queue.splice(0);
    assert.equal(events.length, 1, 'one slice pushes one event; the late copy pushes nothing');
    const seqBefore = state().seq;
    // One copy starts and is held at its first call to Confluence; the other
    // runs to its commit; then the first is let go and reaches its own commit.
    let release;
    site.holdNext = new Promise((resolve) => (release = resolve));
    const held = server.worker.handler(events[0]);
    await server.worker.handler(events[0]);
    site.holdNext = null;
    release();
    await held;
    assert.ok(state().seq <= seqBefore + 1, 'the sequence number moves once per slice');
  }
  assert.equal(state().status, 'complete');
  const report = (await status()).report;
  assert.equal(report.totalUsers, 4);
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);
});

test('the last slice run twice publishes one complete report', async () => {
  await start();
  while (state().phase !== 'finalize') await server.worker.handler(globalThis.__queue.shift());
  const event = globalThis.__queue.shift();
  const atStart = state();
  await Promise.all([server.worker.handler(event), server.worker.handler(event)]);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);
  assert.deepEqual([...globalThis.__kvs.keys()].filter((k) => k.startsWith(`scan:${state().run}:`)), [], 'the scratch data is gone once the run is closed');

  // A second copy that started while the run was still open, and gets to its
  // work only after the first copy closed the run and deleted the scratch
  // data, must not publish a report from what is left (nothing).
  globalThis.__kvsOnce = { key: 'scan:state', value: atStart };
  await server.worker.handler(event);
  assert.equal(state().status, 'complete');
  assert.equal((await status()).report.dormantCount, 2);
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);

  // A copy that arrives after the run is closed does nothing at all.
  const writes = globalThis.__kvsWrites.length;
  await server.worker.handler(event);
  assert.equal(globalThis.__kvsWrites.length, writes);
});

test('two tabs listing the same users at once count them once and queue one first event', async () => {
  const started = await call(server, 'startScan', { days: 90 });
  const run = started.state.run;
  // Both calls read the same cursor before either commits: the first is held
  // at its user search while the second lists everything and commits.
  let release;
  site.holdAt = { path: '/wiki/rest/api/search/user', until: new Promise((resolve) => (release = resolve)) };
  const held = call(server, 'listUsers', { run });
  await new Promise((resolve) => setTimeout(resolve, 5)); // let it reach the search
  assert.equal(site.holdAt, null, 'the first call is waiting at its search');
  const first = await call(server, 'listUsers', { run });
  release();
  const second = await held;
  assert.equal(first.done, true);
  assert.equal(second.ok, true);
  assert.equal(second.done, true);
  assert.equal(state().usersFound, 4);
  assert.equal(globalThis.__queue.length, 1);
});

test('when the queue refuses the next event the run is paused, not failed, and the status poll carries it on', async () => {
  await start();
  globalThis.__queueFail = 1;
  await server.worker.handler(globalThis.__queue.shift()); // content: the push fails
  assert.equal(state().status, 'running');
  assert.equal(state().paused, true);
  assert.equal(state().phase, 'verify', 'the cursor moved on and was saved');
  assert.equal(globalThis.__queue.length, 0);
  assert.ok([...globalThis.__kvs.keys()].some((k) => k.startsWith(`scan:${state().run}:users:`)), 'nothing was deleted');

  const polled = await status(); // the page's poll
  assert.equal(polled.state.paused, false);
  assert.equal(globalThis.__queue.length, 1);
  assert.deepEqual(globalThis.__queue[0].body, { run: state().run, seq: state().seq });
  await drain(server);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);
});

test('when the first event cannot be queued after the listing, the scan is kept and the status poll starts it', async () => {
  const started = await call(server, 'startScan', { days: 90 });
  globalThis.__queueFail = 1;
  const res = await call(server, 'listUsers', { run: started.state.run });
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(state().status, 'running');
  assert.equal(state().paused, true);
  assert.ok([...globalThis.__kvs.keys()].some((k) => k.startsWith(`scan:${state().run}:users:`)), 'the listing was kept');
  await status();
  await drain(server);
  assert.equal(state().status, 'complete');
});

test('a storage call that fails twice is tried again and the scan goes on', async () => {
  await start();
  globalThis.__kvsFail = 2;
  await server.worker.handler(globalThis.__queue.shift()); // content
  assert.equal(state().status, 'running');
  await drain(server);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);
});

test('one refused group read is about that one person; the rest still get their groups', async () => {
  await start();
  // The first inactive person's group read answers 404 (the account was closed meanwhile).
  site.once['GET /wiki/rest/api/user/memberof'] = [{ status: 404, body: { message: 'No user found' } }];
  await drain(server);
  const report = (await status()).report;
  assert.ok(!report.warnings.some((w) => /could not read users' groups/.test(w)));
  const rows = (await call(server, 'getAllRows')).rows;
  assert.deepEqual(rows.map((r) => r.pending).sort(), [false, true], 'one row is planned live, the other from the scan');
});

test('when the app is not allowed to read groups at all, it stops asking and says so once', async () => {
  await start();
  const real = site.handle;
  let asked = 0;
  site.handle = (method, p, body, as) => {
    if (p.startsWith('/wiki/rest/api/user/memberof') && as === 'app') {
      asked += 1;
      return { status: 403, body: { message: 'Forbidden' } };
    }
    return real(method, p, body, as);
  };
  await drain(server);
  assert.equal(asked, 1);
  assert.ok((await status()).report.warnings.some((w) => /could not read users' groups/.test(w)));
});

test('a rate limit on a group read keeps what the slice collected and asks for a retry', async () => {
  await start();
  await server.worker.handler(globalThis.__queue.shift()); // content
  // The first inactive person's groups are read; the second read is rate limited.
  let reads = 0;
  const real = site.handle;
  site.handle = (method, p, body, as) => {
    if (p.startsWith('/wiki/rest/api/user/memberof') && as === 'app' && ++reads === 2) return { status: 429, headers: { 'Retry-After': '9' }, body: {} };
    return real(method, p, body, as);
  };
  const event = globalThis.__queue.shift();
  const res = await server.worker.handler(event);
  assert.equal(res.options.retryAfter, 9);
  assert.equal(state().dormantFound, 1, 'the first person was kept');
  assert.equal(state().verifyIndex > 0 || state().verifyShard > 0, true, 'the cursor moved past them');
  await server.worker.handler(event); // the platform's retry of the same event
  await drain(server);
  assert.deepEqual(await listed(), ['u-idle', 'u-idle2']);
});

test('someone who contributed to a whiteboard another person changed last is not listed: the app cannot read who edited it', async () => {
  site.contributed['u-idle'] = [item('whiteboard', 'w1', 'u-busy')];
  site.contributed['u-idle2'] = [item('comment', 'c9', 'u-busy')]; // a comment is edited by its author or nobody
  await start();
  await drain(server);
  const report = (await status()).report;
  assert.deepEqual(await listed(), ['u-idle2']);
  assert.equal(report.unverified, 1);
  assert.ok(report.warnings.some((w) => /whiteboard or database/.test(w)));
});

test('a page that is gone when its history is read does not fail the scan: that person is counted as active', async () => {
  site.contributed['u-idle'] = [item('page', 'p1', 'u-busy')];
  site.once['GET /wiki/api/v2/pages/p1/versions'] = [{ status: 404, body: { message: 'Not found' } }];
  await start();
  await drain(server);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle2']);
  assert.equal((await status()).report.unverified, 1);
});

test('a history read refused for another reason still fails the scan with the reason', async () => {
  site.contributed['u-idle'] = [item('page', 'p1', 'u-busy')];
  site.once['GET /wiki/api/v2/pages/p1/versions'] = [{ status: 403, body: { message: 'Forbidden' } }];
  await start();
  await drain(server);
  assert.equal(state().status, 'failed');
  assert.match(state().error, /403/);
});

test('a cancel wins over a slice in flight, and its scratch data is removed', async () => {
  const run = await start();
  const slice = server.worker.handler(globalThis.__queue.shift()); // content, in flight
  await call(server, 'cancelScan');
  await slice;
  assert.equal(state().status, 'cancelled');
  assert.equal(globalThis.__queue.length, 0);
  assert.deepEqual([...globalThis.__kvs.keys()].filter((k) => k.startsWith(`scan:${run}:`)), []);
});
