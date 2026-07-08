import { NextRequest, NextResponse } from 'next/server'
import { searchCinemm, type MediaType } from '@/lib/cinemm'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  const type = (searchParams.get('type') ?? 'movie') as MediaType
  const useCache = searchParams.get('cache') !== 'false'

  if (!q) {
    return NextResponse.json({ error: 'Missing "q" query parameter' }, { status: 400 })
  }
  if (type !== 'movie' && type !== 'series') {
    return NextResponse.json(
      { error: 'Invalid "type" parameter; must be "movie" or "series"' },
      { status: 400 },
    )
  }

  try {
    const { items, cached } = await searchCinemm(q, type, { useCache })
    return NextResponse.json({
      query: q,
      type,
      count: items.length,
      cached,
      items,
    })
  } catch (e) {
    console.error('[/api/search] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch from cinemm.com' },
      { status: 502 },
    )
  }
}
