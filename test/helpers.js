import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundles the app's server code against stand-ins for @forge/api, @forge/kvs
 * and @forge/events (test/fakes), so the resolvers and the scan worker run
 * under plain Node against a fake site, in-memory storage and an in-memory
 * queue.
 */
export const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const fakes = {
  '@forge/api': path.join(root, 'test/fakes/forge-api.js'),
  '@forge/kvs': path.join(root, 'test/fakes/forge-kvs.js'),
  '@forge/events': path.join(root, 'test/fakes/forge-events.js'),
};

// Test files run in separate processes at the same time, so each process
// builds into files of its own and removes them when it ends.
const built = [];
process.on('exit', () => {
  for (const file of built) rmSync(file, { force: true });
});
const outFile = (name) => {
  const file = path.join(root, 'test/.build', `${name}-${process.pid}.mjs`);
  built.push(file);
  return file;
};

let loaded = null;

export async function loadServer() {
  if (loaded) return loaded;
  const out = {};
  for (const name of ['index', 'worker']) {
    const outfile = outFile(`server-${name}`);
    await build({
      entryPoints: [path.join(root, `src/${name}.js`)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      alias: fakes,
      logLevel: 'silent',
    });
    out[name] = await import(pathToFileURL(outfile).href);
  }
  // The storage layer on its own, for tests of the log and the report; where
  // the app keeps account IDs, and the hourly trigger of the personal data
  // report.
  for (const [name, entry] of [
    ['store', 'src/lib/store.js'],
    ['personal', 'src/lib/personal-data.js'],
    ['privacy', 'src/privacy.js'],
  ]) {
    const outfile = outFile(name);
    await build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      alias: fakes,
      logLevel: 'silent',
    });
    out[name] = await import(pathToFileURL(outfile).href);
  }
  loaded = out;
  return out;
}

/** The export frame's code (src/frame), bundled against a stand-in for @forge/bridge. */
export async function loadFrame() {
  const outfile = outFile('frame');
  await build({
    entryPoints: [path.join(root, 'src/frame/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    alias: { '@forge/bridge': path.join(root, 'test/fakes/forge-bridge.js') },
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

/** Start each test from empty storage, an empty queue and a given fake site. */
export function reset(site) {
  globalThis.__kvs = new Map();
  globalThis.__kvsFail = 0;
  globalThis.__kvsOnce = null;
  globalThis.__kvsWrites = [];
  globalThis.__kvsSets = [];
  globalThis.__reported = [];
  globalThis.__closed = [];
  globalThis.__queue = [];
  globalThis.__queueFail = 0;
  globalThis.__calls = [];
  globalThis.__site = (method, p, body, as) => site.handle(method, p, body, as);
}

export const ADMIN = 'admin-1';
export const CONTEXT = { environmentType: 'DEVELOPMENT' };

/** Call a resolver the way Forge does. */
export const call = (server, functionKey, payload, accountId = ADMIN, context = CONTEXT) =>
  server.index.handler({ call: { functionKey, payload }, context }, { principal: { accountId } });

/**
 * Run queued scan events until the queue is empty. A slice that asks for a
 * retry is run again, as the platform would. Returns how many events ran.
 */
export async function drain(server, max = 500) {
  let ran = 0;
  while (globalThis.__queue.length && ran < max) {
    const event = globalThis.__queue.shift();
    const res = await server.worker.handler(event);
    ran += 1;
    if (res?.options?.retryAfter) {
      globalThis.__queue.unshift({ ...event, retryContext: { retryCount: (event.retryContext?.retryCount ?? 0) + 1 } });
    }
  }
  if (globalThis.__queue.length) throw new Error('the scan did not finish');
  return ran;
}

export const stored = (key) => globalThis.__kvs.get(key);
