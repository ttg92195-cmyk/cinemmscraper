import { NextRequest, NextResponse } from 'next/server'
import { getDetails, type MediaType } from '@/lib/cinemm'

export const runtime = 'nodejs'

/**
 * GET /api/details?id=<num>&type=<movie|series>&source=<CM>&name=<...>&year=<...>&poster=<...>
 *
 * Returns full post data for a single movie/series. The result includes:
 *   - Movie: name, year, poster, overview, servers[], remaining quota
 *   - Series: name, year, poster, overview (long text with seasons/episodes), episodeImageUrls[]
 *
 * Results are cached in SQLite so re-fetching the same item is free (no quota hit).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const idStr = searchParams.get('id') ?? ''
  const type = (searchParams.get('type') ?? 'movie') as MediaType
  const source = searchParams.get('source') ?? 'CM'
  const name = searchParams.get('name') ?? ''
  const year = searchParams.get('year') ?? ''
  const poster = searchParams.get('poster') ?? ''
  const useCache = searchParams.get('cache') !== 'false'

  const id = parseInt(idStr, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid or missing "id" parameter' }, { status: 400 })
  }
  if (type !== 'movie' && type !== 'series') {
    return NextResponse.json(
      { error: 'Invalid "type"; must be "movie" or "series"' },
      { status: 400 },
    )
  }

  try {
    const details = await getDetails(
      { id, type, source, name, year, poster },
      { useCache },
    )
    // Always return 200 — the UI handles quota errors gracefully by showing
    // the search-result info and a partial JSON download option.
    return NextResponse.json(details, { status: 200 })
  } catch (e) {
    console.error('[/api/details] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch details from cinemm.com' },
      { status: 502 },
    )
  }
}
