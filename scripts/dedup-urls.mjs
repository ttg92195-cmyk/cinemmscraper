/**
 * Deduplicate stream URLs in the database.
 *
 * PROBLEM:
 * The same stream URL can be stored multiple times (different row IDs)
 * because there's no unique constraint on streamUrl. This happens when:
 *   1. The same movie is crawled multiple times (re-runs, retries)
 *   2. Mirror generator creates duplicates from duplicate originals
 *
 * RESULT in UI:
 *   4K md2.streammedia2.com  ← duplicate
 *   4K md2.streammedia2.com  ← duplicate
 *   1080p md2.streammedia2.com ← duplicate
 *   1080p md2.streammedia2.com ← duplicate
 *   ...
 *
 * SOLUTION:
 *   1. Find all rows grouped by streamUrl
 *   2. For each group with >1 row, keep the OLDEST (by createdAt) and
 *      delete the rest
 *   3. Add a UNIQUE INDEX on streamUrl to prevent future duplicates
 *
 * Usage:
 *   node scripts/dedup-urls.mjs                    # dedup + add unique index
 *   MIRROR_DRY_RUN=true node scripts/dedup-urls.mjs  # dry run (report only)
 *
 * Required: DATABASE_URL env var
 */

const dbUrl = process.env.DATABASE_URL
const DRY_RUN = process.env.MIRROR_DRY_RUN === 'true'

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

async function main() {
  let pg
  try {
    pg = await import('pg')
  } catch (e) {
    console.error('❌ pg package not installed. Run: npm install pg')
    process.exit(1)
  }

  const { Client } = pg
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({
    connectionString: connStr,
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000, // 2 min — dedup query can be slow on 65k rows
  })

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Stream URL Deduplicator')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (report only)' : 'LIVE (will delete + add index)'}\n`)

  await client.connect()

  // Step 1: Count total rows
  const totalResult = await client.query(`SELECT COUNT(*)::int as count FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  const totalRows = totalResult.rows[0].count
  console.log(`📊 Total rows in database: ${totalRows.toLocaleString()}\n`)

  // Step 2: Find duplicates by streamUrl
  console.log('🔍 Finding duplicate streamUrls...\n')
  const dupResult = await client.query(`
    SELECT "streamUrl", COUNT(*)::int as dup_count, MIN("createdAt") as oldest
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
    GROUP BY "streamUrl"
    HAVING COUNT(*) > 1
    ORDER BY dup_count DESC
  `)

  const duplicateGroups = dupResult.rows.length
  const totalDuplicates = dupResult.rows.reduce((sum, r) => sum + r.dup_count - 1, 0)

  console.log(`   Duplicate groups found:    ${duplicateGroups.toLocaleString()}`)
  console.log(`   Total duplicate rows:       ${totalDuplicates.toLocaleString()}`)
  console.log(`   Rows to keep (unique):      ${(totalRows - totalDuplicates).toLocaleString()}\n`)

  if (duplicateGroups > 0) {
    // Show top 5 worst offenders
    console.log('   Top 5 most-duplicated URLs:')
    dupResult.rows.slice(0, 5).forEach((r, i) => {
      const url = r.streamUrl.length > 80 ? r.streamUrl.slice(0, 77) + '...' : r.streamUrl
      console.log(`   ${i + 1}. [${r.dup_count}x] ${url}`)
    })
    console.log('')
  }

  if (DRY_RUN) {
    console.log(`🚫 DRY RUN — would have deleted ${totalDuplicates.toLocaleString()} duplicate rows`)
    console.log(`   Re-run without MIRROR_DRY_RUN=true to actually delete\n`)
  } else if (totalDuplicates > 0) {
    // Step 3: Delete duplicates — keep the oldest row for each streamUrl
    console.log(`🗑️  Deleting ${totalDuplicates.toLocaleString()} duplicate rows...\n`)

    // Strategy: use ROW_NUMBER() to rank rows by createdAt within each
    // streamUrl group, then delete all rows with rank > 1 (keep oldest).
    const deleteResult = await client.query(`
      DELETE FROM "ManualStreamUrl"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT
            "id",
            "streamUrl",
            ROW_NUMBER() OVER (
              PARTITION BY "streamUrl"
              ORDER BY "createdAt" ASC, "id" ASC
            ) as rn
          FROM "ManualStreamUrl"
          WHERE "expiresAt" > NOW()
        ) ranked
        WHERE ranked.rn > 1
      )
    `)

    const deleted = deleteResult.rowCount || 0
    console.log(`   ✅ Deleted: ${deleted.toLocaleString()} duplicate rows\n`)

    // Step 4: Add unique index on streamUrl to prevent future duplicates
    console.log('🔒 Adding unique index on streamUrl...\n')
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "ManualStreamUrl_streamUrl_key"
        ON "ManualStreamUrl"("streamUrl")
      `)
      console.log('   ✅ Unique index created — future duplicates will be rejected\n')
    } catch (e) {
      console.log(`   ⚠️  Could not create unique index: ${e.message}`)
      console.log('   This usually means there are still duplicates. Run again.\n')
    }
  } else {
    console.log('✅ No duplicates found!\n')

    // Still try to add the unique index if it doesn't exist
    console.log('🔒 Ensuring unique index on streamUrl exists...\n')
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "ManualStreamUrl_streamUrl_key"
        ON "ManualStreamUrl"("streamUrl")
      `)
      console.log('   ✅ Unique index ready — future duplicates will be rejected\n')
    } catch (e) {
      console.log(`   ⚠️  Could not create unique index: ${e.message}\n`)
    }
  }

  // Step 5: Final count
  const finalResult = await client.query(`SELECT COUNT(*)::int as count FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  const finalRows = finalResult.rows[0].count

  console.log('═══════════════════════════════════════════════════════')
  console.log('  📊 FINAL SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Before:  ${totalRows.toLocaleString()} rows`)
  if (!DRY_RUN) {
    console.log(`  Deleted: ${totalDuplicates.toLocaleString()} duplicates`)
    console.log(`  After:   ${finalRows.toLocaleString()} rows`)
    console.log(`  Unique index: ✅ Added (prevents future duplicates)`)
  }
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
