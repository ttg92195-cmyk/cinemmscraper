import { NextRequest, NextResponse } from 'next/server'
import { db, ensureSchema } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/restore-db?token=<BACKUP_TOKEN>
 *
 * Restores the ManualStreamUrl table from a backup JSON file (produced
 * by /api/backup-db). Used when migrating to a new host.
 *
 * Security: Requires BACKUP_TOKEN env var.
 *
 * Request body: the JSON backup file content (as produced by /api/backup-db)
 *
 * Behavior:
 *   1. Validates the backup JSON structure
 *   2. For each manualStreamUrl entry, upserts into the DB
 *      (existing entries are updated, new ones are inserted)
 *   3. Returns summary { restored, skipped, failed }
 *
 * Note: This endpoint does NOT delete existing entries. To do a clean
 * restore (delete all + insert), call /api/manual-link with DELETE for
 * each mediaId first, or run `prisma migrate reset` manually.
 */

export async function POST(req: NextRequest) {
  // --- Auth check ---
  const expectedToken = process.env.BACKUP_TOKEN
  if (!expectedToken) {
    return NextResponse.json(
      { error: 'Restore not configured — set BACKUP_TOKEN env var' },
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
    // ignore
  }

  // --- Parse backup JSON ---
  let backup: any
  try {
    backup = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!backup || !backup.data || !Array.isArray(backup.data.manualStreamUrls)) {
    return NextResponse.json(
      { error: 'Invalid backup format — expected { data: { manualStreamUrls: [...] } }' },
      { status: 400 },
    )
  }

  const entries = backup.data.manualStreamUrls
  let restored = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []

  for (const entry of entries) {
    try {
      // Validate required fields
      if (!entry.mediaId || !entry.streamUrl || !entry.shortlink) {
        skipped++
        continue
      }

      // Upsert — find existing by (mediaId, episodeId, shortlink)
      const epId = entry.episodeId ?? null
      const existing = await db.manualStreamUrl.findFirst({
        where: {
          mediaId: entry.mediaId,
          episodeId: epId,
          shortlink: entry.shortlink,
        },
      })

      if (existing) {
        // Update existing
        await db.manualStreamUrl.update({
          where: { id: existing.id },
          data: {
            streamUrl: entry.streamUrl,
            quality: entry.quality || 'STD',
            format: entry.format || '',
            host: entry.host || 'unknown',
            fileName: entry.fileName || '',
            fileSize: entry.fileSize || 'N/A',
            expiresAt: new Date(entry.expiresAt || '9999-12-31T23:59:59.000Z'),
          },
        })
      } else {
        // Insert new
        await db.manualStreamUrl.create({
          data: {
            mediaId: entry.mediaId,
            mediaType: entry.mediaType || 'movie',
            episodeId: epId,
            shortlink: entry.shortlink,
            streamUrl: entry.streamUrl,
            quality: entry.quality || 'STD',
            format: entry.format || '',
            host: entry.host || 'unknown',
            fileName: entry.fileName || '',
            fileSize: entry.fileSize || 'N/A',
            expiresAt: new Date(entry.expiresAt || '9999-12-31T23:59:59.000Z'),
          },
        })
      }
      restored++
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : 'unknown'
      errors.push(`mediaId=${entry.mediaId}: ${msg}`)
      if (errors.length > 10) break // don't flood the response
    }
  }

  return NextResponse.json({
    ok: true,
    restored,
    skipped,
    failed,
    errors: errors.length > 0 ? errors : undefined,
  })
}
