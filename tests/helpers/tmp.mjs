import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run one test body against a throwaway $DSH_HOME. dsh-home-paths re-reads the
 * env on every call, so this gives every test a private memory root.
 */
export async function withDshHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

export async function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a predicate until true or the timeout expires. */
export async function waitFor(pred, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await waitMs(stepMs);
  }
}
