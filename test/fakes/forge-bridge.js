// A stand-in for @forge/bridge: each test sets globalThis.__invoke.
export const invoke = (key, payload) => globalThis.__invoke(key, payload);
export const view = { getContext: async () => globalThis.__context ?? {} };
