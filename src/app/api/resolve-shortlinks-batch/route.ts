import { NextRequest, NextResponse } from 'next/server'
import { getCache, setCache } from '@/lib/cache'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/resolve-shortlinks-batch
 *
 * Resolves multiple cinemm.com shortlinks in one request.
 * Useful when Bro pastes a list of shortlinks from a movie post.
 *
 * Request body:
 *   { "urls": ["https://cinemm.com/p/R1W_...", "https://cinemm.com/p/abc..."] }
 *
 * Response:
 *   {
 *     "results": [
 *       { "shortlink": "...", "streamUrl": "...", "cached": false, "error": null },
 *       { "shortlink": "...", "streamUrl": null, "cached": false, "error": "..." }
 *     ],
 *     "total": 2,
 *     "success": 1,
 *     "failed": 1
 *   }
 *
 * Rate-limited: 500ms between requests to be polite to cinemm.com.
 */

interface ResolveResult {
  shortlink: string
  streamUrl: string | null
  cached: boolean
  error: string | null
  httpStatus?: number
}

export async function POST(req: NextRequest) {
  let body: { urls?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const urls = body.urls
  if (!Array.isArray(urls) || urls.length === 0) {
    return NextResponse.json(
      { error: 'Body must be { "urls": ["https://cinemm.com/p/...", ...] }' },
      { status: 400 },
    )
  }

  if (urls.length > 50) {
    return NextResponse.json(
      { error: 'Too many URLs. Max 50 per batch.' },
      { status: 400 },
    )
  }

  const results: ResolveResult[] = []

  for (const url of urls) {
    // Validate URL format
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      results.push({
        shortlink: url,
        streamUrl: null,
        cached: false,
        error: 'Invalid URL format',
      })
      continue
    }
    if (parsed.hostname !== 'cinemm.com' || !parsed.pathname.startsWith('/p/')) {
      results.push({
        shortlink: url,
        streamUrl: null,
        cached: false,
        error: 'URL must be a cinemm.com shortlink (https://cinemm.com/p/...)',
      })
      continue
    }

    // Check cache
    const cacheKey = `shortlink:${url}`
    const cached = await getCache<{ streamUrl: string }>(cacheKey)
    if (cached?.streamUrl) {
      results.push({
        shortlink: url,
        streamUrl: cached.streamUrl,
        cached: true,
        error: null,
      })
      continue
    }

    // Resolve the shortlink
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (location) {
          await setCache(cacheKey, { streamUrl: location })
          results.push({
            shortlink: url,
            streamUrl: location,
            cached: false,
            error: null,
            httpStatus: res.status,
          })
        } else {
          results.push({
            shortlink: url,
            streamUrl: null,
            cached: false,
            error: 'Redirect status but no Location header',
            httpStatus: res.status,
          })
        }
      } else {
        results.push({
          shortlink: url,
          streamUrl: null,
          cached: false,
          error: `Shortlink did not redirect (HTTP ${res.status})`,
          httpStatus: res.status,
        })
      }
    } catch (e) {
      results.push({
        shortlink: url,
        streamUrl: null,
        cached: false,
        error: e instanceof Error ? e.message : 'Failed to resolve',
      })
    }

    // Rate limit: 500ms between requests
    await new Promise((r) => setTimeout(r, 500))
  }

  const success = results.filter((r) => r.streamUrl !== null).length
  const failed = results.length - success

  return NextResponse.json({
    results,
    total: results.length,
    success,
    failed,
  })
}

/**
 * GET /api/resolve-shortlinks-batch?url=<u1>&url=<u2>&...
 *
 * Same as POST but via GET query params (for testing in browser).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const urls = searchParams.getAll('url')
  if (urls.length === 0) {
    return NextResponse.json(
      { error: 'Add ?url=<shortlink> query params (can repeat)' },
      { status: 400 },
    )
  }
  // Reuse POST logic by calling it with a synthesized request
  return POST(
    new NextRequest(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    }),
  )
}
