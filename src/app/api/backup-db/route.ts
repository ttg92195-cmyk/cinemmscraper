import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { db, ensureSchema } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 10

/**
 * GET /api/backup-db?token=<BACKUP_TOKEN>
 *
 * Exports the entire ManualStreamUrl table as a JSON file and returns it
 * as a downloadable attachment. Designed to be called by an external
 * cron service (cron-job.org) daily so Bro always has a recent backup
 * outside of Railway.
 *
 * Security: Requires BACKUP_TOKEN env var. The cron service must send
 * this token in the ?token= query param. Without it, returns 401.
 *
 * Response:
 *   Content-Type: application/json
 *   Content-Disposition: attachment; filename="cinemmscraper-backup-YYYY-MM-DD.json"
 *   Body: {
 *     version: 1,
 *     exportedAt: "2026-07-20T...",
 *     stats: { manualStreamUrls: 1234 },
 *     data: {
 *       manualStreamUrls: [
 *         { mediaId, mediaType, episodeId, shortlink, streamUrl,
 *           quality, format, host, fileName, fileSize, createdAt, expiresAt }
 *       ]
 *     }
 *   }
 *
 * Recovery:
 *   The JSON file can be re-imported on any new host via /api/restore-db
 *   (or manually by running a script that inserts each row).
 */

export async function GET(req: NextRequest) {
  // --- Auth check ---
  const expectedToken = process.env.BACKUP_TOKEN
  if (!expectedToken) {
    return NextResponse.json(
      { error: 'Backup not configured — set BACKUP_TOKEN env var' },
      { status: 503 },
    )
  }
  const providedToken = new URL(req.url).searchParams.get('token')
  if (providedToken !== expectedToken) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 401 })
  }

  // --- Ensure DB exists ---
  try {
    await ensureSchema()
  } catch {
    // ignore — best-effort
  }

  // --- Export ManualStreamUrl rows ---
  try {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10) // YYYY-MM-DD

    const manualStreamUrls = await db.manualStreamUrl.findMany({
      orderBy: { createdAt: 'asc' },
    })

    const cacheEntries = await db.cinemmCache.count().catch(() => 0)

    const backup = {
      version: 1,
      exportedAt: now.toISOString(),
      exportedFrom: 'cinemmscraper-production.up.railway.app',
      stats: {
        manualStreamUrls: manualStreamUrls.length,
        cacheEntries,
      },
      data: {
        manualStreamUrls: manualStreamUrls.map((r) => ({
          mediaId: r.mediaId,
          mediaType: r.mediaType,
          episodeId: r.episodeId,
          shortlink: r.shortlink,
          streamUrl: r.streamUrl,
          quality: r.quality,
          format: r.format,
          host: r.host,
          fileName: r.fileName,
          fileSize: r.fileSize,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
        })),
      },
    }

    const json = JSON.stringify(backup, null, 2)
    const filename = `cinemmscraper-backup-${dateStr}.json`

    return new NextResponse(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('[/api/backup-db] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Backup failed' },
      { status: 500 },
    )
  }
}
