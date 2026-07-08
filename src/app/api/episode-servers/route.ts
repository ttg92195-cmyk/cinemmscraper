import { NextRequest, NextResponse } from 'next/server'
import { getEpisodeServers } from '@/lib/cinemm'

export const runtime = 'nodejs'

/**
 * GET /api/episode-servers?episodeId=<num>&source=<CM>
 *
 * Returns streaming/download servers for a single episode of a series.
 * Results are cached in SQLite.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const episodeIdStr = searchParams.get('episodeId') ?? ''
  const source = searchParams.get('source') ?? 'CM'
  const useCache = searchParams.get('cache') !== 'false'

  const episodeId = parseInt(episodeIdStr, 10)
  if (!Number.isFinite(episodeId) || episodeId <= 0) {
    return NextResponse.json(
      { error: 'Invalid or missing "episodeId" parameter' },
      { status: 400 },
    )
  }

  try {
    const result = await getEpisodeServers(episodeId, source, { useCache })
    return NextResponse.json(result, { status: 200 })
  } catch (e) {
    console.error('[/api/episode-servers] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch from cinemm.com' },
      { status: 502 },
    )
  }
}
