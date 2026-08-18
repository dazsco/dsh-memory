import { promises as fs } from 'node:fs';

/**
 * Orphan recovery for dsh-atomic-write writer locks. The upstream protocol
 * deliberately never steals a lock (file age alone cannot prove the owner
 * stopped) and leaves orphan recovery to the operator — but our lock files
 * contain the owner PID, so liveness IS provable: a lock whose owner PID is
 * dead can never be released, and is safe to remove once it is older than
 * the grace window (so we never race a lock being created this very moment).
 * Without this, one kill of the DSH process mid-dream bricks every write to
 * the affected store until an operator deletes the lock files by hand.
 */
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not signalable → treat as alive.
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove `lockFile` if it is an orphan (older than the grace window AND its
 * owner PID is dead). Never touches a lock whose owner is still alive.
 * Returns true when the lock was removed.
 */
export async function healOrphanLock(lockFile: string): Promise<boolean> {
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    const st = await fs.stat(lockFile);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    return false; // no lock file — nothing to heal
  }
  if (ageMs < ORPHAN_GRACE_MS) return false;
  let raw = '';
  try {
    raw = await fs.readFile(lockFile, 'utf8');
  } catch {
    return false;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false; // unparseable owner — never delete on doubt
  if (pidAlive(pid)) return false; // owner still running — never steal
  await fs.rm(lockFile, { force: true });
  return true;
}

/** True when `err` is a dsh-atomic-write writer-lock timeout. */
export function isLockTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out waiting for the writer lock/.test(err.message);
}
