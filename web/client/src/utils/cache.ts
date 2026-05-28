/**
 * Simple in-memory cache with TTL
 */
const store: Map<string, { data: any; expiry: number }> = new Map();

export function cacheGet(key: string): any | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { store.delete(key); return null; }
  return entry.data;
}

export function cacheSet(key: string, data: any, ttlMs: number = 60000) {
  store.set(key, { data, expiry: Date.now() + ttlMs });
}

export function cacheClear() {
  store.clear();
}
