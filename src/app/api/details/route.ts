import { NextRequest, NextResponse } from 'next/server'
import { getDetails, type MediaType } from '@/lib/cinemm'
import { fetchStreamUrlsFromBot } from '@/lib/telegram-cinemm'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/details?id=<num>&type=<movie|series>&source=<CM>&name=<...>&year=<...>&poster=<...>
 *
 * Returns full post data for a single movie/series. The result includes:
 *   - Movie: name, year, poster, overview, servers[], remaining quota
 *   - Series: name, year, poster, overview (long text with seasons/episodes), episodeImageUrls[]
 *
 * Stream URLs (3 sources, tried in order):
 *   1. cinemm.com getMovieSourcesAction — currently returns access="telegram", servers=[]
 *   2. ManualStreamUrl table — URLs Bro submitted via /api/manual-link
 *      (persists 7 days, shared across all users)
 *   3. Telegram bot @cinemmbot — automatic fallback (if session is configured)
 *
 * All three are returned in the response so the UI can show whichever is available.
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
  // Set skipTelegram=true to skip the bot integration (faster, no Telegram hit)
  const skipTelegram = searchParams.get('skipTelegram') === 'true'

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
    // Step 1: Fetch movie/series details from cinemm.com
    const details = await getDetails(
      { id, type, source, name, year, poster },
      { useCache, visitorUuid },
    ) as any

    // Step 2: If servers are empty AND we have an overview (i.e. getDetails succeeded),
    // fetch stream URLs from the @cinemmbot Telegram bot.
    // cinemm.com moved stream URLs to Telegram — getMovieSourcesAction returns
    // { ok: true, access: "telegram", servers: [] }
    let telegramStreamUrls: string[] = []
    let telegramError: string | null = null
    let telegramCached = false
    const hasServers = 'servers' in details && details.servers && details.servers.length > 0
    if (!skipTelegram && !hasServers) {
      try {
        const deepLink = type === 'movie' ? `w_m_${id}` : `w_s_${id}`
        const tgResult = await fetchStreamUrlsFromBot(deepLink)
        telegramStreamUrls = tgResult.urls
        telegramCached = tgResult.cached
        telegramError = tgResult.error ?? null
      } catch (e) {
        telegramError = e instanceof Error ? e.message : 'Telegram bot fetch failed'
      }
    }

    // Fetch manually-submitted stream URLs from the ManualStreamUrl table.
    // These are URLs that Bro (or any user) submitted via /api/manual-link.
    // They persist for 7 days and are shared across all users — so once Bro
    // submits URLs for a movie, anyone viewing that movie sees them.
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
    try {
      const now = new Date()
      const entries = await db.manualStreamUrl.findMany({
        where: {
          mediaId: idStr,
          mediaType: type,
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
