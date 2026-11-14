// A stand-in for @forge/kvs: an in-memory map shared through globalThis, so a
// test can look at what was stored. Values are copied in and out, like the
// real store, and a value over 240 KiB is refused. A test can make the next
// calls fail with globalThis.__kvsFail = <how many>, and can answer the next
// read of one key with an older value (globalThis.__kvsOnce = { key, value }),
// to stand in for a function that read it a moment before another one wrote.
// Every key written is in globalThis.__kvsWrites, and every [key, value] in
// globalThis.__kvsSets, in order.
const store = () => (globalThis.__kvs ??= new Map());
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const SIZE_LIMIT = 240 * 1024;

const maybeFail = () => {
  if (globalThis.__kvsFail && globalThis.__kvsFail-- > 0) throw new Error('storage down');
};

export const WhereConditions = { beginsWith: (value) => ({ condition: 'BEGINS_WITH', values: [value] }) };

export const kvs = {
  async get(key) {
    maybeFail();
    const once = globalThis.__kvsOnce;
    if (once && once.key === key) {
      globalThis.__kvsOnce = null;
      return copy(once.value);
    }
    return store().has(key) ? copy(store().get(key)) : undefined;
  },
  async set(key, value, options) {
    maybeFail();
    if (JSON.stringify(value).length > SIZE_LIMIT) throw new Error(`value too large for ${key}`);
    // The one set option the app uses: the personal data report's lock.
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && store().has(key)) throw new Error(`key ${key} already exists`);
    store().set(key, copy(value));
    (globalThis.__kvsWrites ??= []).push(key);
    (globalThis.__kvsSets ??= []).push([key, copy(value)]);
  },
  async delete(key) {
    maybeFail();
    store().delete(key);
  },
  // Key prefix queries in key order, page by page, as the personal data report walks the store.
  query() {
    const q = {};
    const builder = {
      where: (field, clause) => ((q.prefix = String(clause?.values?.[0] ?? '')), builder),
      limit: (n) => ((q.limit = n), builder),
      cursor: (c) => ((q.cursor = c), builder),
      async getMany() {
        maybeFail();
        const keys = [...store().keys()].filter((k) => k.startsWith(q.prefix ?? '') && (!q.cursor || k > q.cursor)).sort();
        const page = keys.slice(0, q.limit ?? 10);
        return {
          results: page.map((key) => ({ key, value: copy(store().get(key)) })),
          ...(keys.length > page.length ? { nextCursor: page.at(-1) } : {}),
        };
      },
    };
    return builder;
  },
};
