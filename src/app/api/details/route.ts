import { NextRequest, NextResponse } from 'next/server'
import { getDetails, type MediaType } from '@/lib/cinemm'
import { fetchStreamUrlsFromBot } from '@/lib/telegram-cinemm'
import { db, ensureSchema } from '@/lib/db'

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
    // Ensure DB tables exist (Railway ephemeral filesystem)
    try { await ensureSchema() } catch {}

    // Step 1: Fetch movie/series details from cinemm.com
    const details = await getDetails(
      { id, type, source, name, year, poster },
      { useCache, visitorUuid },
    ) as any

    // Step 2: Telegram bot auto-fetch is DISABLED by default.
    //
    // WHY: Previously, every /api/details call would auto-message @cinemmbot
    // to fetch stream URLs. This is dangerous because:
    //   1. High message volume → Telegram FloodWait errors
    //   2. cinemm.com (bot owner) may detect suspicious activity
    //   3. Bro's burner account could get banned
    //   4. cinemm.com could block the bot entirely
    //
    // The shortlink resolver (/api/resolve-shortlink) + manual URL submission
    // (/api/manual-link) is now the primary way to get stream URLs — it's
    // 100% reliable and doesn't touch the Telegram bot at all.
    //
    // To re-enable bot auto-fetch, set ?skipTelegram=false explicitly
    // (e.g. for testing). By default, skipTelegram defaults to true here.
    let telegramStreamUrls: string[] = []
    let telegramError: string | null = null
    let telegramCached = false
    const hasServers = 'servers' in details && details.servers && details.servers.length > 0
    // Default: skip Telegram bot (safety). Only enable if explicitly requested.
    const effectiveSkipTelegram = skipTelegram !== false ? true : false
    if (!effectiveSkipTelegram && !hasServers) {
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
