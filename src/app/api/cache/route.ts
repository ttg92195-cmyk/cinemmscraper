import { NextRequest, NextResponse } from 'next/server'
import { getCache, setCache } from '@/lib/cache'

export const runtime = 'nodejs'

/**
 * GET /api/cache?key=<cacheKey>
 * POST /api/cache  body: { key: string, payload: string }
 *
 * In-memory cache for client-side fetch results. Each serverless instance
 * has its own cache (no persistence across restarts), which is fine for
 * personal use — worst case we re-fetch from cinemm.com.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  if (!key) {
    return NextResponse.json({ error: 'Missing "key"' }, { status: 400 })
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
