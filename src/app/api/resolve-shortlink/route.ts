import { NextRequest, NextResponse } from 'next/server'
import { getCache, setCache } from '@/lib/cache'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * GET /api/resolve-shortlink?url=<shortlink>
 *
 * Resolves a cinemm.com shortlink (e.g. https://cinemm.com/p/R1W_eSSX2hE-...)
 * to its real stream URL by following the 302 redirect.
 *
 * cinemm.com uses Cloudflare with `referrer-policy: no-referrer`, so the
 * resolved URL only works when opened from the shortlink itself (the browser
 * strips the Referer header, which cinemm.com requires). When you resolve
 * the shortlink server-side and try to fetch the real URL directly, you get
 * 403 Forbidden. So this endpoint returns BOTH URLs:
 *   - shortlink (use this in browser — it works via redirect)
 *   - streamUrl (the real underlying URL — for display/info only)
 *
 * Response:
 *   {
 *     "shortlink": "https://cinemm.com/p/R1W_...",
 *     "streamUrl": "https://cmappsecond8.cmdrive.xyz/...mp4",
 *     "cached": false,
 *     "error": null
 *   }
 *
 * Cache: 24 hours (shortlinks are stable per movie)
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const SHORTLINK_PREFIX = 'https://cinemm.com/p/'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const url = searchParams.get('url') ?? ''

  if (!url) {
    return NextResponse.json(
      { error: 'Missing "url" query parameter (e.g. ?url=https://cinemm.com/p/R1W_...)' },
      { status: 400 },
    )
  }

  // Validate URL format — only allow cinemm.com shortlinks to prevent SSRF
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
  }
  if (parsed.hostname !== 'cinemm.com' || !parsed.pathname.startsWith('/p/')) {
    return NextResponse.json(
      { error: 'URL must be a cinemm.com shortlink (https://cinemm.com/p/...)' },
      { status: 400 },
    )
  }

  // Check cache
  const cacheKey = `shortlink:${url}`
  const cached = await getCache<{ streamUrl: string }>(cacheKey)
  if (cached?.streamUrl) {
    return NextResponse.json({
      shortlink: url,
      streamUrl: cached.streamUrl,
      cached: true,
      error: null,
    })
  }

  // Resolve the shortlink — fetch with redirect: 'manual' to capture the Location header
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual', // don't follow — we want the 302 Location header
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    })

    // 3xx = redirect with Location header
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (location) {
        // Cache the result
        await setCache(cacheKey, { streamUrl: location })
        return NextResponse.json({
          shortlink: url,
          streamUrl: location,
          cached: false,
          error: null,
          httpStatus: res.status,
        })
      }
    }

    // If no redirect, maybe the shortlink is invalid or expired
    return NextResponse.json(
      {
        shortlink: url,
        streamUrl: null,
        cached: false,
        error: `Shortlink did not redirect (HTTP ${res.status}). It may be invalid or expired.`,
        httpStatus: res.status,
      },
      { status: 404 },
    )
  } catch (e) {
    return NextResponse.json(
      {
        shortlink: url,
        streamUrl: null,
        cached: false,
        error: e instanceof Error ? e.message : 'Failed to resolve shortlink',
      },
      { status: 502 },
    )
  }
}
