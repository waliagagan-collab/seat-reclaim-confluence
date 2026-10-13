import api, { route } from '@forge/api';

/**
 * Every Confluence read the app makes, and every rule about what counts as
 * "active", lives in this file. That rule is the product's central claim and
 * the thing customers will argue with, so it stays explicit and in one place.
 *
 * Two layers:
 *   1. A cheap SWEEP over recently-modified content proves most users active.
 *   2. An exhaustive per-user VERIFY runs only for the remaining candidates,
 *      so a wrong answer can't come from the sweep being partial.
 *
 * What Confluence can and cannot tell an app: it records who created and who
 * edited every page, blog post, comment and attachment, with a timestamp. It
 * records nothing about who VIEWED anything, and exposes no login dates. So
 * "active" here means "contributed", and the UI says so in plain words.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const HEADERS = { Accept: 'application/json' };

/**
 * `route` encodes each interpolated query value itself, so values must be
 * passed RAW. A URLSearchParams instance is passed through verbatim, which is
 * the one safe way to build a multi-parameter query string.
 */
export function searchParams(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p;
}

/** The path without its query string: enough to name the call, never the CQL. */
const endpointOf = (path) => {
  const s = String(path ?? '');
  const q = s.indexOf('?');
  return q >= 0 ? s.slice(0, q) : s;
};

function explain(status, body, path) {
  const detail = body?.message ? ` — ${body.message}` : '';
  const at = ` (${endpointOf(path)})`;
  if (status === 401 || status === 403) {
    return `Confluence refused the request (${status})${at}. The app is probably missing a permission it was granted after install — reinstalling it re-grants the current scopes.${detail}`;
  }
  if (status === 400) return `Confluence rejected the query (400)${at}${detail}`;
  return `Confluence returned ${status}${at}${detail}`;
}

/**
 * `asUser` runs the call as the admin who opened the page. The site's user
 * search answers the app inconsistently between sites (one site returned
 * nothing to the app while listing every user to the admin), so everything
 * about WHO holds a seat is read as the admin, from resolvers. Content is
 * read as the app, from the background worker, where no user context exists.
 */
async function getJson(path, { asUser = false } = {}) {
  let res;
  try {
    const ctx = asUser ? api.asUser() : api.asApp();
    res = await ctx.requestConfluence(path, { headers: HEADERS });
  } catch (err) {
    // No response at all: a dropped connection or platform hiccup. Retry.
    err.retryable = true;
    throw err;
  }

  if (res.status === 429) {
    const err = new Error('Rate limited by Confluence');
    err.rateLimited = true;
    err.retryAfter = Math.max(1, Number(res.headers.get('Retry-After')) || 5);
    throw err;
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(explain(res.status, body, path));
    err.status = res.status;
    // A 5xx is Confluence having a moment, not a reason to abandon a scan.
    err.retryable = res.status >= 500;
    throw err;
  }
  return res.json();
}

const searchContent = (params) => getJson(route`/wiki/rest/api/content/search?${params}`);

// ---------------------------------------------------------------------------
// Who holds a seat
// ---------------------------------------------------------------------------

/**
 * Confluence has no application-role endpoint, and product access can be
 * granted through any group, so group membership is not a seat count. The one
 * list that matches the "Users" figure Atlassian shows for Confluence in the
 * admin hub is the site's own user search: it returns only accounts that can
 * use THIS Confluence site. Checked against the admin hub on two sites.
 *
 * Pure: a page of user-search results -> seat-consuming account ids.
 * accountType 'app' (bots, Connect apps) and 'customer' never hold a seat.
 * When Confluence reports the account's operations, it must include "use".
 */
export function filterLicensedUsers(results) {
  return (Array.isArray(results) ? results : [])
    .map((r) => r?.user ?? r)
    .filter((u) => u?.accountId && u?.accountType === 'atlassian' && canUse(u))
    .map((u) => ({ accountId: u.accountId }));
}

const canUse = (u) =>
  !Array.isArray(u.operations) ||
  u.operations.some((o) => o?.operation === 'use' && o?.targetType === 'application');

const USER_PAGE = 200;

/** One page of the site's users, by offset. */
export async function fetchUserPage(start) {
  const params = searchParams({ cql: 'type = user', start, limit: USER_PAGE, expand: 'operations' });
  const body = await getJson(route`/wiki/rest/api/search/user?${params}`, { asUser: true });
  const results = body?.results ?? [];
  const total = Number.isFinite(body?.totalSize) ? body.totalSize : null;
  return {
    users: filterLicensedUsers(results),
    // Pagination follows the RAW page length, not the filtered length, or a
    // page of bots would end the listing early.
    isLast: results.length < USER_PAGE || (total !== null && start + results.length >= total),
    nextStart: start + USER_PAGE,
  };
}

const BULK_PAGE = 50;
const BULK_CONCURRENCY = 5;

/**
 * Profiles for account ids: display name and email for the report (resolved
 * at read time, never stored), plus the two facts the seat count needs —
 * whether the account is still active, and whether it is a guest. Guests do
 * not consume a Confluence licence.
 */
export async function fetchProfiles(accountIds) {
  const ids = [...new Set((accountIds ?? []).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += BULK_PAGE) chunks.push(ids.slice(i, i + BULK_PAGE));
  const out = {};
  const fetchChunk = async (chunk) => {
    const params = searchParams({ accountId: chunk.join(','), limit: BULK_PAGE });
    const body = await getJson(route`/wiki/rest/api/user/bulk?${params}`, { asUser: true });
    for (const u of body?.results ?? []) {
      if (u?.accountId) out[u.accountId] = normaliseProfile(u);
    }
  };
  for (let i = 0; i < chunks.length; i += BULK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + BULK_CONCURRENCY).map(fetchChunk));
  }
  return out;
}

/** Pure: a raw user object -> the few fields the app uses. */
export function normaliseProfile(u) {
  return {
    displayName: u?.displayName || u?.publicName || '(unknown)',
    email: u?.email ? u.email : null,
    // An absent status is treated as active: the account came from the
    // site's user search, which does not list closed accounts.
    active: u?.accountStatus ? u.accountStatus === 'active' : true,
    guest: Boolean(u?.isGuest),
    accountType: u?.accountType ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sweep: what changed recently, and who did it
// ---------------------------------------------------------------------------

const epoch = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the audit window, matching CQL's now("-Nd"). */
export const windowStart = (days, at = Date.now()) => at - Number(days) * DAY_MS;

export const CONTENT_TYPES = ['page', 'blogpost', 'comment', 'attachment', 'whiteboard', 'database'];

export const buildSweepCql = (days) =>
  `type in (${CONTENT_TYPES.join(', ')}) and lastmodified >= now("-${Number(days)}d") order by lastmodified desc`;

/**
 * Pure reducer: a page of content -> { accountId -> { at, via } }, keeping
 * only actions that happened inside the window.
 *
 * Content modified recently may have been CREATED years ago by someone else,
 * so the creator counts only if the creation itself is inside the window.
 * Without that rule a departed author would look active whenever a colleague
 * touches their old page — the exact case the report exists to catch.
 */
export function reduceContent(items, since) {
  const activity = {};
  const floor = Number.isFinite(since) ? since : -Infinity;

  const mark = (person, at, via) => {
    const id = person?.accountId;
    const ts = id && at ? epoch(at) : null;
    if (ts === null || ts < floor) return;
    const prev = activity[id];
    if (!prev || ts > prev.ts) activity[id] = { at, via, ts };
  };

  for (const item of items ?? []) {
    mark(item?.version?.by, item?.version?.when, 'edited');
    mark(item?.history?.createdBy, item?.history?.createdDate, 'created');
  }

  for (const entry of Object.values(activity)) delete entry.ts;
  return activity;
}

/** Pure: the cursor (or offset) carried by a `_links.next` value. */
export function nextCursor(nextLink) {
  if (!nextLink || typeof nextLink !== 'string') return null;
  const q = nextLink.includes('?') ? nextLink.slice(nextLink.indexOf('?') + 1) : '';
  const p = new URLSearchParams(q);
  const cursor = p.get('cursor');
  if (cursor) return { cursor };
  const start = Number(p.get('start'));
  return Number.isFinite(start) && start > 0 ? { start } : null;
}

/** One page of recently modified content. */
export async function fetchContentPage(days, cursor, pageSize) {
  const params = searchParams({
    cql: buildSweepCql(days),
    limit: pageSize,
    expand: 'version,history',
    ...(cursor?.cursor ? { cursor: cursor.cursor } : {}),
    ...(cursor?.start ? { start: cursor.start } : {}),
  });
  const body = await searchContent(params);
  const results = body?.results ?? [];
  const next = nextCursor(body?._links?.next);
  return {
    activity: reduceContent(results, windowStart(days)),
    count: results.length,
    nextCursor: next,
    isLast: !next || results.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Verify: an exhaustive per-user check that does not depend on the sweep
// ---------------------------------------------------------------------------

const quote = (accountId) => JSON.stringify(String(accountId));

/** Pure. Anything the user created inside the window — exact. */
export const buildCreatedCql = (accountId, days) =>
  `creator = ${quote(accountId)} and created >= now("-${Number(days)}d")`;

/**
 * Pure. Content the user ever created or edited that was modified inside the
 * window by ANYONE. A superset of what we want: if it is empty the user made
 * no edit in the window; if not, the version history decides.
 */
export const buildContributedCql = (accountId, days) =>
  `contributor = ${quote(accountId)} and lastmodified >= now("-${Number(days)}d") order by lastmodified desc`;

const CONTRIB_PAGE = 25; // candidate items examined per user
const VERSION_PAGE = 100;
const MAX_VERSION_ITEMS = 10; // items whose history is walked
const MAX_VERSION_PAGES = 3; // 300 versions per item

const byUser = (version, accountId, since) =>
  version?.by?.accountId === accountId && (epoch(version?.when) ?? -Infinity) >= since;

/**
 * Only pages and blog posts get a full history walk: they are the content
 * many people edit in turn. A comment or attachment is edited by its author
 * or nobody, so its latest version already says who acted. Whiteboards and
 * databases expose no version list to apps.
 */
const VERSIONED = { page: 'pages', blogpost: 'blogposts' };

/** Pure: a v2 versions page -> true | false | 'more' (older versions remain). */
export function scanVersions(results, accountId, since) {
  let sawInWindow = false;
  for (const v of results ?? []) {
    const ts = epoch(v?.createdAt) ?? -Infinity;
    if (ts < since) continue; // sorted newest-first, but never rely on it
    sawInWindow = true;
    if (v?.authorId === accountId) return true;
  }
  // Newest-first: if the oldest version on this page is already outside the
  // window, nothing further back can be inside it.
  const last = results?.[results.length - 1];
  const oldest = last ? (epoch(last?.createdAt) ?? -Infinity) : -Infinity;
  if (!results?.length || oldest < since) return false;
  return sawInWindow ? 'more' : false;
}

/** Did this user save a version of the item inside the window? true | false | 'unknown' */
async function userEditedSince(item, accountId, since) {
  const collection = VERSIONED[item?.type];
  if (!collection || !item?.id) return false;
  let cursor = null;
  for (let page = 0; page < MAX_VERSION_PAGES; page++) {
    const params = searchParams({ limit: VERSION_PAGE, sort: '-modified-date', ...(cursor ? { cursor } : {}) });
    const body = await getJson(route`/wiki/api/v2/${collection}/${item.id}/versions?${params}`);
    const r = scanVersions(body?.results, accountId, since);
    if (r !== 'more') return r;
    cursor = nextCursor(body?._links?.next)?.cursor ?? null;
    if (!cursor) return false;
  }
  return 'unknown';
}

/**
 * true | false | 'unknown'. 'unknown' means the user touches more content than
 * the check can examine within budget; the caller treats it as active, so a
 * wrong name never reaches the list.
 */
export async function wasActiveWithin(accountId, days) {
  const since = windowStart(days);

  const created = await searchContent(searchParams({ cql: buildCreatedCql(accountId, days), limit: 1 }));
  if ((created?.results ?? []).length) return true;

  const contributed = await searchContent(
    searchParams({ cql: buildContributedCql(accountId, days), limit: CONTRIB_PAGE, expand: 'version' })
  );
  const items = contributed?.results ?? [];
  if (!items.length) return false;
  if (items.some((it) => byUser(it?.version, accountId, since))) return true;

  // Someone else made the latest edit on every item; walk the histories.
  let unknown = false;
  for (const it of items.slice(0, MAX_VERSION_ITEMS)) {
    const r = await userEditedSince(it, accountId, since);
    if (r === true) return true;
    if (r === 'unknown') unknown = true;
  }
  if (unknown || items.length > MAX_VERSION_ITEMS || contributed?._links?.next) return 'unknown';
  return false;
}

/**
 * Pure. Given the audit window and the wider probes that came back inactive
 * or active, name the dormancy band. Severity sorts the report: the longer
 * dormant, the higher up.
 */
export const PROBES = [180, 365];

export function classifyDormancy(days, probeResults) {
  const wider = PROBES.filter((p) => p > days);
  // The band's lower bound is the last probe that found nothing: inactive in
  // 90 and in 180 but active in 365 means 180–365 days, not 90–365.
  let floor = days;
  for (let i = 0; i < wider.length; i++) {
    const p = wider[i];
    if (probeResults[p] === true) {
      return { bucket: `${floor}-${p}`, label: `${floor}–${p} days`, severity: i + 1 };
    }
    floor = p;
  }
  return {
    bucket: `over-${floor}`,
    label: floor >= 365 ? 'Over a year, or never' : `Over ${floor} days`,
    severity: wider.length + 1,
  };
}

/** Runs the probes for a candidate the sweep could not vouch for. */
export async function verifyCandidate(accountId, days) {
  const first = await wasActiveWithin(accountId, days);
  if (first === true) return { active: true };
  if (first === 'unknown') return { active: true, unverified: true };

  const probeResults = {};
  for (const p of PROBES) {
    if (p <= days) continue;
    const r = await wasActiveWithin(accountId, p);
    probeResults[p] = r !== false; // 'unknown' closes the band conservatively
    if (probeResults[p]) break; // found the band; no need to look wider
  }
  return { active: false, ...classifyDormancy(days, probeResults) };
}

// ---------------------------------------------------------------------------
// Self-test: which of the calls the scan needs does this site allow?
// ---------------------------------------------------------------------------

/**
 * One cheap call per endpoint the scan depends on, each reported by outcome.
 * Shown to the admin when a scan fails on a permission error, so the message
 * names the exact missing grant instead of "something was refused". A scope
 * added in an update is only granted when the admin accepts the upgrade, and
 * this is how they find that out.
 */
export async function diagnose() {
  const results = [];
  const attempt = async (name, scope, fn) => {
    try {
      const value = await fn();
      results.push({ name, scope, ok: true });
      return value;
    } catch (err) {
      results.push({ name, scope, ok: false, status: err?.status ?? null, error: String(err?.message ?? err) });
      return null;
    }
  };

  const users = await attempt('List the site\'s licensed users', 'read:content-details:confluence', () =>
    getJson(route`/wiki/rest/api/search/user?${searchParams({ cql: 'type = user', limit: 5 })}`, { asUser: true })
  );
  if (users) {
    const n = users?.totalSize ?? users?.size ?? (users?.results ?? []).length;
    results[results.length - 1].name += ` (${n} found)`;
  }
  const firstUser = users?.results?.[0]?.user?.accountId ?? users?.results?.[0]?.accountId ?? null;
  if (firstUser) {
    await attempt('Read user profiles', 'read:confluence-user', () =>
      getJson(route`/wiki/rest/api/user/bulk?${searchParams({ accountId: firstUser, limit: 1 })}`, { asUser: true })
    );
  } else {
    results.push({ name: 'Read user profiles', scope: 'read:confluence-user', ok: null, note: 'skipped: no user to look up' });
  }

  await attempt('List the groups that grant Confluence', 'read:confluence-groups', () =>
    getJson(route`/wiki/rest/api/group?${searchParams({ accessType: 'user', limit: 5 })}`, { asUser: true })
  );
  if (firstUser) {
    await attempt("Read a user's groups", 'read:confluence-user', () =>
      getJson(route`/wiki/rest/api/user/memberof?${searchParams({ accountId: firstUser, limit: 5 })}`, { asUser: true })
    );
  }

  const content = await attempt('Search recently modified content', 'search:confluence', () =>
    searchContent(searchParams({ cql: 'type = page order by lastmodified desc', limit: 1 }))
  );
  const firstPage = content?.results?.[0]?.id ?? null;
  if (firstPage) {
    await attempt('Read a page\'s version history', 'read:page:confluence', () =>
      getJson(route`/wiki/api/v2/pages/${firstPage}/versions?${searchParams({ limit: 1 })}`)
    );
  } else {
    results.push({ name: 'Read a page\'s version history', scope: 'read:page:confluence', ok: null, note: 'skipped: the site has no pages yet' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Groups: which ones grant Confluence, and which ones a user is in
// ---------------------------------------------------------------------------

export const PRODUCT = 'Confluence';

/**
 * Confluence has no application-role endpoint, but its group list can be
 * filtered by the global permission a group holds: `user` (Can use — the
 * seat), `admin` (Confluence admin) and `site-admin`. Members of any of these
 * hold a seat; the admin ones are never removed (see reclaim.js).
 */
export const ACCESS_TYPES = ['user', 'admin', 'site-admin'];
const GROUP_PAGE = 200;
const MAX_GROUPS = 5000;

/** Pure: a v1 group object -> { id, name }, or null when it carries no id. */
export const normaliseGroup = (g) => (g?.id ? { id: String(g.id), name: g.name ?? String(g.id) } : null);

/**
 * Pure: group lists per access type -> { groupId -> { name, products, admin } }.
 * A group that appears under more than one type keeps the stricter flag.
 */
export function buildGroupsMeta(byType) {
  const meta = {};
  for (const type of ACCESS_TYPES) {
    for (const raw of byType?.[type] ?? []) {
      const g = normaliseGroup(raw);
      if (!g) continue;
      const entry = meta[g.id] ?? { name: g.name, products: [PRODUCT], admin: false };
      if (type !== 'user') entry.admin = true;
      meta[g.id] = entry;
    }
  }
  return meta;
}

/**
 * Pure fallback for sites whose group list cannot be filtered by permission:
 * the groups Atlassian itself creates for product access and administration,
 * recognised by name. Custom access groups are missed, which the UI says.
 */
export function guessAccessGroups(groups) {
  const meta = {};
  for (const raw of groups ?? []) {
    const g = normaliseGroup(raw);
    if (!g) continue;
    const n = g.name.toLowerCase();
    if (/^confluence-users(-|$)/.test(n)) meta[g.id] = { name: g.name, products: [PRODUCT], admin: false };
    else if (/^(confluence-admins?|confluence-administrators|site-admins|org-admins|administrators)(-|$)/.test(n)) {
      meta[g.id] = { name: g.name, products: [PRODUCT], admin: true };
    }
  }
  return meta;
}

async function fetchGroupPages(params, asUser) {
  const out = [];
  for (let start = 0; out.length < MAX_GROUPS; start += GROUP_PAGE) {
    const body = await getJson(route`/wiki/rest/api/group?${searchParams({ ...params, start, limit: GROUP_PAGE })}`, { asUser });
    const results = body?.results ?? [];
    out.push(...results);
    if (results.length < GROUP_PAGE) break;
  }
  return out;
}

/**
 * { groupId -> { name, products, admin } } for every group that grants
 * Confluence, plus `source`: 'permissions' when Confluence answered the
 * permission filter, 'names' when the app had to fall back to group names.
 * Read as the admin by default: the identity the site answers reliably.
 */
export async function fetchAccessGroups({ asUser = true } = {}) {
  const byType = {};
  try {
    for (const type of ACCESS_TYPES) byType[type] = await fetchGroupPages({ accessType: type }, asUser);
  } catch (err) {
    if (err.status !== 400) throw err;
    // The permission filter is not understood here: recognise the standard groups by name.
    return { groupsMeta: guessAccessGroups(await fetchGroupPages({}, asUser)), source: 'names' };
  }
  return { groupsMeta: buildGroupsMeta(byType), source: 'permissions' };
}

/** The groups a user is in right now: [{ id, name }]. */
export async function fetchUserGroups(accountId, { asUser = false } = {}) {
  const out = [];
  for (let start = 0; out.length < MAX_GROUPS; start += GROUP_PAGE) {
    const params = searchParams({ accountId, start, limit: GROUP_PAGE });
    const body = await getJson(route`/wiki/rest/api/user/memberof?${params}`, { asUser });
    const results = body?.results ?? [];
    out.push(...results.map(normaliseGroup).filter(Boolean));
    if (results.length < GROUP_PAGE) break;
  }
  return out;
}

/**
 * Does Confluence still let this account use the site? true | false | null
 * (null: Confluence did not report the account's operations). Asked after a
 * reclaim, so the app reports what Confluence says rather than what it hoped.
 */
export async function canUseConfluence(accountId, { asUser = true } = {}) {
  const params = searchParams({ accountId, expand: 'operations' });
  const body = await getJson(route`/wiki/rest/api/user?${params}`, { asUser });
  if (!Array.isArray(body?.operations)) return null;
  return body.operations.some((o) => o?.operation === 'use' && o?.targetType === 'application');
}

const COUNT_PAGES = 15; // 3,000 accounts; beyond that the count is reported as partial

/**
 * How many accounts can use Confluence right now, as the admin, from the same
 * list the scan uses. Shown before and after a reclaim so the admin sees the
 * site's own number move. Bounded, so a very large site gets a partial count
 * flagged as such rather than a slow page.
 */
export async function countLicensedUsers() {
  let start = 0;
  let count = 0;
  for (let i = 0; i < COUNT_PAGES; i++) {
    const page = await fetchUserPage(start);
    count += page.users.length;
    if (page.isLast) return { count, exact: true };
    start = page.nextStart;
  }
  return { count, exact: false };
}
