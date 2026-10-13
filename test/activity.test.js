import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceContent,
  filterLicensedUsers,
  normaliseProfile,
  searchParams,
  nextCursor,
  windowStart,
  buildSweepCql,
  buildCreatedCql,
  buildContributedCql,
  classifyDormancy,
  scanVersions,
  CONTENT_TYPES,
} from '../src/lib/confluence.js';
import { shardOf, SHARDS, sortDormant, mergeDormant } from '../src/lib/store.js';
import { isStale, normaliseDays, licenseGate, licenseMessage } from '../src/lib/scan.js';

const person = (id) => ({ accountId: id, displayName: id });
const NOW = Date.parse('2026-09-23T12:00:00Z');
const since90 = windowStart(90, NOW);

// --- the activity rules: the product's central claim --------------------------

test('the latest editor of recently modified content is active', () => {
  const activity = reduceContent(
    [{ type: 'page', version: { by: person('alice'), when: '2026-09-20T10:00:00.000Z', number: 4 } }],
    since90
  );
  assert.equal(activity.alice.via, 'edited');
});

test('the creator counts only when the creation itself is inside the window', () => {
  // Old page by "leaver", edited last week by "stayer": leaver must NOT look active.
  const activity = reduceContent(
    [
      {
        type: 'page',
        history: { createdBy: person('leaver'), createdDate: '2024-03-01T10:00:00.000Z' },
        version: { by: person('stayer'), when: '2026-09-18T10:00:00.000Z', number: 9 },
      },
    ],
    since90
  );
  assert.equal(activity.leaver, undefined, 'a colleague editing your old page is not your activity');
  assert.equal(activity.stayer.via, 'edited');
});

test('a fresh comment marks its author active via creation', () => {
  const activity = reduceContent(
    [
      {
        type: 'comment',
        history: { createdBy: person('bob'), createdDate: '2026-09-21T09:00:00.000Z' },
        version: { by: person('bob'), when: '2026-09-21T09:00:00.000Z', number: 1 },
      },
    ],
    since90
  );
  assert.ok(activity.bob);
});

test('keeps the latest timestamp per person', () => {
  const activity = reduceContent(
    [
      { version: { by: person('eve'), when: '2026-09-04T05:00:00.000Z' } },
      { version: { by: person('eve'), when: '2026-09-10T05:00:00.000Z' } },
      { version: { by: person('eve'), when: '2026-09-07T05:00:00.000Z' } },
    ],
    since90
  );
  assert.equal(activity.eve.at, '2026-09-10T05:00:00.000Z');
});

test('without a window, every recorded action counts (pure reducer default)', () => {
  const activity = reduceContent([{ version: { by: person('ancient'), when: '2019-01-01T00:00:00.000Z' } }]);
  assert.ok(activity.ancient);
});

test('survives empty, missing and malformed pages', () => {
  assert.deepEqual(reduceContent([], since90), {});
  assert.deepEqual(reduceContent(undefined, since90), {});
  assert.deepEqual(reduceContent([{}], since90), {});
  assert.deepEqual(reduceContent([null], since90), {});
  assert.deepEqual(reduceContent([{ version: { by: null, when: 'garbage' } }], since90), {});
});

test('never leaks the internal comparison field', () => {
  const activity = reduceContent([{ version: { by: person('gina'), when: '2026-09-20T10:00:00.000Z' } }], since90);
  assert.deepEqual(Object.keys(activity.gina).sort(), ['at', 'via']);
});

// --- who holds a seat ---------------------------------------------------------

const use = [{ operation: 'use', targetType: 'application' }];

test('keeps human accounts that can use the site; drops apps and customers', () => {
  const users = filterLicensedUsers([
    { user: { accountId: 'a1', accountType: 'atlassian', operations: use } },
    { user: { accountId: 'b1', accountType: 'app', operations: use } },
    { user: { accountId: 'c1', accountType: 'customer', operations: use } },
    { user: { accountId: 'd1', accountType: 'atlassian', operations: [{ operation: 'view_analytics', targetType: 'application' }] } },
    { user: { accountId: 'e1', accountType: 'atlassian' } }, // operations not expanded: keep
  ]);
  assert.deepEqual(users.map((u) => u.accountId), ['a1', 'e1']);
});

test('seat filter accepts bare user objects and non-array responses', () => {
  assert.deepEqual(filterLicensedUsers([{ accountId: 'x', accountType: 'atlassian' }]), [{ accountId: 'x' }]);
  assert.deepEqual(filterLicensedUsers(null), []);
  assert.deepEqual(filterLicensedUsers({ message: 'nope' }), []);
});

test('seat filter keeps only the account id — no names or emails reach storage', () => {
  const users = filterLicensedUsers([
    { user: { accountId: 'a1', accountType: 'atlassian', displayName: 'Human', email: 'h@x.io', operations: use } },
  ]);
  assert.deepEqual(users, [{ accountId: 'a1' }]);
});

test('profiles: guests and deactivated accounts are recognised; hidden emails become null', () => {
  assert.deepEqual(normaliseProfile({ displayName: 'G', email: '', isGuest: true, accountStatus: 'active', accountType: 'atlassian' }), {
    displayName: 'G',
    email: null,
    active: true,
    guest: true,
    accountType: 'atlassian',
  });
  assert.equal(normaliseProfile({ accountStatus: 'inactive' }).active, false);
  assert.equal(normaliseProfile({ accountStatus: 'closed' }).active, false);
  assert.equal(normaliseProfile({}).active, true, 'absent status is treated as active');
  assert.equal(normaliseProfile({ publicName: 'P' }).displayName, 'P');
});

// --- the wire format: route() encodes values itself, so never pre-encode --------

test('searchParams passes raw CQL and drops empty values', () => {
  const p = searchParams({ cql: 'type = user', limit: 200, cursor: null, x: '' });
  assert.equal(p.get('cql'), 'type = user', 'must not be pre-encoded');
  assert.equal(p.has('cursor'), false);
  assert.equal(p.has('x'), false);
  assert.equal(p.get('limit'), '200');
});

test('pagination follows the cursor in _links.next, falling back to start', () => {
  assert.deepEqual(nextCursor('/rest/api/content/search?cursor=abc%3D%3D&limit=50&cql=x'), { cursor: 'abc==' });
  assert.deepEqual(nextCursor('/rest/api/content/search?start=50&limit=50'), { start: 50 });
  assert.equal(nextCursor(null), null);
  assert.equal(nextCursor('/rest/api/content/search?start=0'), null);
});

test('sweep CQL is bounded to the window and covers every content type', () => {
  const cql = buildSweepCql(90);
  assert.ok(cql.includes('lastmodified >= now("-90d")'));
  for (const t of ['page', 'blogpost', 'comment', 'attachment']) assert.ok(CONTENT_TYPES.includes(t));
  assert.ok(cql.startsWith('type in ('));
});

test('per-user CQL quotes the account id and only lists things the user DID', () => {
  const created = buildCreatedCql('557058:abc-def', 90);
  const contributed = buildContributedCql('557058:abc-def', 90);
  assert.ok(created.includes('creator = "557058:abc-def"'), 'account ids contain a colon and must be quoted');
  assert.ok(created.includes('created >= now("-90d")'));
  assert.ok(contributed.includes('contributor = "557058:abc-def"'));
  assert.ok(contributed.includes('lastmodified >= now("-90d")'));
  assert.ok(!/watcher|mention|favourite/.test(created + contributed), 'watching or being mentioned is not activity');
});

test('the window start matches N whole days before now', () => {
  assert.equal(windowStart(30, NOW), NOW - 30 * 86_400_000);
});

// --- dormancy bands -----------------------------------------------------------

test('the band starts at the last probe that found nothing, and longer bands sort higher', () => {
  assert.deepEqual(classifyDormancy(90, { 180: true }), { bucket: '90-180', label: '90–180 days', severity: 1 });
  // Inactive in 90 and in 180 but active within 365: that is 180–365, not 90–365.
  assert.deepEqual(classifyDormancy(90, { 180: false, 365: true }), { bucket: '180-365', label: '180–365 days', severity: 2 });
  assert.deepEqual(classifyDormancy(90, { 180: false, 365: false }), {
    bucket: 'over-365',
    label: 'Over a year, or never',
    severity: 3,
  });
});

test('a 365-day window has no wider probe and goes straight to the top band', () => {
  assert.equal(classifyDormancy(365, {}).bucket, 'over-365');
});

test('report sorts longest-dormant first, then by account id (names are not stored)', () => {
  const rows = sortDormant([
    { accountId: 'z', severity: 1 },
    { accountId: 'a', severity: 2 },
    { accountId: 'b', severity: 2 },
    { accountId: 'c', severity: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.accountId), ['a', 'b', 'c', 'z']);
});

// --- storage ------------------------------------------------------------------

test('sharding is deterministic, in range, and spreads accounts', () => {
  const counts = new Array(SHARDS).fill(0);
  for (let i = 0; i < 2000; i++) {
    const id = `712020:${i}-abcdef`;
    const s = shardOf(id);
    assert.ok(Number.isInteger(s) && s >= 0 && s < SHARDS);
    assert.equal(s, shardOf(id));
    counts[s]++;
  }
  assert.ok(Math.max(...counts) < 2000 * 0.35, 'badly skewed');
  assert.ok(Math.min(...counts) > 0, 'a shard is never used');
});

// --- stuck-scan detection -----------------------------------------------------

test('a running scan with no cursor movement for 20 minutes is stale', () => {
  const t = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(isStale({ status: 'running', updatedAt: '2026-09-21T11:50:00Z' }, t), false);
  assert.equal(isStale({ status: 'running', updatedAt: '2026-09-21T11:30:00Z' }, t), true);
  assert.equal(isStale({ status: 'complete', updatedAt: '2026-09-21T10:00:00Z' }, t), false);
  assert.equal(isStale(null, t), false);
});

// --- paid-app licence gate ----------------------------------------------------

test('production requires an active licence; a missing licence is a refusal', () => {
  assert.equal(licenseGate({ active: true }, 'PRODUCTION').allowed, true);
  assert.equal(licenseGate({ active: true, isEvaluation: true }, 'PRODUCTION').reason, 'trial');
  assert.equal(licenseGate({ active: false }, 'PRODUCTION').allowed, false);
  assert.equal(licenseGate(undefined, 'PRODUCTION').allowed, false);
});

test('development and staging are never locked out by an absent licence', () => {
  assert.equal(licenseGate(undefined, 'DEVELOPMENT').allowed, true);
  assert.equal(licenseGate(undefined, undefined).allowed, true);
  assert.equal(licenseGate({ active: false }, 'DEVELOPMENT').reason, 'simulated-inactive');
});

test('the refusal message points at Confluence, not Jira', () => {
  assert.equal(licenseMessage({ allowed: true }, {}), null);
  assert.match(licenseMessage({ allowed: false, reason: 'missing' }, null), /Confluence/);
  assert.ok(!/Jira/.test(licenseMessage({ allowed: false, reason: 'missing' }, null)));
});

test('the audit window only accepts the offered values', () => {
  assert.equal(normaliseDays(30), 30);
  assert.equal(normaliseDays('180'), 180);
  assert.equal(normaliseDays(7), 90, 'unknown values fall back to the default');
  assert.equal(normaliseDays('DROP TABLE'), 90);
});

// --- version-history walk (pages and blog posts edited by many hands) ----------

test('a version saved by the user inside the window proves activity', () => {
  const versions = [
    { number: 12, authorId: 'other', createdAt: '2026-09-22T10:00:00.000Z' },
    { number: 11, authorId: 'me', createdAt: '2026-09-01T10:00:00.000Z' },
  ];
  assert.equal(scanVersions(versions, 'me', since90), true);
});

test('stops looking once the versions are older than the window', () => {
  const versions = [
    { number: 3, authorId: 'other', createdAt: '2026-09-22T10:00:00.000Z' },
    { number: 2, authorId: 'other', createdAt: '2026-08-01T10:00:00.000Z' },
    { number: 1, authorId: 'me', createdAt: '2024-01-01T10:00:00.000Z' }, // outside: does not count
  ];
  assert.equal(scanVersions(versions, 'me', since90), false, 'the oldest version is outside the window');
});

test('asks for the next page only when every version so far is inside the window', () => {
  const versions = [
    { number: 5, authorId: 'other', createdAt: '2026-09-22T10:00:00.000Z' },
    { number: 4, authorId: 'other', createdAt: '2026-09-20T10:00:00.000Z' },
  ];
  assert.equal(scanVersions(versions, 'me', since90), 'more');
  assert.equal(scanVersions([], 'me', since90), false);
  assert.equal(scanVersions(undefined, 'me', since90), false);
});

test('a replayed verify slice does not duplicate users in the dormant list', () => {
  const existing = [{ accountId: 'a', bucket: 'over-365' }];
  const merged = mergeDormant(existing, [{ accountId: 'a', bucket: 'over-365' }, { accountId: 'b', bucket: '90-180' }]);
  assert.deepEqual(merged.map((r) => r.accountId), ['a', 'b']);
  assert.deepEqual(mergeDormant(undefined, []), []);
});
