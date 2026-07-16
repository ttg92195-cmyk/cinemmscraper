import { NextRequest, NextResponse } from 'next/server'
import { getEpisodeServers } from '@/lib/cinemm'
import { db, ensureSchema } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * GET /api/episode-servers?episodeId=<num>&source=<CM>&mediaId=<seriesId>&mediaType=series
 *
 * Returns streaming/download servers for a single episode of a series.
 * Also returns manually-submitted stream URLs (if any) for this episode
 * — these are URLs that Bro submitted via /api/manual-link with episodeId.
 *
 * Response includes:
 *   - servers[]       (from cinemm.com — usually empty, access="telegram")
 *   - manualStreamUrls[]  (from ManualStreamUrl DB table, 7-day TTL)
 *
 * Results are cached in SQLite.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const episodeIdStr = searchParams.get('episodeId') ?? ''
  const source = searchParams.get('source') ?? 'CM'
  const useCache = searchParams.get('cache') !== 'false'
  const visitorUuid = searchParams.get('uuid') || null
  // Required for fetching manual stream URLs:
  const mediaId = searchParams.get('mediaId') // series bigint ID
  const mediaType = searchParams.get('mediaType') ?? 'series'

  const episodeId = parseInt(episodeIdStr, 10)
  if (!Number.isFinite(episodeId) || episodeId <= 0) {
    return NextResponse.json(
      { error: 'Invalid or missing "episodeId" parameter' },
      { status: 400 },
    )
  }

  try {
    // Step 1: Fetch episode servers from cinemm.com
    const result: any = await getEpisodeServers(episodeId, source, { useCache, visitorUuid })

    // Step 2: Fetch manually-submitted stream URLs for this episode (if mediaId provided)
    let manualStreamUrls: Array<{
      shortlink: string
      streamUrl: string
      quality: string
      format: string
      host: string
      fileName: string
      createdAt: string
      expiresAt: string
    }> = []
    if (mediaId) {
      try {
        await ensureSchema()
        const now = new Date()
        const entries = await db.manualStreamUrl.findMany({
          where: {
            mediaId,
            mediaType,
            episodeId: episodeIdStr, // episodeId stored as string in DB
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
        })
        manualStreamUrls = entries.map((e) => ({
          shortlink: e.shortlink,
          streamUrl: e.streamUrl,
          quality: e.quality,
          format: e.format,
          host: e.host,
          fileName: e.fileName,
          createdAt: e.createdAt.toISOString(),
          expiresAt: e.expiresAt.toISOString(),
        }))
      } catch (e) {
        console.error('[/api/episode-servers] manualStreamUrls fetch failed:', e)
      }
    }

    return NextResponse.json({
      ...result,
      manualStreamUrls,
      manualStreamUrlsCount: manualStreamUrls.length,
    }, { status: 200 })
  } catch (e) {
    console.error('[/api/episode-servers] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch from cinemm.com' },
      { status: 502 },
    )
  }
}
