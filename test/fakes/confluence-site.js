// A small fake Confluence site for the scan and reclaim tests. It answers the
// endpoints the app calls. A test changes its fields to set up a case.

const DAY = 24 * 60 * 60 * 1000;

export function makeSite() {
  const site = {
    // Every group on the site: id -> { name, members, access }, where access
    // is the global permission the group holds: 'user', 'admin', 'site-admin' or none.
    groups: {
      'g-users': { name: 'confluence-users-acme', members: [], access: 'user' },
      'g-cadm': { name: 'confluence-admins-acme', members: [], access: 'admin' },
      'g-site': { name: 'site-admins', members: [], access: 'site-admin' },
      'g-team': { name: 'team-blue', members: [], access: null },
    },
    users: {},
    // accountId -> days since the person last created something (absent: never).
    lastCreated: {},
    // accountId -> content the person once contributed to that someone changed in the window.
    contributed: {},
    // Content the activity sweep returns.
    sweep: [],
    // The next answers for a call, by "<METHOD> <path start>": a list of
    // { status, body, headers } used once each, before the normal answer.
    once: {},
    // A promise the next call waits for before it is answered, so a test can
    // hold one copy of a slice while another copy runs.
    holdNext: null,
    // The same, for the first call whose path starts with `holdAt.path`.
    holdAt: null,
    // What happened, for assertions.
    removed: [],
    added: [],

    addUser(accountId, groupIds, extra = {}) {
      site.users[accountId] = { accountId, displayName: `Name ${accountId}`, accountType: 'atlassian', accountStatus: 'active', ...extra };
      for (const g of groupIds) site.groups[g].members.push(accountId);
    },
    groupsOf(accountId) {
      return Object.entries(site.groups)
        .filter(([, g]) => g.members.includes(accountId))
        .map(([id, g]) => ({ type: 'group', id, name: g.name }));
    },
    canUse(accountId) {
      return Object.values(site.groups).some((g) => g.access && g.members.includes(accountId));
    },
    asResult(accountId) {
      return { user: { ...site.users[accountId], operations: [{ operation: 'use', targetType: 'application' }] } };
    },

    handle(method, rawPath, body, as) {
      if (site.holdNext) {
        const held = site.holdNext;
        site.holdNext = null;
        return held.then(() => site.handle(method, rawPath, body, as));
      }
      if (site.holdAt && rawPath.startsWith(site.holdAt.path)) {
        const held = site.holdAt.until;
        site.holdAt = null;
        return held.then(() => site.handle(method, rawPath, body, as));
      }
      const url = new URL(rawPath, 'https://acme.atlassian.net');
      const p = url.pathname;
      const q = url.searchParams;
      for (const [start, list] of Object.entries(site.once)) {
        const [m, prefix] = start.split(' ');
        if (m === method && p.startsWith(prefix) && list.length) return list.shift();
      }

      if (p === '/wiki/rest/api/user/current') {
        return { body: { operations: [{ operation: 'administer', targetType: 'application' }] } };
      }
      if (p === '/wiki/rest/api/group') {
        const type = q.get('accessType');
        const all = Object.entries(site.groups)
          .filter(([, g]) => (type ? g.access === type : true))
          .map(([id, g]) => ({ type: 'group', id, name: g.name }));
        const start = Number(q.get('start') ?? 0);
        return { body: { results: all.slice(start, start + Number(q.get('limit') ?? 200)), _links: {} } };
      }
      if (p === '/wiki/rest/api/search/user') {
        const one = (q.get('cql') ?? '').match(/user\.accountid = "([^"]+)"/);
        if (one) return { body: { results: site.canUse(one[1]) ? [site.asResult(one[1])] : [] } };
        const holders = Object.keys(site.users).filter((id) => site.canUse(id));
        const start = Number(q.get('start') ?? 0);
        const page = holders.slice(start, start + Number(q.get('limit') ?? 200));
        return { body: { results: page.map((id) => site.asResult(id)), totalSize: holders.length } };
      }
      if (p === '/wiki/rest/api/user/bulk') {
        return { body: { results: (q.get('accountId') ?? '').split(',').map((id) => site.users[id]).filter(Boolean) } };
      }
      if (p === '/wiki/rest/api/user/memberof') {
        const start = Number(q.get('start') ?? 0);
        return { body: { results: site.groupsOf(q.get('accountId')).slice(start, start + Number(q.get('limit') ?? 200)), _links: {} } };
      }
      if (p === '/wiki/rest/api/content/search') {
        const cql = q.get('cql') ?? '';
        const days = Number((cql.match(/now\("-(\d+)d"\)/) ?? [])[1]);
        const created = cql.match(/^creator = "([^"]+)"/);
        if (created) {
          const last = site.lastCreated[created[1]];
          return { body: { results: last !== undefined && last <= days ? [{ id: 'c1', type: 'page' }] : [], _links: {} } };
        }
        const contributed = cql.match(/^contributor = "([^"]+)"/);
        if (contributed) return { body: { results: site.contributed[contributed[1]] ?? [], _links: {} } };
        return { body: { results: site.sweep, _links: {} } };
      }
      if (p.startsWith('/wiki/api/v2/') && p.endsWith('/versions')) {
        return { body: { results: [], _links: {} } };
      }
      if (p === '/wiki/rest/api/group/userByGroupId' && method === 'DELETE') {
        const g = site.groups[q.get('groupId')];
        const accountId = q.get('accountId');
        // What storage held at the moment of the change, for the order test.
        site.removed.push({ groupId: q.get('groupId'), accountId, as, storedBefore: [...(globalThis.__kvs?.entries() ?? [])].filter(([k]) => k.startsWith('log:entry:')).map(([, v]) => ({ accountId: v.accountId, status: v.status })) });
        if (!g) return { status: 404, body: { message: 'Group not found' } };
        g.members = g.members.filter((id) => id !== accountId);
        return { status: 204, body: null };
      }
      if (p === '/wiki/rest/api/group/userByGroupId' && method === 'POST') {
        const g = site.groups[q.get('groupId')];
        if (!g) return { status: 404, body: { message: 'Group not found' } };
        if (g.members.includes(body.accountId)) return { status: 400, body: { message: 'User is already a member of the group' } };
        g.members.push(body.accountId);
        site.added.push({ groupId: q.get('groupId'), accountId: body.accountId, as });
        return { status: 201, body: {} };
      }
      return { status: 404, body: { message: `fake site: no answer for ${method} ${p}` } };
    },
  };
  return site;
}

/** An item as the content search returns it, last changed by `by`, `daysAgo` days ago. */
export const item = (type, id, by, daysAgo = 1) => ({
  type,
  id,
  version: { by: { accountId: by }, when: new Date(Date.now() - daysAgo * DAY).toISOString() },
});
