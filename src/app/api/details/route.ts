import { NextRequest, NextResponse } from 'next/server'
import { getDetails, type MediaType } from '@/lib/cinemm'
import { db, ensureSchema } from '@/lib/db'
import { sortStreamUrlsByHostPreference } from '@/lib/stream-url-sort'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/details?id=<num>&type=<movie|series>&source=<CM>&name=<...>&year=<...>&poster=<...>
 *
 * Returns full post data for a single movie/series. The result includes:
 *   - Movie: name, year, poster, overview, servers[], remaining quota
 *   - Series: name, year, poster, overview (long text with seasons/episodes), episodeImageUrls[]
 *
 * Stream URLs (2 sources, tried in order):
 *   1. cinemm.com getMovieSourcesAction — currently returns access="telegram", servers=[]
 *   2. ManualStreamUrl table — URLs Bro submitted via /api/manual-link
 *      (persists permanently, shared across all users)
 *
 * Both are returned in the response so the UI can show whichever is available.
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
  const visitorUuid = searchParams.get('uuid') || null

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
    // Ensure DB tables exist (Railway ephemeral filesystem)
    try { await ensureSchema() } catch {}

    // Step 1: Fetch movie/series details from cinemm.com
    const details = await getDetails(
      { id, type, source, name, year, poster },
      { useCache, visitorUuid },
    ) as any

    // Telegram bot auto-fetch is DISABLED (removed in cleanup commit).
    // Stream URLs come from ManualStreamUrl table (submitted by phone crawler)
    // and from cinemm.com's getMovieSourcesAction (when called from Myanmar IP).
    const telegramStreamUrls: string[] = []
    const telegramError: string | null = null
    const telegramCached = false

    // Fetch manually-submitted stream URLs from the ManualStreamUrl table.
    // For movies: returns URLs stored at movie level (episodeId is null).
    // For series: returns URLs stored at series top-level (episodeId is null).
    //   Episode-level URLs (episodeId != null) are NOT included here — they're
    //   fetched per-episode via /api/episode-servers.
    // This prevents episode URLs from showing up in the series-level UI.
    let manualStreamUrls: Array<{
      shortlink: string
      streamUrl: string
      quality: string
      format: string
      host: string
      fileName: string
      fileSize: string
      createdAt: string
      expiresAt: string
    }> = []
    try {
      const now = new Date()
      const entries = await db.manualStreamUrl.findMany({
        where: {
          mediaId: idStr,
          mediaType: type,
          episodeId: null, // ← only top-level URLs (not episode-level)
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      })
      // Sort by Bro's preferred host order: cmreel → bioscopeapp → cmappfirst → cmappsecond → other
      const sorted = sortStreamUrlsByHostPreference(entries)
      manualStreamUrls = sorted.map((e) => ({
        shortlink: e.shortlink,
        streamUrl: e.streamUrl,
        quality: e.quality,
        format: e.format,
        host: e.host,
        fileName: e.fileName,
        fileSize: e.fileSize,
        createdAt: e.createdAt.toISOString(),
        expiresAt: e.expiresAt.toISOString(),
      }))
    } catch (e) {
      console.error('[/api/details] manualStreamUrls fetch failed:', e)
    }

    // Attach all stream URL fields to the response
    return NextResponse.json({
      ...details,
      telegramStreamUrls,
      telegramError,
      telegramCached,
      manualStreamUrls,
      manualStreamUrlsCount: manualStreamUrls.length,
    }, { status: 200 })
  } catch (e) {
    console.error('[/api/details] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch details from cinemm.com' },
      { status: 502 },
    )
  }
}
