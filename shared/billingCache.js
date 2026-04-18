const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function getCached(labId) {
  const key = labId.toString();
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.blocked;
  return null;
}

export function setCached(labId, blocked) {
  cache.set(labId.toString(), {
    blocked,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function invalidate(labId) {
  cache.delete(labId.toString());
}
