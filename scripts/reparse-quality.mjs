/**
 * Re-parse quality from URL for ALL existing rows.
 *
 * PROBLEM:
 * The old parseQuality() function used regex /(8K|4K|2160p|1080p|720p|480p)/i
 * which matched "4K" FIRST. This caused bugs:
 *   - URL ".../1080p SDR.../file.mkv" → quality="4K" (WRONG, should be 1080P)
 *   - URL ".../720p.../file.mp4"      → quality="4K" (WRONG, should be 720P)
 *   - URL ".../4k-movies/.../1080p file.mkv" → quality="4K" (WRONG)
 *
 * The bug happened because "4K" appeared in the URL path and was matched
 * before the actual quality in the filename.
 *
 * FIX:
 *   1. Re-parse quality from streamUrl for ALL rows using the new regex
 *      /(2160p|1080p|720p|480p|8K|4K)/i (resolution-specific first)
 *   2. Normalize 2160P → 4K (same resolution, 4K is more common label)
 *   3. Default to 'SD' if no match (was 'STD' before)
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/reparse-quality.mjs
 *
 * Output:
 *   - Counts how many rows will change
 *   - Updates all rows in batches
 *   - Shows before/after quality distribution
 */

const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

/**
 * NEW parseQuality — parse from FILENAME only, not full URL.
 * The URL path may contain "4k" in folder names (e.g. "/4k-movies/"),
 * which causes false matches. We extract the filename and check there.
 */
function parseQuality(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const fileName = decodeURIComponent(parts[parts.length - 1] || '')
    if (/2160p/i.test(fileName)) return '4K'
    if (/1080p/i.test(fileName)) return '1080P'
    if (/720p/i.test(fileName)) return '720P'
    if (/480p/i.test(fileName)) return '480P'
    if (/8k/i.test(fileName)) return '8K'
    if (/4k/i.test(fileName)) return '4K'
  } catch {}
  return 'SD'
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
  // Use transaction pooler (port 6543) to avoid session pool exhaustion
  let connStr = dbUrl
  if (connStr.includes(':5432/')) {
    connStr = connStr.replace(':5432/', ':6543/')
  }
  const client = new Client({
    connectionString: connStr,
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  })

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Quality Re-parser (fix 4K mislabeling bug)')
  console.log('═══════════════════════════════════════════════════════\n')

  await client.connect()

  // Step 1: Load all rows (id, streamUrl, current quality)
  console.log('📥 Loading all stream URLs...\n')
  const result = await client.query(`
    SELECT "id", "streamUrl", "quality"
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
    ORDER BY "createdAt" ASC
  `)
  const rows = result.rows
  console.log(`   Loaded ${rows.length.toLocaleString()} rows\n`)

  // Step 2: Compute new quality for each row, find which ones change
  const changes = [] // { id, oldQuality, newQuality }
  for (const row of rows) {
    const newQuality = parseQuality(row.streamUrl)
    if (newQuality !== row.quality) {
      changes.push({
        id: row.id,
        oldQuality: row.quality,
        newQuality,
      })
    }
  }

  console.log(`📊 Quality changes needed: ${changes.length.toLocaleString()} rows\n`)

  if (changes.length === 0) {
    console.log('✅ All qualities are already correct!\n')
    await client.end()
    return
  }

  // Show sample of changes (first 10)
  console.log('   Sample changes:')
  changes.slice(0, 10).forEach((c) => {
    console.log(`   ${c.oldQuality.padEnd(6)} → ${c.newQuality.padEnd(6)} (id: ${c.id.slice(0, 8)}...)`)
  })
  if (changes.length > 10) {
    console.log(`   ... and ${changes.length - 10} more`)
  }
  console.log('')

  // Step 3: Group changes by (oldQuality, newQuality) for batch updates
  // This is much faster than updating one row at a time.
  const changeGroups = new Map() // key: "old→new", value: { ids, oldQ, newQ }
  for (const c of changes) {
    const key = `${c.oldQuality}→${c.newQuality}`
    if (!changeGroups.has(key)) {
      changeGroups.set(key, { oldQ: c.oldQuality, newQ: c.newQuality, ids: [] })
    }
    changeGroups.get(key).ids.push(c.id)
  }

  console.log(`🔧 Updating in ${changeGroups.size} groups (batch per quality change)...\n`)

  let totalUpdated = 0
  for (const [key, group] of changeGroups) {
    // Update in batches of 500 ids (avoid query length limits)
    const BATCH = 500
    for (let i = 0; i < group.ids.length; i += BATCH) {
      const batchIds = group.ids.slice(i, i + BATCH)
      const placeholders = batchIds.map((_, idx) => `$${idx + 2}`).join(',')
      const res = await client.query(
        `UPDATE "ManualStreamUrl" SET "quality" = $1 WHERE "id" IN (${placeholders})`,
        [group.newQ, ...batchIds],
      )
      totalUpdated += res.rowCount || 0
    }
    console.log(`   ${group.oldQ.padEnd(6)} → ${group.newQ.padEnd(6)} : ${group.ids.length.toLocaleString()} rows`)
  }

  console.log(`\n   ✅ Total updated: ${totalUpdated.toLocaleString()} rows\n`)

  // Step 4: Show new quality distribution
  const distResult = await client.query(`
    SELECT "quality", COUNT(*)::int as count
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
    GROUP BY "quality"
    ORDER BY count DESC
  `)

  console.log('📊 Quality distribution after re-parse:\n')
  distResult.rows.forEach((r) => {
    console.log(`   ${r.quality.padEnd(8)} → ${r.count.toLocaleString()} URLs`)
  })

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  ✅ Done! All qualities re-parsed correctly.')
  console.log('═══════════════════════════════════════════════════════\n')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
