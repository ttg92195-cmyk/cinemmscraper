import { NextRequest, NextResponse } from 'next/server'
import { lookupTmdbId, type MediaType } from '@/lib/cinemm'

export const runtime = 'nodejs'

/**
 * GET /api/tmdb-id?name=<...>&year=<...>&type=<movie|series>&apiKey=<...>
 *
 * Looks up the real TMDB ID for a movie/series by name + year via the public
 * TMDB API. Results are cached in SQLite (positive and negative).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const name = searchParams.get('name') ?? ''
  const year = searchParams.get('year') ?? ''
  const type = (searchParams.get('type') ?? 'movie') as MediaType
  const apiKey = searchParams.get('apiKey') ?? ''
  const useCache = searchParams.get('cache') !== 'false'

  if (!name) {
    return NextResponse.json({ error: 'Missing "name" parameter' }, { status: 400 })
  }
  if (type !== 'movie' && type !== 'series') {
    return NextResponse.json(
      { error: 'Invalid "type"; must be "movie" or "series"' },
      { status: 400 },
    )
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing "apiKey" parameter' }, { status: 400 })
  }

  try {
    const { tmdbId, cached } = await lookupTmdbId(name, year, type, apiKey, { useCache })
    return NextResponse.json({ tmdbId, cached, name, year, type })
  } catch (e) {
    console.error('[/api/tmdb-id] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to look up TMDB ID' },
      { status: 502 },
    )
  }
}
