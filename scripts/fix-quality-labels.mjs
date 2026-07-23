/**
 * Fix quality labels in the database — rename "STD" to "SD".
 *
 * Bro noticed: some stream URLs show "STD" as quality, which looks like
 * a typo. The correct label is "SD" (Standard Definition).
 *
 * This script:
 *   1. Counts how many rows have quality = "STD"
 *   2. Updates them all to "SD" in a single query
 *   3. Reports the result
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/fix-quality-labels.mjs
 *
 * Also safe to re-run (idempotent — if no STD rows exist, does nothing).
 */

const dbUrl = process.env.DATABASE_URL

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
  const client = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 30000,
    statement_timeout: 60000,
  })

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Quality Label Fixer: STD → SD')
  console.log('═══════════════════════════════════════════════════════\n')

  await client.connect()

  // Step 1: Count STD rows
  const countResult = await client.query(`
    SELECT COUNT(*)::int as count
    FROM "ManualStreamUrl"
    WHERE "quality" = 'STD'
  `)
  const stdCount = countResult.rows[0].count

  console.log(`  Rows with quality = "STD": ${stdCount.toLocaleString()}\n`)

  if (stdCount === 0) {
    console.log('✅ No "STD" rows found — nothing to fix!\n')
    await client.end()
    return
  }

  // Step 2: Update STD → SD
  console.log(`🔧 Updating ${stdCount.toLocaleString()} rows: "STD" → "SD"...\n`)
  const updateResult = await client.query(`
    UPDATE "ManualStreamUrl"
    SET "quality" = 'SD'
    WHERE "quality" = 'STD'
  `)

  const updated = updateResult.rowCount || 0
  console.log(`   ✅ Updated: ${updated.toLocaleString()} rows\n`)

  // Step 3: Verify — show quality distribution
  const distResult = await client.query(`
    SELECT "quality", COUNT(*)::int as count
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
    GROUP BY "quality"
    ORDER BY count DESC
  `)

  console.log('📊 Quality distribution after fix:\n')
  distResult.rows.forEach((r) => {
    console.log(`   ${r.quality.padEnd(8)} → ${r.count.toLocaleString()} URLs`)
  })

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  ✅ Done! All "STD" labels are now "SD".')
  console.log('═══════════════════════════════════════════════════════\n')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
