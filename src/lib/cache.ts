/**
 * Hybrid cache for cinemm.com results.
 *
 * Two layers:
 *   1. In-memory Map (fast path — microsecond reads)
 *   2. SQLite via Prisma (persistent — survives restarts)
 *
 * Writes propagate to both layers. Reads check memory first, then SQLite.
 * On a SQLite hit, the entry is also written back to memory so subsequent
 * reads stay fast.
 *
 * Cache entries expire after 24 hours. The in-memory layer runs a periodic
 * cleanup; the SQLite layer relies on TTL checks at read time (lazily) plus
 * an optional flush-stale endpoint.
 *
 * Why hybrid?
 *   - In-memory alone is lost on every Railway redeploy.
 *   - SQLite alone is slower (one DB round-trip per cache read).
 *   - The hybrid gives near-zero read latency after warm-up AND survives
 *     restarts — best of both worlds for a low-traffic personal app.
 */

import { db, ensureSchema } from '@/lib/db'

interface CacheEntry {
  value: unknown
  expiresAt: number
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Layer 1: in-memory
const memoryCache = new Map<string, CacheEntry>()

// Layer 2: SQLite (lazy — only used when memory misses)
async function getFromSqlite<T>(key: string): Promise<T | null> {
  try {
    await ensureSchema() // ensure tables exist (Railway ephemeral filesystem)
    const row = await db.cinemmCache.findUnique({ where: { cacheKey: key } })
    if (!row) return null
    // Check TTL
    const ageMs = Date.now() - row.updatedAt.getTime()
    if (ageMs > CACHE_TTL_MS) {
      // Expired — delete lazily and return miss
      await db.cinemmCache.delete({ where: { cacheKey: key } }).catch(() => {})
      return null
    }
    return JSON.parse(row.payload) as T
  } catch {
    // If DB is unavailable (e.g. cold start race), treat as miss
    return null
  }
}

async function setInSqlite(key: string, value: unknown): Promise<void> {
  try {
    await ensureSchema()
    const payload = JSON.stringify(value)
    await db.cinemmCache.upsert({
      where: { cacheKey: key },
      create: { cacheKey: key, payload },
      update: { payload },
    })
  } catch (e) {
    // Don't fail the request if cache write fails
    console.error('[cache] SQLite write failed:', e instanceof Error ? e.message : 'unknown')
  }
}

async function deleteFromSqlite(key: string): Promise<void> {
  try {
    await db.cinemmCache.delete({ where: { cacheKey: key } })
  } catch {
    // ignore
  }
}

// Public API — same signatures as before, but with SQLite fallback

export async function getCache<T>(key: string): Promise<T | null> {
  // Layer 1: memory
  const memEntry = memoryCache.get(key)
  if (memEntry) {
    if (Date.now() > memEntry.expiresAt) {
      memoryCache.delete(key)
    } else {
      return memEntry.value as T
    }
  }

  // Layer 2: SQLite
  const sqliteValue = await getFromSqlite<T>(key)
  if (sqliteValue !== null) {
    // Write back to memory for fast subsequent reads
    memoryCache.set(key, { value: sqliteValue, expiresAt: Date.now() + CACHE_TTL_MS })
    return sqliteValue
  }

  return null
}

export async function setCache<T>(key: string, value: T): Promise<void> {
  // Write to both layers
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  await setInSqlite(key, value)
}

export async function deleteCache(key: string): Promise<void> {
  memoryCache.delete(key)
  await deleteFromSqlite(key)
}

/**
 * Flush ALL cached entries (memory + SQLite). Useful for debugging or when
 * cinemm.com changes its API and we need a fresh fetch.
 */
export async function flushAllCache(): Promise<{ memory: number; sqlite: number }> {
  const memoryCount = memoryCache.size
  memoryCache.clear()
  let sqliteCount = 0
  try {
    const result = await db.cinemmCache.deleteMany({})
    sqliteCount = result.count
  } catch (e) {
    console.error('[cache] flushAll SQLite failed:', e instanceof Error ? e.message : 'unknown')
  }
  return { memory: memoryCount, sqlite: sqliteCount }
}

/**
 * Get cache statistics (counts + estimated size).
 */
export async function getCacheStats(): Promise<{
  memoryEntries: number
  sqliteEntries: number
  ttlMs: number
}> {
  let sqliteEntries = 0
  try {
    sqliteEntries = await db.cinemmCache.count()
  } catch {
    // ignore
  }
  return {
    memoryEntries: memoryCache.size,
    sqliteEntries,
    ttlMs: CACHE_TTL_MS,
  }
}

// Periodic cleanup of expired memory entries (every 10 minutes)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of memoryCache.entries()) {
      if (now > entry.expiresAt) memoryCache.delete(key)
    }
  }, 10 * 60 * 1000).unref?.()
}
