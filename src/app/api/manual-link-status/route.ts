import { NextRequest, NextResponse } from 'next/server'
import { db, ensureSchema } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 10

/**
 * GET /api/manual-link-status?mediaIds=123,456,789&mediaType=movie
 *
 * Batch check which movies/series have stream URLs stored.
 * Returns a map of mediaId → { hasUrls, count }.
 *
 * Used by the search results UI to show a "URLs Ready" / "No URLs" badge
 * on each card WITHOUT making a separate /api/manual-link call per item
 * (which would be slow + hit Vercel function concurrency limits).
 *
 * Request:
 *   mediaIds  — comma-separated list of cinemm.com bigint IDs (max 100)
 *   mediaType — 'movie' | 'series' (optional, default 'movie')
 *
 * Response:
 *   {
 *     mediaType: "movie",
 *     statuses: {
 *       "123": { "hasUrls": true, "count": 6 },
 *       "456": { "hasUrls": false, "count": 0 },
 *       "789": { "hasUrls": true, "count": 9 }
 *     }
 *   }
 *
 * For series, this checks the series-level URLs only (episodeId IS NULL).
 * Episode-level URLs are NOT counted here — that would require joining
 * per episode, which is too expensive for a batch endpoint. Users see
 * episode URLs when they click into the series detail page.
 */
export async function GET(req: NextRequest) {
  // Ensure DB exists
  try { await ensureSchema() } catch {}

  const { searchParams } = new URL(req.url)
  const mediaIdsParam = searchParams.get('mediaIds') ?? ''
  const mediaType = searchParams.get('mediaType') ?? 'movie'

  if (mediaType !== 'movie' && mediaType !== 'series') {
    return NextResponse.json(
      { error: '"mediaType" must be "movie" or "series"' },
      { status: 400 },
    )
  }

  const mediaIds = mediaIdsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (mediaIds.length === 0) {
    return NextResponse.json({ error: 'Missing "mediaIds" parameter' }, { status: 400 })
  }

  if (mediaIds.length > 100) {
    return NextResponse.json(
      { error: 'Too many mediaIds. Max 100 per request.' },
      { status: 400 },
    )
  }

  // Query DB for URL counts per mediaId.
  // We only count non-expired entries (expiresAt > now).
  // For movies: count where mediaId=X AND episodeId IS NULL
  // For series: count where mediaId=X AND episodeId IS NULL (top-level URLs only)
  //             — episode-level URLs are checked when user opens the series page.
  const now = new Date()
  const statuses: Record<string, { hasUrls: boolean; count: number }> = {}

  try {
    // Use groupBy for an efficient batch query
    // (Prisma doesn't support COUNT(*) GROUP BY in a clean way for multiple IDs,
    // so we use a raw SQL query)
    const ids = mediaIds.map((id) => String(id))

    // Build parameterized query for Postgres
    // SELECT "mediaId", COUNT(*) as count
    // FROM "ManualStreamUrl"
    // WHERE "mediaId" IN ($1, $2, ...) AND "mediaType" = $N AND "episodeId" IS NULL AND "expiresAt" > $N+1
    // GROUP BY "mediaId"
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    const query = `
      SELECT "mediaId", COUNT(*)::int as count
      FROM "ManualStreamUrl"
      WHERE "mediaId" IN (${placeholders})
        AND "mediaType" = $${ids.length + 1}
        AND "episodeId" IS NULL
        AND "expiresAt" > $${ids.length + 2}
      GROUP BY "mediaId"
    `
    const params = [...ids, mediaType, now]
    const rows = await db.$queryRawUnsafe<Array<{ mediaId: string; count: number }>>(query, ...params)

    // Build status map — initialize all to 0, then update from query results
    for (const id of ids) {
      statuses[id] = { hasUrls: false, count: 0 }
    }
    for (const row of rows) {
      statuses[row.mediaId] = { hasUrls: row.count > 0, count: row.count }
    }
  } catch (e) {
    console.error('[/api/manual-link-status] query failed:', e)
    // Return all-false on error so UI doesn't crash
    for (const id of mediaIds) {
      statuses[id] = { hasUrls: false, count: 0 }
    }
  }

  return NextResponse.json({
    mediaType,
    statuses,
  })
}
