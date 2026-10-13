import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConfluenceAdmin, adminOnly, refusal, NOT_ADMIN_MESSAGE, CHECK_FAILED_MESSAGE } from '../src/lib/admin.js';

const admin = { operations: [{ operation: 'use', targetType: 'application' }, { operation: 'administer', targetType: 'application' }] };
const user = { operations: [{ operation: 'use', targetType: 'application' }, { operation: 'create_space', targetType: 'application' }] };

test('only the administer operation on the application counts as admin', () => {
  assert.equal(isConfluenceAdmin(admin), true);
  assert.equal(isConfluenceAdmin(user), false);
  assert.equal(isConfluenceAdmin({ operations: [{ operation: 'administer', targetType: 'space' }] }), false);
  assert.equal(isConfluenceAdmin({}), false);
  assert.equal(isConfluenceAdmin(null), false);
});

test('an admin reaches the resolver', async () => {
  const guarded = adminOnly(async () => ({ ok: true, rows: ['x'] }), async () => ({ allowed: true }));
  assert.deepEqual(await guarded({}), { ok: true, rows: ['x'] });
});

test('a non-admin is refused before the resolver runs', async () => {
  let ran = false;
  const guarded = adminOnly(async () => { ran = true; return { ok: true }; }, async () => ({ allowed: false, reason: 'not-admin' }));
  assert.deepEqual(await guarded({}), { ok: false, forbidden: true, error: NOT_ADMIN_MESSAGE });
  assert.equal(ran, false);
});

test('a failed or odd check refuses (fail closed)', async () => {
  let ran = false;
  const fn = async () => { ran = true; return { ok: true }; };
  assert.equal((await adminOnly(fn, async () => ({ allowed: false, reason: 'check-failed' }))({})).error, CHECK_FAILED_MESSAGE);
  assert.equal((await adminOnly(fn, async () => undefined)({})).forbidden, true);
  assert.equal((await adminOnly(fn, async () => ({ allowed: 'yes' }))({})).forbidden, true);
  assert.equal(ran, false);
  assert.equal(refusal('anything-else').error, CHECK_FAILED_MESSAGE);
});
