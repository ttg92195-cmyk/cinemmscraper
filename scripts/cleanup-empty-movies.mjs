/**
 * Clean up movies with 0 stream URLs from the database.
 *
 * After importing from moviesmm.com, some movies were stored with 0 URLs
 * (movieSources returned empty servers array). These are useless — they
 * take up space and confuse the UI.
 *
 * This script:
 *   1. Finds all mediaIds that have 0 stream URLs
 *   2. Deletes those entries (they're empty rows with no streamUrl)
 *   3. Reports how many were cleaned up
 *
 * Usage:
 *   DATABASE_URL="..." node scripts/cleanup-empty-movies.mjs
 *   MIRROR_DRY_RUN=true DATABASE_URL="..." node scripts/cleanup-empty-movies.mjs  # dry run
 */

const dbUrl = process.env.DATABASE_URL
const DRY_RUN = process.env.MIRROR_DRY_RUN === 'true'

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

async function main() {
  let pg
  try { pg = await import('pg') } catch { console.error('❌ npm install pg'); process.exit(1) }

  const { Client } = pg
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 30000, statement_timeout: 60000 })
  await client.connect()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Cleanup Empty Movies (0 stream URLs)')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`)

  // Count total rows
  const totalRes = await client.query(`SELECT COUNT(*)::int c FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  console.log(`  Total URL rows: ${totalRes.rows[0].c.toLocaleString()}`)

  // Find mediaIds that have rows but ALL have empty/null streamUrl
  // OR mediaIds that somehow got inserted with 0 actual URLs
  // Actually, let's check for mediaIds where streamUrl is empty or null
  const emptyRes = await client.query(`
    SELECT "mediaId", COUNT(*) as cnt
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
      AND ("streamUrl" IS NULL OR "streamUrl" = '' OR "streamUrl" = 'undefined')
    GROUP BY "mediaId"
  `)
  console.log(`  Media IDs with empty streamUrls: ${emptyRes.rows.length}`)

  // Also check for mediaIds where we have rows but the streamUrl
  // doesn't start with http (invalid URLs)
  const invalidRes = await client.query(`
    SELECT "mediaId", COUNT(*) as cnt
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
      AND ("streamUrl" NOT LIKE 'http%'
           OR "streamUrl" IS NULL
           OR "streamUrl" = '')
    GROUP BY "mediaId"
  `)
  console.log(`  Media IDs with invalid streamUrls: ${invalidRes.rows.length}`)

  if (invalidRes.rows.length === 0 && emptyRes.rows.length === 0) {
    // Check if there are mediaIds with very few URLs (like 0 after dedup)
    // Actually the "0 URLs" in the script output means the INSERT returned 0 rows
    // (ON CONFLICT DO NOTHING). This could mean:
    // 1. The URLs were already in DB (duplicates skipped)
    // 2. Or the streamUrls array was empty (no servers returned)

    // Let's check for mediaIds that have NO valid http URLs
    console.log('\n  Checking for mediaIds with no valid stream URLs...')

    // Get all mediaIds
    const allIds = await client.query(`
      SELECT DISTINCT "mediaId"
      FROM "ManualStreamUrl"
      WHERE "expiresAt" > NOW()
    `)

    // For each mediaId, check if it has at least 1 valid URL
    let emptyMediaIds = []
    for (const row of allIds.rows) {
      const check = await client.query(`
        SELECT COUNT(*)::int c
        FROM "ManualStreamUrl"
        WHERE "mediaId" = $1
          AND "expiresAt" > NOW()
          AND "streamUrl" LIKE 'http%'
      `, [row.mediaId])

      if (check.rows[0].c === 0) {
        emptyMediaIds.push(row.mediaId)
      }
    }

    console.log(`  Media IDs with 0 valid URLs: ${emptyMediaIds.length}`)

    if (emptyMediaIds.length === 0) {
      console.log('\n✅ All movies have valid stream URLs! Nothing to clean up.')
      await client.end()
      return
    }

    // Delete rows for these empty mediaIds
    if (DRY_RUN) {
      console.log(`\n🚫 DRY RUN — would delete ${emptyMediaIds.length} media IDs' rows`)
    } else {
      console.log(`\n🗑️  Deleting rows for ${emptyMediaIds.length} empty media IDs...`)

      let deleted = 0
      for (const mediaId of emptyMediaIds) {
        const res = await client.query(`DELETE FROM "ManualStreamUrl" WHERE "mediaId" = $1`, [mediaId])
        deleted += res.rowCount || 0
      }

      console.log(`   ✅ Deleted ${deleted} rows`)
    }
  } else {
    // Delete rows with empty/invalid streamUrls
    const badIds = new Set([
      ...emptyRes.rows.map(r => r.mediaId),
      ...invalidRes.rows.map(r => r.mediaId),
    ])

    console.log(`\n  Total unique bad media IDs: ${badIds.size}`)

    if (DRY_RUN) {
      console.log(`🚫 DRY RUN — would delete rows for ${badIds.size} media IDs`)
    } else {
      console.log(`\n🗑️  Deleting invalid rows...`)
      let deleted = 0
      for (const mediaId of badIds) {
        const res = await client.query(`DELETE FROM "ManualStreamUrl" WHERE "mediaId" = $1 AND ("streamUrl" IS NULL OR "streamUrl" = '' OR "streamUrl" NOT LIKE 'http%')`, [mediaId])
        deleted += res.rowCount || 0
      }
      console.log(`   ✅ Deleted ${deleted} invalid rows`)
    }
  }

  // Final count
  const finalRes = await client.query(`SELECT COUNT(*)::int c FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  console.log(`\n  Final URL count: ${finalRes.rows[0].c.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
