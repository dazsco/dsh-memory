// Cross-process inbox worker: appends N lines to one store's inbox.
// Used by the concurrency test (4 workers x 25 lines = 100, zero loss).
import { MemoryStore, storePathsFor, ensureDir } from '../../lib/testing.js';

const [root, n] = process.argv.slice(2);
if (!root || !n) {
  console.error('usage: inbox-worker.mjs <storeRoot> <n>');
  process.exit(2);
}
const store = new MemoryStore('global', 'global', storePathsFor(root), null);
await ensureDir(root);
await store.init();
for (let i = 0; i < Number(n); i++) {
  await store.pushInbox({
    ts: new Date().toISOString(),
    content: `worker-${process.pid}-${i}`,
    source: { session: '', turn: null },
    via: 'test',
  });
}
process.exit(0);
