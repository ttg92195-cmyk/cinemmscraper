/**
 * Restore DB backup directly to Postgres (bypasses Vercel 10s timeout).
 *
 * Use this script instead of /api/restore-db when migrating to a new
 * Postgres database. It connects directly to the database (no HTTP),
 * so there's no timeout limit.
 *
 * Usage:
 *   node scripts/restore-backup-direct.mjs <backup-file> <database-url>
 *
 * Example:
 *   node scripts/restore-backup-direct.mjs \
 *     backups/cinemmscraper-backup-latest.json \
 *     "postgresql://user:pass@db.xxx.supabase.co:5432/postgres"
 *
 * Or use env var for database URL:
 *   DATABASE_URL="postgresql://..." node scripts/restore-backup-direct.mjs \
 *     backups/cinemmscraper-backup-latest.json
 *
 * Behavior:
 *   1. Reads the backup JSON file
 *   2. Connects directly to Postgres via pg
 *   3. Creates tables if not exist (same SQL as ensureSchema)
 *   4. For each entry, upserts (updates existing, inserts new)
 *   5. Reports progress every 1000 entries
 *
 * Requires: pg package (npm install pg)
 *   On Termux: pkg install postgresql  (provides psql, but pg lib needed)
 *   Better: just run on a machine with npm install pg
 *
 * For Termux, run: npm install pg
 * (creates a local node_modules in current dir)
 */

import fs from 'fs'

const backupFile = process.argv[2]
const dbUrl = process.argv[3] || process.env.DATABASE_URL

if (!backupFile || !dbUrl) {
  console.log('Usage:')
  console.log('  node scripts/restore-backup-direct.mjs <backup-file> <database-url>')
  console.log('')
  console.log('Or use env var:')
  console.log('  DATABASE_URL="postgresql://..." node scripts/restore-backup-direct.mjs <backup-file>')
  console.log('')
  console.log('Example:')
  console.log('  node scripts/restore-backup-direct.mjs \\')
  console.log('    backups/cinemmscraper-backup-latest.json \\')
  console.log('    "postgresql://user:pass@db.xxx.supabase.co:5432/postgres"')
  process.exit(0)
}

if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
  console.error('❌ DATABASE_URL must be a postgresql:// connection string')
  console.error('   Got:', dbUrl.slice(0, 30) + '...')
  process.exit(1)
}

if (!fs.existsSync(backupFile)) {
  console.error(`❌ Backup file not found: ${backupFile}`)
  process.exit(1)
}

async function main() {
  // Dynamic import — pg may not be installed; we'll show a helpful error
  let pg
  try {
    pg = await import('pg')
  } catch (e) {
    console.error('❌ pg package is not installed.')
    console.error('   Install it first:  npm install pg')
    console.error('   (run from a directory with package.json or run: npm init -y && npm install pg)')
    process.exit(1)
  }

  const { Client } = pg

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Restore DB Backup → Postgres (Direct Connection)')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Backup file:  ${backupFile}`)
  console.log(`  Database:     ${dbUrl.replace(/:[^:@]+@/, ':***@')}\n`)

  // --- Load backup ---
  console.log('📂 Reading backup file...')
  const text = fs.readFileSync(backupFile, 'utf8')
  const sizeMB = (Buffer.byteLength(text) / (1024 * 1024)).toFixed(2)
  console.log(`   Loaded ${sizeMB} MB`)

  let backup
  try {
    backup = JSON.parse(text)
  } catch (e) {
    console.error('❌ Backup file is not valid JSON:', e.message)
    process.exit(1)
  }

  const entries = backup?.data?.manualStreamUrls
  if (!Array.isArray(entries)) {
    console.error('❌ Invalid backup format — expected data.manualStreamUrls array')
    process.exit(1)
  }
  console.log(`   ${entries.length} stream URLs to restore\n`)

  // --- Connect ---
  console.log('🔌 Connecting to Postgres...')
  const client = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 15000,
  })
  await client.connect()
  console.log('   ✅ Connected\n')

  // --- Create tables if not exist ---
  console.log('🏗️  Creating tables if not exist...')
  await client.query(`
    CREATE TABLE IF NOT EXISTS "CinemmCache" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "cacheKey" TEXT NOT NULL UNIQUE,
      "payload" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS "CinemmCache_cacheKey_idx" ON "CinemmCache"("cacheKey")`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS "ManualStreamUrl" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "mediaId" TEXT NOT NULL,
      "mediaType" TEXT NOT NULL,
      "episodeId" TEXT,
      "shortlink" TEXT NOT NULL,
      "streamUrl" TEXT NOT NULL,
      "quality" TEXT NOT NULL,
      "format" TEXT NOT NULL,
      "host" TEXT NOT NULL,
      "fileName" TEXT NOT NULL,
      "fileSize" TEXT NOT NULL DEFAULT 'N/A',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMP(3) NOT NULL
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS "ManualStreamUrl_mediaId_mediaType_episodeId_idx" ON "ManualStreamUrl"("mediaId", "mediaType", "episodeId")`)

  await client.query(`ALTER TABLE "ManualStreamUrl" ADD COLUMN IF NOT EXISTS "episodeId" TEXT`)
  await client.query(`ALTER TABLE "ManualStreamUrl" ADD COLUMN IF NOT EXISTS "fileSize" TEXT NOT NULL DEFAULT 'N/A'`)
  console.log('   ✅ Tables ready\n')

  // --- Restore entries ---
  console.log('📥 Restoring entries...\n')
  let restored = 0
  let inserted = 0
  let updated = 0
  let failed = 0
  const farFuture = '9999-12-31T23:59:59.000Z'

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    try {
      // Check if exists
      const existing = await client.query(
        `SELECT id FROM "ManualStreamUrl" WHERE "mediaId" = $1 AND COALESCE("episodeId", '') = COALESCE($2, '') AND "shortlink" = $3 LIMIT 1`,
        [entry.mediaId, entry.episodeId || null, entry.shortlink],
      )

      const id = existing.rows.length > 0 ? existing.rows[0].id : null
      const expiresAt = entry.expiresAt || farFuture
      const createdAt = entry.createdAt || new Date().toISOString()

      if (id) {
        // Update
        await client.query(`
          UPDATE "ManualStreamUrl" SET
            "streamUrl" = $1, "quality" = $2, "format" = $3, "host" = $4,
            "fileName" = $5, "fileSize" = $6, "expiresAt" = $7
          WHERE "id" = $8
        `, [
          entry.streamUrl, entry.quality || 'STD', entry.format || '',
          entry.host || 'unknown', entry.fileName || '', entry.fileSize || 'N/A',
          expiresAt, id,
        ])
        updated++
      } else {
        // Insert
        await client.query(`
          INSERT INTO "ManualStreamUrl" ("id", "mediaId", "mediaType", "episodeId", "shortlink", "streamUrl", "quality", "format", "host", "fileName", "fileSize", "createdAt", "expiresAt")
          VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          entry.mediaId, entry.mediaType || 'movie', entry.episodeId || null,
          entry.shortlink, entry.streamUrl, entry.quality || 'STD', entry.format || '',
          entry.host || 'unknown', entry.fileName || '', entry.fileSize || 'N/A',
          createdAt, expiresAt,
        ])
        inserted++
      }
      restored++
    } catch (e) {
      failed++
      if (failed <= 5) {
        console.error(`   ❌ [${i + 1}] mediaId=${entry.mediaId}: ${e.message}`)
      }
    }

    if ((i + 1) % 1000 === 0) {
      console.log(`   📊 Progress: ${i + 1}/${entries.length} (inserted=${inserted}, updated=${updated}, failed=${failed})`)
    }
  }

  await client.end()

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  ✅ RESTORE COMPLETE')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Total entries:  ${entries.length}`)
  console.log(`  Inserted:       ${inserted}`)
  console.log(`  Updated:        ${updated}`)
  console.log(`  Failed:         ${failed}`)
  console.log(`\n  Next steps:`)
  console.log(`    1. Deploy the website to Vercel (git push triggers auto-deploy)`)
  console.log(`    2. Set DATABASE_URL env var on Vercel`)
  console.log(`    3. Visit the Vercel URL to verify URLs are visible`)
  console.log('\n═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('\n❌ FATAL:', e.message)
  process.exit(1)
})
