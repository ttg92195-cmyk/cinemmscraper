import { NextRequest, NextResponse } from 'next/server'
import {
  getCache,
  setCache,
  deleteCache,
  flushAllCache,
  getCacheStats,
} from '@/lib/cache'

export const runtime = 'nodejs'

/**
 * /api/cache endpoints
 *
 * GET /api/cache?key=<cacheKey>            — read a single cache entry
 * GET /api/cache?stats=1                   — cache stats (memory + SQLite counts)
 * GET /api/cache?flush=1                   — flush ALL cache entries (memory + SQLite)
 * GET /api/cache?delete=<cacheKey>         — delete a single cache entry
 * POST /api/cache  body: { key, payload }  — write a cache entry
 *
 * Cache is hybrid: in-memory Map (fast) + SQLite via Prisma (persistent).
 * TTL: 24 hours.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  const stats = searchParams.get('stats')
  const flush = searchParams.get('flush')
  const delKey = searchParams.get('delete')

  // Stats endpoint — useful for debugging "is the cache working?"
  if (stats === '1') {
    const s = await getCacheStats()
    return NextResponse.json({
      ...s,
      ttlHours: s.ttlMs / (60 * 60 * 1000),
    })
  }

  // Flush endpoint — wipe everything when cinemm.com changes its API
  if (flush === '1') {
    const result = await flushAllCache()
    return NextResponse.json({
      ok: true,
      flushed: result,
      message: `Cleared ${result.memory} memory entries and ${result.sqlite} SQLite entries`,
    })
  }

  // Delete a single key
  if (delKey) {
    await deleteCache(delKey)
    return NextResponse.json({ ok: true, deleted: delKey })
  }

  // Read a single key
  if (!key) {
    return NextResponse.json({ error: 'Missing "key" (or use ?stats=1 / ?flush=1)' }, { status: 400 })
  }
  const value = await getCache<unknown>(key)
  if (value === null) return NextResponse.json({ found: false }, { status: 404 })
  return NextResponse.json({ found: true, payload: JSON.stringify(value) })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { key, payload } = body as { key: string; payload: string }
  if (!key || !payload) {
    return NextResponse.json({ error: 'Missing "key" or "payload"' }, { status: 400 })
  }
  try {
    await setCache(key, JSON.parse(payload))
  } catch {
    return NextResponse.json({ error: 'Invalid payload JSON' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
