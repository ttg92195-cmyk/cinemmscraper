import { NextRequest, NextResponse } from 'next/server'
import { db, ensureSchema } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 60

// Ensure DB tables exist before any request (Railway ephemeral filesystem)
async function ensureDb() {
  try {
    await ensureSchema()
  } catch {
    // ignore — table creation is best-effort
  }
}

/**
 * POST /api/manual-link
 *
 * Bro submits cinemm.com shortlinks for a specific movie/series.
 * We resolve each shortlink to its real stream URL (via Cloudflare 302 redirect),
 * then store the result in the ManualStreamUrl table.
 *
 * Future requests to /api/details?id=<mediaId> will return these stored URLs
 * in the `manualStreamUrls` field — so any user viewing that movie post sees
 * the stream links without having to fetch them again.
 *
 * Request body:
 *   {
 *     "mediaId": "1736115700307574",   // cinemm.com bigint ID (as string)
 *     "mediaType": "movie",             // 'movie' | 'series'
 *     "shortlinks": ["https://cinemm.com/p/R1W_...", "https://cinemm.com/p/abc..."]
 *   }
 *
 * Response:
 *   {
 *     "ok": true,
 *     "stored": 3,
 *     "failed": 1,
 *     "results": [
 *       { "shortlink": "...", "streamUrl": "...", "quality": "1080p", "stored": true },
 *       { "shortlink": "...", "error": "Shortlink did not redirect (HTTP 404)", "stored": false }
 *     ]
 *   }
 *
 * TTL: 7 days (stream URLs are stable per movie, but cinemm.com may rotate them).
 * Re-submitting the same shortlink for the same media will UPSERT (update existing).
 */

const TTL_DAYS = 7
const RATE_LIMIT_MS = 500 // 0.5s between shortlink resolves (polite to cinemm.com)

interface SubmitResult {
  shortlink: string
  streamUrl?: string
  quality?: string
  format?: string
  host?: string
  fileName?: string
  stored: boolean
  error?: string
}

function parseQuality(url: string): string {
  const m = url.match(/(8K|4K|2160p|1080p|720p|480p)/i)
  return m ? m[1].toUpperCase() : 'STD'
}

function parseFormat(url: string): string {
  const m = url.match(/\.(mkv|mp4|avi|mov|webm)(?:\?|$)/i)
  return m ? m[1].toUpperCase() : ''
}

function parseHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

function parseFileName(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    return last ? decodeURIComponent(last) : ''
  } catch {
    return ''
  }
}

export async function POST(req: NextRequest) {
  await ensureDb()
  let body: {
    mediaId?: string
    mediaType?: string
    shortlinks?: string[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { mediaId, mediaType, shortlinks } = body

  // Validate inputs
  if (!mediaId || typeof mediaId !== 'string') {
    return NextResponse.json({ error: 'Missing or invalid "mediaId"' }, { status: 400 })
  }
  if (mediaType !== 'movie' && mediaType !== 'series') {
    return NextResponse.json(
      { error: '"mediaType" must be "movie" or "series"' },
      { status: 400 },
    )
  }
  if (!Array.isArray(shortlinks) || shortlinks.length === 0) {
    return NextResponse.json(
      { error: 'Missing or empty "shortlinks" array' },
      { status: 400 },
    )
  }
  if (shortlinks.length > 50) {
    return NextResponse.json(
      { error: 'Too many shortlinks. Max 50 per submission.' },
      { status: 400 },
    )
  }

  const results: SubmitResult[] = []
  let stored = 0
  let failed = 0

  for (const shortlink of shortlinks) {
    // Validate URL format
    let parsed: URL
    try {
      parsed = new URL(shortlink)
    } catch {
      results.push({
        shortlink,
        stored: false,
        error: 'Invalid URL format',
      })
      failed++
      continue
    }
    if (parsed.hostname !== 'cinemm.com' || !parsed.pathname.startsWith('/p/')) {
      results.push({
        shortlink,
        stored: false,
        error: 'URL must be a cinemm.com shortlink (https://cinemm.com/p/...)',
      })
      failed++
      continue
    }

    // Resolve the shortlink (fetch with redirect: 'manual')
    try {
      const res = await fetch(shortlink, {
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

      if (res.status < 300 || res.status >= 400) {
        results.push({
          shortlink,
          stored: false,
          error: `Shortlink did not redirect (HTTP ${res.status})`,
        })
        failed++
        continue
      }

      const streamUrl = res.headers.get('location')
      if (!streamUrl) {
        results.push({
          shortlink,
          stored: false,
          error: 'Redirect status but no Location header',
        })
        failed++
        continue
      }

      // Parse metadata from streamUrl
      const quality = parseQuality(streamUrl)
      const format = parseFormat(streamUrl)
      const host = parseHost(streamUrl)
      const fileName = parseFileName(streamUrl)

      // Calculate expiry
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + TTL_DAYS)

      // Upsert into DB — if the same shortlink already exists for this media,
      // update it (refresh TTL + metadata); otherwise insert new.
      try {
        // Find existing by (mediaId, shortlink) — note: SQLite doesn't support
        // composite unique constraints easily, so we query first.
        const existing = await db.manualStreamUrl.findFirst({
          where: { mediaId, shortlink },
        })
        if (existing) {
          await db.manualStreamUrl.update({
            where: { id: existing.id },
            data: {
              streamUrl,
              quality,
              format,
              host,
              fileName,
              expiresAt,
            },
          })
        } else {
          await db.manualStreamUrl.create({
            data: {
              mediaId,
              mediaType,
              shortlink,
              streamUrl,
              quality,
              format,
              host,
              fileName,
              expiresAt,
            },
          })
        }
        stored++
        results.push({
          shortlink,
          streamUrl,
          quality,
          format,
          host,
          fileName,
          stored: true,
        })
      } catch (dbErr) {
        results.push({
          shortlink,
          streamUrl,
          stored: false,
          error: `DB write failed: ${dbErr instanceof Error ? dbErr.message : 'unknown'}`,
        })
        failed++
      }
    } catch (e) {
      results.push({
        shortlink,
        stored: false,
        error: e instanceof Error ? e.message : 'Failed to resolve',
      })
      failed++
    }

    // Rate limit between requests
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
  }

  return NextResponse.json({
    ok: true,
    stored,
    failed,
    results,
    mediaId,
    mediaType,
  })
}

/**
 * GET /api/manual-link?mediaId=<id>&mediaType=<movie|series>
 *
 * Returns all stored stream URLs for a given movie/series.
 * Used by /api/details to populate the `manualStreamUrls` field.
 * Expired entries (older than 7 days) are filtered out + lazily deleted.
 */
export async function GET(req: NextRequest) {
  await ensureDb()
  const { searchParams } = new URL(req.url)
  const mediaId = searchParams.get('mediaId')
  const mediaType = searchParams.get('mediaType') ?? 'movie'

  if (!mediaId) {
    return NextResponse.json({ error: 'Missing "mediaId"' }, { status: 400 })
  }
  if (mediaType !== 'movie' && mediaType !== 'series') {
    return NextResponse.json(
      { error: '"mediaType" must be "movie" or "series"' },
      { status: 400 },
    )
  }

  const now = new Date()
  // Fetch non-expired entries
  const entries = await db.manualStreamUrl.findMany({
    where: {
      mediaId,
      mediaType,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Lazily delete expired entries for this mediaId (background cleanup)
  db.manualStreamUrl.deleteMany({
    where: {
      mediaId,
      mediaType,
      expiresAt: { lte: now },
    },
  }).catch(() => {}) // fire-and-forget

  return NextResponse.json({
    mediaId,
    mediaType,
    count: entries.length,
    manualStreamUrls: entries.map((e) => ({
      shortlink: e.shortlink,
      streamUrl: e.streamUrl,
      quality: e.quality,
      format: e.format,
      host: e.host,
      fileName: e.fileName,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
    })),
  })
}

/**
 * DELETE /api/manual-link?mediaId=<id>&mediaType=<type>&shortlink=<url>
 *
 * Removes a specific shortlink entry (e.g. if Bro pasted a wrong one).
 * If shortlink is omitted, deletes ALL entries for the mediaId+mediaType.
 */
export async function DELETE(req: NextRequest) {
  await ensureDb()
  const { searchParams } = new URL(req.url)
  const mediaId = searchParams.get('mediaId')
  const mediaType = searchParams.get('mediaType') ?? 'movie'
  const shortlink = searchParams.get('shortlink')

  if (!mediaId) {
    return NextResponse.json({ error: 'Missing "mediaId"' }, { status: 400 })
  }

  const where: any = { mediaId, mediaType }
  if (shortlink) {
    where.shortlink = shortlink
  }

  const result = await db.manualStreamUrl.deleteMany({ where })
  return NextResponse.json({
    ok: true,
    deleted: result.count,
    mediaId,
    mediaType,
    shortlink: shortlink ?? '(all)',
  })
}
