/**
 * In-memory cache for cinemm.com results.
 *
 * This replaces the SQLite-based cache so the app can be deployed to
 * serverless platforms (Vercel, Netlify) where the file system is
 * ephemeral. The cache is per-instance (each serverless function
 * instance has its own cache), which is fine for personal use —
 * worst case we re-fetch from cinemm.com, which now has no quota.
 *
 * Cache entries expire after 24 hours to avoid stale data.
 */

interface CacheEntry {
  value: unknown
  expiresAt: number
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const cache = new Map<string, CacheEntry>()

export async function getCache<T>(key: string): Promise<T | null> {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.value as T
}

export async function setCache<T>(key: string, value: T): Promise<void> {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

// Periodic cleanup (every 10 minutes, remove expired entries)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of cache.entries()) {
      if (now > entry.expiresAt) cache.delete(key)
    }
  }, 10 * 60 * 1000).unref?.()
}
