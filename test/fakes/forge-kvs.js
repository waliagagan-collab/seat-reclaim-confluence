// A stand-in for @forge/kvs: an in-memory map shared through globalThis, so a
// test can look at what was stored. Values are copied in and out, like the
// real store, and a value over 240 KiB is refused. A test can make the next
// calls fail with globalThis.__kvsFail = <how many>, and can answer the next
// read of one key with an older value (globalThis.__kvsOnce = { key, value }),
// to stand in for a function that read it a moment before another one wrote.
const store = () => (globalThis.__kvs ??= new Map());
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const SIZE_LIMIT = 240 * 1024;

const maybeFail = () => {
  if (globalThis.__kvsFail && globalThis.__kvsFail-- > 0) throw new Error('storage down');
};

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
  async set(key, value) {
    maybeFail();
    if (JSON.stringify(value).length > SIZE_LIMIT) throw new Error(`value too large for ${key}`);
    store().set(key, copy(value));
    (globalThis.__kvsWrites ??= []).push(key);
  },
  async delete(key) {
    maybeFail();
    store().delete(key);
  },
};
