/**
 * Import movies from moviesmm.com's catalog API.
 *
 * moviesmm.com has scraped ALL of cinemm.com's data into their own Postgres
 * database on a VPS. Their /api/catalog endpoint returns movies/series/shorts
 * with pagination — no auth needed, public API.
 *
 * This script:
 *   1. Fetches all pages from /api/catalog?type=movie
 *   2. For each movie, calls /api/cinemm with movieSources action
 *      (moviesmm.com proxies to cinemm.com server-side → access:"direct")
 *   3. Resolves cinemm.com shortlinks (playUrl) to real stream URLs
 *   4. Inserts into our Supabase database
 *
 * HUGE ADVANTAGE:
 *   - No Myanmar IP needed! moviesmm.com does the proxying
 *   - No cinemm.com API calls from our phone
 *   - No IP block risk
 *   - 23,368 movies available (we only have ~9,441 discovered)
 *
 * Usage:
 *   node scripts/import-from-moviesmm.mjs                    # import 20 movies
 *   node scripts/import-from-moviesmm.mjs 100                # import 100 movies
 *   node scripts/import-from-moviesmm.mjs 500                # import 500 movies
 *   node scripts/import-from-moviesmm.mjs series 50          # import 50 series
 *   node scripts/import-from-moviesmm.mjs movie 20 --dry-run # test only
 *
 * Required: DATABASE_URL env var
 */

const MOVIESMM_URL = 'https://moviesmm.com'
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || '1000', 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- URL helpers ----------
function parseHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function parseFileName(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    return last ? decodeURIComponent(last) : ''
  } catch { return '' }
}

function parseQuality(url) {
  const fileName = parseFileName(url)
  if (/2160p/i.test(fileName)) return '4K'
  if (/1080p/i.test(fileName)) return '1080P'
  if (/720p/i.test(fileName)) return '720P'
  if (/480p/i.test(fileName)) return '480P'
  if (/8k/i.test(fileName)) return '8K'
  if (/4k/i.test(fileName)) return '4K'
  return 'SD'
}

function parseFormat(url) {
  const m = url.match(/\.(mkv|mp4|avi|mov|webm)(?:\?|$)/i)
  return m ? m[1].toUpperCase() : ''
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function fetchFileSize(streamUrl) {
  try {
    const res = await fetch(streamUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
      signal: AbortSignal.timeout(10000),
    })
    const cl = res.headers.get('content-length')
    if (cl) return formatBytes(parseInt(cl, 10))
    return 'N/A'
  } catch { return 'N/A' }
}

// ---------- moviesmm.com API ----------
async function fetchCatalog(type, page, pageSize = 60) {
  const url = `${MOVIESMM_URL}/api/catalog?type=${type}&page=${page}&pageSize=${pageSize}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`)
  return res.json()
}

async function fetchMovieSources(cinemmId) {
  // moviesmm.com proxies this to cinemm.com server-side
  // Returns access:"direct" with real stream URLs!
  const res = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'movieSources', args: [cinemmId, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`movieSources HTTP ${res.status}`)
  return res.json()
}

async function fetchSeriesDetails(cinemmId) {
  const res = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seriesDetails', args: [cinemmId, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`seriesDetails HTTP ${res.status}`)
  return res.json()
}

async function fetchEpisodeSources(episodeId, seriesId) {
  const res = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'episodeSources', args: [episodeId, seriesId, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`episodeSources HTTP ${res.status}`)
  return res.json()
}

// ---------- Resolve cinemm.com shortlink ----------
async function resolveShortlink(shortlinkUrl) {
  if (!shortlinkUrl || !shortlinkUrl.includes('cinemm.com/p/')) {
    return shortlinkUrl // not a shortlink, return as-is
  }
  try {
    const res = await fetch(shortlinkUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (res.status >= 300 && res.status < 400) {
      return res.headers.get('location') || shortlinkUrl
    }
    return shortlinkUrl
  } catch {
    return shortlinkUrl
  }
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2)
  const type = args[0] === 'series' ? 'series' : 'movie'
  const limit = parseInt(args.find(a => /^\d+$/.test(a)) || '20', 10)
  const dryRun = args.includes('--dry-run')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Import from moviesmm.com (Bro\'s golden discovery)')
  console.log('  No Myanmar IP needed — moviesmm.com proxies cinemm.com!')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Type:        ${type}`)
  console.log(`  Limit:       ${limit}`)
  console.log(`  Mode:        ${dryRun ? 'DRY RUN (no insert)' : 'LIVE (will insert)'}\n`)

  let pg
  try { pg = await import('pg') } catch {
    console.error('❌ pg package not installed. Run: npm install pg')
    process.exit(1)
  }

  const { Client } = pg
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({
    connectionString: connStr,
    connectionTimeoutMillis: 30000,
    statement_timeout: 60000,
  })
  client.on('error', (err) => console.error('⚠️  Postgres error:', err.message))
  await client.connect()

  // Step 1: Fetch catalog to get movie list
  console.log(`📥 Fetching ${type} catalog from moviesmm.com...\n`)
  const catalog = await fetchCatalog(type, 1, 60)
  console.log(`   Total ${type}s available: ${catalog.total.toLocaleString()}`)
  console.log(`   Fetching first ${Math.min(limit, catalog.results.length)} items\n`)

  // Get existing mediaIds from our database to skip duplicates
  const existingResult = await client.query(
    `SELECT DISTINCT "mediaId" FROM "ManualStreamUrl" WHERE "mediaType" = $1 AND "expiresAt" > NOW()`,
    [type],
  )
  const existingIds = new Set(existingResult.rows.map(r => r.mediaId))
  console.log(`   Already in our database: ${existingIds.size.toLocaleString()} ${type}s\n`)

  let processed = 0
  let skipped = 0
  let totalUrlsStored = 0
  let failed = 0

  // Step 2: Process each movie
  for (const item of catalog.results) {
    if (processed >= limit) break

    // moviesmm.com catalog uses sequential IDs (24603), but search returns cinemm.com bigint IDs
    // We need to search for the movie name to get the cinemm.com ID
    // OR: we can use the catalog ID directly if movieSources accepts it

    // Try using the catalog item's name to search cinemm.com via moviesmm.com
    const mediaId = String(item.id)

    // Skip if already in our database (check by name match instead of ID)
    // Actually, let's just try fetching sources directly

    process.stdout.write(`\r   [${processed + 1}/${limit}] ${item.name} (${item.year})...`)

    try {
      // For movies: call movieSources
      // For series: call seriesDetails then episodeSources per episode
      if (type === 'movie') {
        // First, search to get the cinemm.com ID
        const searchRes = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'search', args: [item.name, 'movie'] }),
          signal: AbortSignal.timeout(15000),
        })
        const searchData = await searchRes.json()

        if (!searchData.ok || !searchData.results || searchData.results.length === 0) {
          skipped++
          processed++
          await sleep(DELAY_MS)
          continue
        }

        // Find exact match by name
        const match = searchData.results.find(r =>
          r.name.toLowerCase() === item.name.toLowerCase() &&
          (r.year === item.year || !item.year)
        ) || searchData.results[0]

        const cinemmId = match.id

        // Check if already in our DB by cinemmId
        if (existingIds.has(String(cinemmId))) {
          skipped++
          processed++
          await sleep(500)
          continue
        }

        // Fetch movie sources
        const sources = await fetchMovieSources(cinemmId)

        if (!sources.ok || sources.access !== 'direct') {
          skipped++
          processed++
          await sleep(DELAY_MS)
          continue
        }

        const servers = sources.servers || []
        if (servers.length === 0) {
          skipped++
          processed++
          await sleep(DELAY_MS)
          continue
        }

        // Resolve shortlinks and collect stream URLs
        const streamUrls = []
        for (const server of servers) {
          const playUrl = server.playUrl || server.url
          if (!playUrl) continue

          // Resolve cinemm.com shortlink
          const streamUrl = await resolveShortlink(playUrl)
          if (!streamUrl || !streamUrl.startsWith('http')) continue

          streamUrls.push({
            streamUrl,
            shortlink: playUrl,
            quality: parseQuality(streamUrl),
            format: parseFormat(streamUrl),
            host: parseHost(streamUrl),
            fileName: parseFileName(streamUrl),
            fileSize: 'N/A', // will fetch later
          })
        }

        if (streamUrls.length === 0) {
          skipped++
          processed++
          await sleep(DELAY_MS)
          continue
        }

        // Fetch file sizes in parallel
        await Promise.all(streamUrls.map(async (u) => {
          u.fileSize = await fetchFileSize(u.streamUrl)
        }))

        if (!dryRun) {
          // Batch insert
          const farFuture = '9999-12-31T23:59:59.000Z'
          const valuePlaceholders = []
          const params = []
          let paramIdx = 1

          for (const u of streamUrls) {
            valuePlaceholders.push(
              `(gen_random_uuid()::text, $${paramIdx}, $${paramIdx+1}, NULL, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8}, NOW(), $${paramIdx+9})`
            )
            params.push(
              String(cinemmId), type,
              u.shortlink, u.streamUrl,
              u.quality, u.format, u.host,
              u.fileName, u.fileSize, farFuture,
            )
            paramIdx += 10
          }

          const sql = `INSERT INTO "ManualStreamUrl" ("id","mediaId","mediaType","episodeId","shortlink","streamUrl","quality","format","host","fileName","fileSize","createdAt","expiresAt") VALUES ${valuePlaceholders.join(', ')} ON CONFLICT DO NOTHING`
          const result = await client.query(sql, params)
          totalUrlsStored += result.rowCount || 0
        } else {
          totalUrlsStored += streamUrls.length
        }

        processed++
        console.log(`\r   [${processed}/${limit}] ✅ ${item.name} → ${streamUrls.length} URLs stored`)
      }
    } catch (e) {
      failed++
      console.log(`\r   [${processed + 1}/${limit}] ❌ ${item.name}: ${e.message}`)
      processed++
    }

    await sleep(DELAY_MS)
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Processed:       ${processed}`)
  console.log(`  ✅ URLs stored:  ${totalUrlsStored}`)
  console.log(`  ⏭️ Skipped:      ${skipped}`)
  console.log(`  ❌ Failed:       ${failed}`)

  const finalCount = await client.query(`SELECT COUNT(*)::int as count FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  console.log(`\n  Total URLs in database: ${finalCount.rows[0].count.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
