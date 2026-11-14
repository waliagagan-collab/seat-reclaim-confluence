// A stand-in for @forge/api: every request goes to
// globalThis.__site(method, path, body, as), which returns
// { status, body, headers }. Every call is recorded in globalThis.__calls.
export function route(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += (v instanceof URLSearchParams ? v.toString() : encodeURIComponent(String(v))) + strings[i + 1];
  });
  return out;
}

const requester = (as) => {
  const request = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    (globalThis.__calls ??= []).push({ method, path, as, body });
    const res = await globalThis.__site(method, path, body, as);
    if (res?.throws) throw new Error('no response');
    const status = res?.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => res?.headers?.[h] ?? null },
      json: async () => {
        if (res?.body === undefined) throw new Error('no body');
        return res.body;
      },
    };
  };
  return { requestJira: request, requestConfluence: request };
};

export default { asApp: () => requester('app'), asUser: () => requester('user') };

// privacy.reportPersonalData: the accounts of every call are kept in
// globalThis.__reported; those listed in globalThis.__closed are answered as
// closed.
export const privacy = {
  async reportPersonalData(accounts) {
    (globalThis.__reported ??= []).push(...accounts);
    const closed = globalThis.__closed ?? [];
    return accounts.filter((a) => closed.includes(a.accountId)).map((a) => ({ accountId: a.accountId, status: 'closed' }));
  },
};
