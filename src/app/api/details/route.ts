import { NextRequest, NextResponse } from 'next/server'
import { getDetails, type MediaType } from '@/lib/cinemm'
import { fetchStreamUrlsFromBot } from '@/lib/telegram-cinemm'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/details?id=<num>&type=<movie|series>&source=<CM>&name=<...>&year=<...>&poster=<...>
 *
 * Returns full post data for a single movie/series. The result includes:
 *   - Movie: name, year, poster, overview, servers[], remaining quota
 *   - Series: name, year, poster, overview (long text with seasons/episodes), episodeImageUrls[]
 *
 * NEW (2026-07-14+): If servers are empty (cinemm.com moved stream URLs to
 * the Telegram bot), this route automatically fetches them via @cinemmbot
 * using the gramjs MTProto user client. The URLs are returned in the
 * `telegramStreamUrls` field. Cached for 7 days.
 *
 * Results are cached in SQLite so re-fetching the same item is free.
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

    // Attach telegram fields to the response (alongside the existing fields)
    return NextResponse.json({
      ...details,
      telegramStreamUrls,
      telegramError,
      telegramCached,
    }, { status: 200 })
  } catch (e) {
    console.error('[/api/details] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch details from cinemm.com' },
      { status: 502 },
    )
  }
}
