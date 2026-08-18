import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { healOrphanLock, isLockTimeout } from '../lib/testing.js';

/** A PID that is guaranteed dead: spawn a short-lived process and wait for it. */
async function aDeadPid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid > 0);
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-lockheal-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('healOrphanLock removes an old lock owned by a dead PID', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'run.lock.lock');
    const pid = await aDeadPid();
    await writeFile(lock, `${pid}\n`);
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, past, past);
    assert.equal(await healOrphanLock(lock), true);
    await assert.rejects(access(lock), /ENOENT|no such file/i);
  });
});

test('healOrphanLock keeps a lock owned by a live PID (even when old)', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'run.lock.lock');
    await writeFile(lock, `${process.pid}\n`); // this process is alive
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, past, past);
    assert.equal(await healOrphanLock(lock), false);
    await assert.doesNotReject(access(lock));
  });
});

test('healOrphanLock keeps a fresh lock even with a dead PID (grace window)', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'run.lock.lock');
    const pid = await aDeadPid();
    await writeFile(lock, `${pid}\n`); // mtime is now → within grace
    assert.equal(await healOrphanLock(lock), false);
    await assert.doesNotReject(access(lock));
  });
});

test('healOrphanLock is a no-op when no lock file exists', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await healOrphanLock(join(dir, 'missing.lock.lock')), false);
  });
});

test('healOrphanLock keeps a lock with unparseable content (never steals on doubt)', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'run.lock.lock');
    await writeFile(lock, 'not-a-pid\n');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, past, past);
    assert.equal(await healOrphanLock(lock), false);
    await assert.doesNotReject(access(lock));
  });
});

test('isLockTimeout matches only writer-lock timeouts', () => {
  assert.equal(isLockTimeout(new Error('atomic-write: timed out waiting for the writer lock at C:\\x.lock.lock')), true);
  assert.equal(isLockTimeout(new Error('something else timed out')), false);
  assert.equal(isLockTimeout('not an error'), false);
  assert.equal(isLockTimeout(null), false);
});
