type CacheEntry<T> = { value: T; expiresAt: number };

const store = new Map<string, CacheEntry<unknown>>();
const SWEEP_INTERVAL_MS = 5 * 60_000;

// In-process only — fine for a single backend instance, which is what this
// app runs as today. A short TTL keeps entries harmless even without active
// invalidation: sync jobs just make the next read (after expiry) pick up
// fresh data rather than requiring the writer to know every reader's keys.
export async function getOrSetCache<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const cached = store.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const value = await compute();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

export function invalidateCacheByPrefix(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

function sweepExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

const sweepInterval = setInterval(sweepExpiredEntries, SWEEP_INTERVAL_MS);
sweepInterval.unref();
