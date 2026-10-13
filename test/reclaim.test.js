import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT,
  isAdminGroup,
  isAdminGroupName,
  planReclaim,
  reasonText,
  explainChange,
  isIdpManaged,
  alreadyMember,
} from '../src/lib/reclaim.js';
import { buildGroupsMeta, guessAccessGroups, normaliseGroup, seatHeldInSearch } from '../src/lib/confluence.js';

// A site as Confluence's group list reports it: the default access group has
// "Can use", the Confluence admin group has admin (and use), and org-admins and
// site-admins carry site-admin permission.
const BY_TYPE = {
  user: [
    { type: 'group', id: 'g-users', name: 'confluence-users-site' },
    { type: 'group', id: 'g-cadm', name: 'confluence-admins-site' },
    { type: 'group', id: 'g-team', name: 'marketing-readers' }, // a custom group given product access
  ],
  admin: [{ type: 'group', id: 'g-cadm', name: 'confluence-admins-site' }],
  'site-admin': [
    { type: 'group', id: 'g-org', name: 'org-admins' },
    { type: 'group', id: 'g-site', name: 'site-admins' },
  ],
};
const META = buildGroupsMeta(BY_TYPE);

test('the group map keeps every group that grants Confluence and flags the admin ones', () => {
  assert.deepEqual(Object.keys(META).sort(), ['g-cadm', 'g-org', 'g-site', 'g-team', 'g-users']);
  assert.equal(META['g-users'].admin, false);
  assert.equal(META['g-team'].admin, false);
  // Listed under "user" AND "admin": the stricter flag wins.
  assert.equal(META['g-cadm'].admin, true);
  assert.equal(META['g-org'].admin, true);
  assert.deepEqual(META['g-users'].products, [PRODUCT]);
  assert.deepEqual(buildGroupsMeta(undefined), {});
  assert.equal(normaliseGroup({ name: 'no-id' }), null);
});

test('admin groups are recognised by permission or by name', () => {
  assert.equal(isAdminGroup(META['g-org']), true);
  assert.equal(isAdminGroup({ name: 'jira-admins-acme', admin: false }), true);
  assert.equal(isAdminGroup({ name: 'marketing-readers', admin: false }), false);
  for (const n of ['site-admins', 'org-admins', 'administrators', 'confluence-admins-acme', 'Confluence-Administrators']) {
    assert.equal(isAdminGroupName(n), true, n);
  }
  for (const n of ['confluence-users-acme', 'jira-software-users-acme', '']) {
    assert.equal(isAdminGroupName(n), false, n);
  }
});

test('when the permission filter is unavailable, the standard groups are recognised by name', () => {
  const guessed = guessAccessGroups([
    { id: '1', name: 'confluence-users-acme' },
    { id: '2', name: 'confluence-users' },
    { id: '3', name: 'confluence-admins-acme' },
    { id: '4', name: 'site-admins' },
    { id: '5', name: 'org-admins' },
    { id: '6', name: 'administrators' },
    { id: '7', name: 'marketing-readers' },
    { id: '8', name: 'jira-software-users-acme' },
  ]);
  assert.deepEqual(Object.keys(guessed).sort(), ['1', '2', '3', '4', '5', '6']);
  assert.equal(guessed['1'].admin, false);
  assert.equal(guessed['3'].admin, true);
  assert.equal(guessed['4'].admin, true);
});

test('a plain user leaves every access group they are in, and the seat is freed', () => {
  const plan = planReclaim({ userGroupIds: ['g-users', 'g-team', 'some-space-group'], groupsMeta: META });
  assert.equal(plan.reclaimable, true);
  assert.deepEqual(plan.remove.map((g) => g.groupId).sort(), ['g-team', 'g-users']);
  assert.deepEqual(plan.freedProducts, [PRODUCT]);
  assert.deepEqual(plan.keptProducts, []);
  assert.ok(!plan.remove.some((g) => g.groupId === 'some-space-group'), 'groups that grant nothing are never touched');
});

test('someone whose access also comes from an admin group cannot be reclaimed, and the reason says why', () => {
  const plan = planReclaim({ userGroupIds: ['g-org', 'g-users'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'admin');
  // Leaving confluence-users would free nothing while org-admins grants Confluence.
  assert.deepEqual(plan.remove, []);
  assert.match(reasonText(plan), /org-admins/);
  assert.match(reasonText(plan), /admin role/);
});

test('the person running the app and protected accounts are never reclaimable', () => {
  const self = planReclaim({ userGroupIds: ['g-users'], groupsMeta: META, protectedReason: 'self' });
  const prot = planReclaim({ userGroupIds: ['g-users'], groupsMeta: META, protectedReason: 'protected' });
  assert.equal(self.reclaimable, false);
  assert.equal(prot.reclaimable, false);
  assert.deepEqual(self.remove, []);
  assert.match(reasonText(self), /This is you/);
  assert.match(reasonText(prot), /protected/);
});

test('a user outside every access group is reported, not acted on', () => {
  const plan = planReclaim({ userGroupIds: ['some-space-group'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'no-access-groups');
  assert.match(reasonText(plan), /already be free/);
});

test('duplicate group ids do not cause duplicate removals', () => {
  const plan = planReclaim({ userGroupIds: ['g-users', 'g-users'], groupsMeta: META });
  assert.equal(plan.remove.length, 1);
});

test('with no group map at all the reason is missing data, not a free seat', () => {
  const plan = planReclaim({ userGroupIds: ['g-users'], groupsMeta: {} });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'no-role-data');
  assert.match(reasonText(plan), /which groups grant Confluence/);
  assert.equal(planReclaim({ userGroupIds: undefined, groupsMeta: undefined }).reclaimable, false);
});

test('a user whose groups the scan could not read stays selectable, and is planned live at reclaim', () => {
  const plan = planReclaim({ userGroupIds: null, groupsMeta: META });
  assert.equal(plan.reclaimable, true);
  assert.equal(plan.pending, true);
  assert.deepEqual(plan.remove, []);
  assert.match(reasonText(plan), /read live when you reclaim/);
  // A real plan carries no reason text.
  assert.equal(reasonText(planReclaim({ userGroupIds: ['g-users'], groupsMeta: META })), null);
});

test('skip reasons at reclaim time are plain', () => {
  assert.match(reasonText({ reclaimable: false, reason: 'active-since-scan' }), /contributed to Confluence since the scan/);
  assert.match(reasonText({ reclaimable: false, reason: 'unconfirmed-activity' }), /Could not confirm/);
});

test('a 403 on reclaim tells the admin that site admin is required', () => {
  assert.match(explainChange(403, null), /site admins/);
  assert.match(explainChange(404, { message: 'Group not found' }), /Group not found/);
  assert.match(explainChange(400, { message: 'Something else' }), /Confluence returned 400/);
});

test('a group synced from an identity provider gets a plain explanation', () => {
  assert.equal(isIdpManaged(400, { message: 'Group not modifiable' }), true);
  assert.equal(isIdpManaged(403, { message: 'This group is managed by an external identity provider' }), true);
  assert.match(explainChange(400, { message: 'Group not modifiable' }), /identity provider/);
  assert.equal(isIdpManaged(400, { message: 'User is already a member of the group' }), false);
  assert.equal(isIdpManaged(500, { message: 'Group not modifiable' }), false);
});

test('undo treats "already a member" as restored', () => {
  assert.equal(alreadyMember(400, { message: 'User is already a member of the group' }), true);
  assert.equal(alreadyMember(409, { message: 'Membership already exists' }), true);
  assert.equal(alreadyMember(400, { message: 'Something else' }), false);
  assert.equal(alreadyMember(500, null), false);
});

test('after a reclaim, the seat counts as free only when the site directory no longer grants "use"', () => {
  const use = { operation: 'use', targetType: 'application' };
  const admin = { operation: 'administer', targetType: 'application' };
  const page = [
    { user: { accountId: 'a1', accountType: 'atlassian', operations: [use] } },
    { user: { accountId: 'a2', accountType: 'atlassian', operations: [admin] } },
    { user: { accountId: 'a3', accountType: 'atlassian' } },
  ];
  assert.equal(seatHeldInSearch(page, 'a1'), true, 'still has use');
  assert.equal(seatHeldInSearch(page, 'a2'), false, 'listed without use');
  assert.equal(seatHeldInSearch(page, 'gone'), false, 'no longer in the directory');
  assert.equal(seatHeldInSearch(page, 'a3'), null, 'operations missing: unknown, never a false alarm');
  assert.equal(seatHeldInSearch(undefined, 'a1'), null);
  // Results may also come un-nested.
  assert.equal(seatHeldInSearch([{ accountId: 'a1', operations: [] }], 'a1'), false);
});
