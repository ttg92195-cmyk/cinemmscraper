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
 * SPEED OPTIONS:
 *   - Concurrency: 3 movies processed in parallel (default)
 *   - --skip-file-size: skip HEAD requests for file sizes (3x faster!)
 *   - Shortlinks resolved in parallel within each movie
 *
 * Usage:
 *   node scripts/import-from-moviesmm.mjs                    # import 20 movies
 *   node scripts/import-from-moviesmm.mjs 100                # import 100 movies
 *   node scripts/import-from-moviesmm.mjs 500                # import 500 movies
 *   node scripts/import-from-moviesmm.mjs 100 --skip-file-size  # fast mode!
 *   node scripts/import-from-moviesmm.mjs series 50          # import 50 series
 *   node scripts/import-from-moviesmm.mjs 20 --dry-run       # test only
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
  const res = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'movieSources', args: [cinemmId, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`movieSources HTTP ${res.status}`)
  return res.json()
}

// ---------- Resolve cinemm.com shortlink ----------
async function resolveShortlink(shortlinkUrl) {
  if (!shortlinkUrl || !shortlinkUrl.includes('cinemm.com/p/')) {
    return shortlinkUrl
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
  const skipFileSize = args.includes('--skip-file-size')
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10)

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Import from moviesmm.com (Bro\'s golden discovery)')
  console.log('  No Myanmar IP needed — moviesmm.com proxies cinemm.com!')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Type:         ${type}`)
  console.log(`  Limit:        ${limit}`)
  console.log(`  Concurrency:  ${CONCURRENCY} (parallel movies)`)
  console.log(`  File sizes:   ${skipFileSize ? 'SKIPPED (N/A — 3x faster!)' : 'Fetched via HEAD'}`)
  console.log(`  Mode:         ${dryRun ? 'DRY RUN' : 'LIVE'}\n`)

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

  // Step 1: Fetch catalog — keep fetching pages until we have enough NEW movies
  console.log(`📥 Fetching ${type} catalog from moviesmm.com...\n`)
  const pageSize = 60

  // Get existing IDs FIRST so we can skip known movies
  const existingResult = await client.query(
    `SELECT DISTINCT "mediaId" FROM "ManualStreamUrl" WHERE "mediaType" = $1 AND "expiresAt" > NOW()`,
    [type],
  )
  const existingIds = new Set(existingResult.rows.map(r => r.mediaId))
  console.log(`   Already in our DB: ${existingIds.size.toLocaleString()} ${type}s`)

  // Fetch pages until we have enough NEW items (not in our DB)
  // Strategy: fetch pages, filter out items whose name matches existing entries
  // We can't check by cinemmId yet (that requires a search call), so we filter
  // by checking if the poster URL is already in our DB (poster is unique per movie)
  const existingPosters = new Set()
  const posterResult = await client.query(
    `SELECT DISTINCT "shortlink" FROM "ManualStreamUrl" WHERE "mediaType" = $1 AND "expiresAt" > NOW() AND "shortlink" LIKE '%cinemm.com%'`,
    [type],
  )
  // Also get all stream URLs to check host+path
  const urlResult = await client.query(
    `SELECT "streamUrl" FROM "ManualStreamUrl" WHERE "mediaType" = $1 AND "expiresAt" > NOW()`,
    [type],
  )
  const existingUrlPaths = new Set()
  for (const row of urlResult.rows) {
    try {
      const u = new URL(row.streamUrl)
      // Store just the pathname (without host) for matching
      existingUrlPaths.add(u.pathname)
    } catch {}
  }

  let allItems = []
  let totalPages = 0
  let maxPages = 20 // safety limit: don't fetch more than 20 pages (1200 items)
  let totalAvailable = 0

  for (let p = 1; p <= maxPages; p++) {
    const cat = await fetchCatalog(type, p, pageSize)
    totalPages = p
    if (p === 1) {
      totalAvailable = cat.total
      console.log(`   Total ${type}s available: ${cat.total.toLocaleString()}`)
    }

    // For each catalog item, we can't know the cinemmId without a search call.
    // But we CAN check if the poster URL path is already in our DB.
    // Catalog items use sequential IDs — if we've seen items with similar names
    // before, they're likely already imported.
    //
    // Simpler approach: just collect ALL items, and let the worker skip them
    // after searching (the search returns cinemmId which we check against existingIds).
    allItems = allItems.concat(cat.results)

    // Check if we have enough items (accounting for ~30% skip rate)
    if (allItems.length >= limit * 2) {
      console.log(`   Fetched ${allItems.length} items from ${p} page(s) — enough to find ${limit} new ones`)
      break
    }

    if (p < maxPages) await sleep(300)
  }

  // Filter: remove items whose name exactly matches an existing movie name
  // (quick pre-filter to reduce search API calls)
  // We'll also do the real check (cinemmId) in the worker.
  const existingNames = new Set()
  // We don't store movie names in ManualStreamUrl, so we can't pre-filter by name.
  // The worker will search → get cinemmId → check existingIds.

  const items = allItems.slice(0, Math.min(allItems.length, limit * 3)) // fetch 3x to account for skips
  console.log(`   Collected ${items.length} items from ${totalPages} page(s)`)
  console.log(`   (Will process until ${limit} new ones are found)\n`)

  let processed = 0
  let skipped = 0
  let totalUrlsStored = 0
  let failed = 0
  let newMoviesFound = 0
  let nextIndex = 0

  // ---------- Process one movie ----------
  async function processOneMovie(item) {
    try {
      // Search for cinemm.com ID
      const searchRes = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', args: [item.name, type] }),
        signal: AbortSignal.timeout(15000),
      })
      const searchData = await searchRes.json()
      if (!searchData.ok || !searchData.results?.length) return { status: 'skip' }

      const match = searchData.results.find(r =>
        r.name?.toLowerCase() === item.name?.toLowerCase()
      ) || searchData.results[0]
      const cinemmId = match.id

      if (existingIds.has(String(cinemmId))) return { status: 'skip' }

      // NEW movie! Fetch sources
      const sources = await fetchMovieSources(cinemmId)
      if (!sources.ok || sources.access !== 'direct') return { status: 'skip' }

      const servers = sources.servers || []
      if (!servers.length) return { status: 'skip' }

      // Resolve shortlinks IN PARALLEL
      const resolveResults = await Promise.all(
        servers.map(async (server) => {
          const playUrl = server.playUrl || server.url
          if (!playUrl) return null
          const streamUrl = await resolveShortlink(playUrl)
          if (!streamUrl?.startsWith('http')) return null
          return {
            streamUrl, shortlink: playUrl,
            quality: parseQuality(streamUrl),
            format: parseFormat(streamUrl),
            host: parseHost(streamUrl),
            fileName: parseFileName(streamUrl),
            fileSize: 'N/A',
          }
        })
      )
      const streamUrls = resolveResults.filter(Boolean)
      if (!streamUrls.length) return { status: 'skip' }

      // File sizes (optional)
      if (!skipFileSize) {
        await Promise.all(streamUrls.map(async (u) => {
          u.fileSize = await fetchFileSize(u.streamUrl)
        }))
      }

      // Insert
      if (!dryRun) {
        const farFuture = '9999-12-31T23:59:59.000Z'
        const placeholders = []
        const params = []
        let pi = 1
        for (const u of streamUrls) {
          placeholders.push(
            `(gen_random_uuid()::text,$${pi},$${pi+1},NULL,$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7},$${pi+8},NOW(),$${pi+9})`
          )
          params.push(String(cinemmId), type, u.shortlink, u.streamUrl,
            u.quality, u.format, u.host, u.fileName, u.fileSize, farFuture)
          pi += 10
        }
        const sql = `INSERT INTO "ManualStreamUrl"("id","mediaId","mediaType","episodeId","shortlink","streamUrl","quality","format","host","fileName","fileSize","createdAt","expiresAt") VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`
        const result = await client.query(sql, params)
        return { status: 'ok', urls: result.rowCount || 0, name: item.name, cinemmId }
      }
      return { status: 'ok', urls: streamUrls.length, name: item.name, cinemmId }
    } catch (e) {
      return { status: 'error', error: e.message, name: item.name }
    }
  }

  // ---------- Concurrent workers ----------
  // Process items until we find `limit` NEW movies
  console.log(`🚀 Processing items with ${CONCURRENCY} workers (target: ${limit} new ${type}s)...\n`)

  async function worker(wid) {
    while (true) {
      // Stop if we've found enough new movies
      if (newMoviesFound >= limit) return
      const i = nextIndex++
      if (i >= items.length) return
      const item = items[i]

      const r = await processOneMovie(item)
      processed++

      if (r.status === 'ok') {
        newMoviesFound++
        totalUrlsStored += r.urls
        existingIds.add(String(r.cinemmId)) // prevent re-processing
        console.log(`   [${newMoviesFound}/${limit}] ✅ ${item.name} → ${r.urls} URLs (w${wid})`)
      } else if (r.status === 'skip') {
        skipped++
      } else {
        failed++
        if (failed <= 10) console.log(`   ❌ ${item.name}: ${r.error}`)
      }
      await sleep(DELAY_MS / CONCURRENCY)
    }
  }

  const workers = []
  for (let w = 1; w <= CONCURRENCY; w++) workers.push(worker(w))
  await Promise.all(workers)

  // Summary
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Items checked:     ${processed}`)
  console.log(`  ✅ New ${type}s:    ${newMoviesFound}`)
  console.log(`  ✅ URLs stored:    ${totalUrlsStored}`)
  console.log(`  ⏭️ Skipped (old):  ${skipped}`)
  console.log(`  ❌ Failed:         ${failed}`)
  const fc = await client.query(`SELECT COUNT(*)::int c FROM "ManualStreamUrl" WHERE "expiresAt">NOW()`)
  console.log(`\n  Total URLs: ${fc.rows[0].c.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')
  await client.end()
}

main().catch(e => { console.error('❌ FATAL:', e.message); process.exit(1) })
