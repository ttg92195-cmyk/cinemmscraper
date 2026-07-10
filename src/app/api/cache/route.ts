import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * GET /api/cache?key=<cacheKey>
 * Returns the cached payload, or 404 if not found.
 *
 * POST /api/cache  body: { key: string, payload: string }
 * Stores the payload in SQLite.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  if (!key) {
    return NextResponse.json({ error: 'Missing "key"' }, { status: 400 })
  }
  const row = await db.cinemmCache.findUnique({ where: { cacheKey: key } })
  if (!row) return NextResponse.json({ found: false }, { status: 404 })
  return NextResponse.json({ found: true, payload: row.payload })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { key, payload } = body as { key: string; payload: string }
  if (!key || !payload) {
    return NextResponse.json({ error: 'Missing "key" or "payload"' }, { status: 400 })
  }
  await db.cinemmCache.upsert({
    where: { cacheKey: key },
    create: { cacheKey: key, payload },
    update: { payload },
  })
  return NextResponse.json({ ok: true })
}
