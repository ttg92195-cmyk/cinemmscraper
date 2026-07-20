import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 10

/**
 * GET /api/img?url=<cinemm.com-image-url>
 *
 * Image proxy for cinemm.com poster/episode images.
 *
 * Why: cinemm.com sets `cross-origin-resource-policy: same-origin` on its
 * image responses, which prevents browsers from loading them on other
 * domains (like our Railway app). This proxy fetches the image server-side
 * and returns it with permissive CORS headers so the browser can display it.
 *
 * Security: only allows URLs from cinemm.com (and a few related hosts) to
 * prevent SSRF abuse.
 *
 * Cache: browsers + Railway will cache for 1 day (Cache-Control header).
 */
const ALLOWED_HOSTS = [
  'cinemm.com',
  'storage01.orangeplay.org',
]

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const url = searchParams.get('url') ?? ''

  if (!url) {
    return NextResponse.json({ error: 'Missing "url" parameter' }, { status: 400 })
  }

  // Validate URL
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  // SSRF protection: only allow whitelisted hosts
  const isAllowed = ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))
  if (!isAllowed) {
    return NextResponse.json(
      { error: `URL host not allowed. Must be one of: ${ALLOWED_HOSTS.join(', ')}` },
      { status: 403 },
    )
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // Pretend we're coming from cinemm.com (helps if they check Referer)
        Referer: 'https://cinemm.com/',
      },
      signal: AbortSignal.timeout(10000),
      cache: 'force-cache' as RequestCache,
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch image (HTTP ${res.status})` },
        { status: res.status },
      )
    }

    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await res.arrayBuffer()

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        // Permissive CORS so any browser can load this
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch image' },
      { status: 502 },
    )
  }
}
