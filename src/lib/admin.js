import api, { route } from '@forge/api';

/**
 * Server-side authorization for every resolver.
 *
 * The admin page is only rendered for Confluence administrators, but a
 * resolver can be invoked directly, so where the module appears is not an
 * authorization control. Every resolver asks Confluence, as the calling
 * user, whether that user administers this site, and refuses otherwise.
 * Any failure to confirm (network, 5xx, odd response) refuses too.
 */

export const NOT_ADMIN_MESSAGE =
  'Only Confluence administrators can use Seat Reclaim. Ask a site admin to open it.';
export const CHECK_FAILED_MESSAGE =
  'Could not confirm that you are a Confluence administrator. Refresh the page and try again.';

/** Pure: a /user/current body (expand=operations) -> is this a site admin? */
export function isConfluenceAdmin(user) {
  return (
    Array.isArray(user?.operations) &&
    user.operations.some((o) => o?.operation === 'administer' && o?.targetType === 'application')
  );
}

/** Asks Confluence as the calling user. Never throws. */
export async function checkAdmin() {
  try {
    const res = await api
      .asUser()
      .requestConfluence(route`/wiki/rest/api/user/current?expand=operations`, {
        headers: { Accept: 'application/json' },
      });
    if (res.status === 401 || res.status === 403) return { allowed: false, reason: 'not-admin' };
    if (!res.ok) return { allowed: false, reason: 'check-failed' };
    const body = await res.json();
    return isConfluenceAdmin(body)
      ? { allowed: true }
      : { allowed: false, reason: 'not-admin' };
  } catch {
    return { allowed: false, reason: 'check-failed' };
  }
}

/** Pure: the response a refused resolver returns. */
export const refusal = (reason) => ({
  ok: false,
  forbidden: true,
  error: reason === 'not-admin' ? NOT_ADMIN_MESSAGE : CHECK_FAILED_MESSAGE,
});

/** Wraps a resolver so it runs only for a confirmed administrator. */
export const adminOnly =
  (fn, check = checkAdmin) =>
  async (request) => {
    const gate = await check(request);
    return gate?.allowed === true ? fn(request) : refusal(gate?.reason);
  };
