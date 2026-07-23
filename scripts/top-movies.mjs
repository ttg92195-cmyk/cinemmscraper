/**
 * Show top movies/series with the most stream URLs stored.
 *
 * Usage:
 *   node scripts/top-movies.mjs                # top 20 movies by URL count
 *   node scripts/top-movies.mjs series         # top 20 series
 *   node scripts/top-movies.mjs movie 50       # top 50 movies
 *
 * Connects DIRECTLY to Postgres (bypasses Vercel 10s timeout) —
 * same pattern as restore-backup-direct.mjs.
 *
 * Requires: pg package (npm install pg)
 */

const dbUrl = process.env.DATABASE_URL
const type = process.argv[2] || 'movie'
const limit = parseInt(process.argv[3] || '20', 10)

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  console.error('   Set it to your Supabase connection string:')
  console.error('   DATABASE_URL="postgresql://..." node scripts/top-movies.mjs')
  process.exit(1)
}

if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
  console.error('❌ DATABASE_URL must be a postgresql:// connection string')
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
    connectionTimeoutMillis: 15000,
  })

  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Top ${limit} ${type}s by stream URL count`)
  console.log('═══════════════════════════════════════════════════════\n')

  await client.connect()

  // Query: GROUP BY mediaId, count URLs, order by count DESC
  // For series (mediaType='series'), only count top-level URLs (episodeId IS NULL)
  // For movies, all URLs have episodeId IS NULL anyway
  const result = await client.query(`
    SELECT
      "mediaId",
      COUNT(*)::int as url_count,
      MAX("fileName") as sample_filename,
      MAX("host") as sample_host,
      MAX("quality") as sample_quality
    FROM "ManualStreamUrl"
    WHERE "mediaType" = $1
      AND "episodeId" IS NULL
      AND "expiresAt" > NOW()
    GROUP BY "mediaId"
    ORDER BY url_count DESC
    LIMIT $2
  `, [type, limit])

  console.log(`  Rank | Media ID           | URLs | Sample File`)
  console.log('  ─────┼────────────────────┼──────┼─────────────────────────────────────')

  result.rows.forEach((row, i) => {
    const rank = String(i + 1).padStart(4)
    const mediaId = String(row.mediaId).padStart(18)
    const urls = String(row.url_count).padStart(4)
    const file = (row.sample_filename || '').slice(0, 50)
    console.log(`  ${rank} | ${mediaId} | ${urls} | ${file}`)
  })

  // Summary stats
  const totalResult = await client.query(`
    SELECT COUNT(DISTINCT "mediaId")::int as unique_media,
           COUNT(*)::int as total_urls
    FROM "ManualStreamUrl"
    WHERE "mediaType" = $1
      AND "expiresAt" > NOW()
  `, [type])

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  📊 ${type.toUpperCase()} Summary`)
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Total ${type}s with URLs:  ${totalResult.rows[0].unique_media.toLocaleString()}`)
  console.log(`  Total URLs:               ${totalResult.rows[0].total_urls.toLocaleString()}`)
  console.log(`  Average URLs per ${type}: ${(totalResult.rows[0].total_urls / totalResult.rows[0].unique_media).toFixed(1)}`)
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch((e) => {
  console.error('❌ Error:', e.message)
  process.exit(1)
})
