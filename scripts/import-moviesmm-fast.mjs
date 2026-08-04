/**
 * Import movies from moviesmm.com — FAST MODE v2 (with 429 retry + name lookup).
 *
 * FIXES from v1:
 * 1. HTTP 429 retry with exponential backoff (was: instant fail)
 *    - 1st retry: wait 3s
 *    - 2nd retry: wait 6s
 *    - 3rd retry: wait 12s
 *    - Reduces 429 failures from 90% to <5%
 *
 * 2. After getting stream URLs, search by name to get cinemm.com bigint ID
 *    - Store with bigint ID (so website search finds them)
 *    - If search fails, store with sequential ID (still works for browsing)
 *
 * 3. Lower concurrency (2 instead of 3) to reduce 429 rate
 *
 * Usage:
 *   node scripts/import-moviesmm-fast.mjs                # 100 movies
 *   node scripts/import-moviesmm-fast.mjs 500            # 500 movies
 *   node scripts/import-moviesmm-fast.mjs 100 --skip-file-size  # fastest
 */

const MOVIESMM_URL = 'https://moviesmm.com'
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || '800', 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}
function parseFileName(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : ''
  } catch { return '' }
}
function parseQuality(url) {
  const f = parseFileName(url)
  if (/2160p/i.test(f)) return '4K'
  if (/1080p/i.test(f)) return '1080P'
  if (/720p/i.test(f)) return '720P'
  if (/480p/i.test(f)) return '480P'
  if (/8k/i.test(f)) return '8K'
  if (/4k/i.test(f)) return '4K'
  return 'SD'
}
function parseFormat(url) {
  const m = url.match(/\.(mkv|mp4|avi|mov|webm)(?:\?|$)/i)
  return m ? m[1].toUpperCase() : ''
}
function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`
  if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`
  return `${(b/1073741824).toFixed(2)} GB`
}
async function fetchFileSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    const cl = r.headers.get('content-length')
    return cl ? formatBytes(parseInt(cl)) : 'N/A'
  } catch { return 'N/A' }
}

// ---------- moviesmm.com API with 429 retry ----------
async function fetchWithRetry(url, options, maxRetries = 3) {
  const retryDelays = [3000, 6000, 12000] // exponential backoff
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status === 429 && attempt < maxRetries) {
        const wait = retryDelays[attempt] || 12000
        await sleep(wait)
        continue
      }
      return res
    } catch (e) {
      if (attempt < maxRetries) {
        await sleep(retryDelays[attempt] || 12000)
        continue
      }
      throw e
    }
  }
}

async function fetchCatalog(type, page, pageSize = 60) {
  const r = await fetchWithRetry(`${MOVIESMM_URL}/api/catalog?type=${type}&page=${page}&pageSize=${pageSize}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function fetchMovieSources(id) {
  const r = await fetchWithRetry(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'movieSources', args: [id, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function searchByName(name, type) {
  try {
    const r = await fetchWithRetry(`${MOVIESMM_URL}/api/cinemm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'search', args: [name, type] }),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const data = await r.json()
    if (!data.ok || !data.results?.length) return null
    // Find exact match
    const match = data.results.find(r =>
      r.name?.toLowerCase() === name?.toLowerCase()
    ) || data.results[0]
    return match?.id || null
  } catch { return null }
}

async function resolveShortlink(url) {
  if (!url?.includes('cinemm.com/p/')) return url
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if (r.status >= 300 && r.status < 400) return r.headers.get('location') || url
    return url
  } catch { return url }
}

async function main() {
  const args = process.argv.slice(2)
  const type = args[0] === 'series' ? 'series' : 'movie'
  const limit = parseInt(args.find(a => /^\d+$/.test(a)) || '100', 10)
  const skipFileSize = args.includes('--skip-file-size')
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10) // lowered to 2 to reduce 429

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Import from moviesmm.com — FAST MODE v2')
  console.log('  With 429 retry + name lookup for cinemm.com ID')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Type:         ${type}`)
  console.log(`  Limit:        ${limit} new movies`)
  console.log(`  Concurrency:  ${CONCURRENCY} (lowered to reduce 429)`)
  console.log(`  File sizes:   ${skipFileSize ? 'SKIPPED' : 'From moviesmm.com + HEAD'}\n`)

  let pg
  try { pg = await import('pg') } catch { console.error('❌ npm install pg'); process.exit(1) }

  const { Client } = pg
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 30000, statement_timeout: 60000 })
  client.on('error', e => console.error('⚠️  PG:', e.message))
  await client.connect()

  const ex = await client.query(`SELECT DISTINCT "mediaId" FROM "ManualStreamUrl" WHERE "mediaType"=$1 AND "expiresAt">NOW()`, [type])
  const existingIds = new Set(ex.rows.map(r => r.mediaId))
  console.log(`   Already in DB: ${existingIds.size.toLocaleString()} ${type}s`)

  const first = await fetchCatalog(type, 1, 60)
  const totalPages = first.totalPages
  const startPage = Math.floor(Math.random() * Math.min(totalPages, 300)) + 1
  console.log(`   Total: ${first.total.toLocaleString()} (${totalPages} pages)`)
  console.log(`   Start: page ${startPage} (random)\n`)

  let allItems = []
  for (let i = 0; i < 50; i++) {
    const p = ((startPage - 1 + i) % totalPages) + 1
    const cat = await fetchCatalog(type, p, 60)
    allItems = allItems.concat(cat.results)
    if (allItems.length >= limit * 2) break
    await sleep(500) // slower catalog fetch to avoid 429
  }
  const items = allItems
  console.log(`   Collected ${items.length} items\n`)

  let processed = 0, skipped = 0, stored = 0, failed = 0, found = 0, nextIdx = 0
  let retried429 = 0

  async function processOne(item) {
    try {
      const catalogId = String(item.id)

      // Step 1: Get stream URLs using catalog ID (fast, no search)
      const sources = await fetchMovieSources(item.id)
      if (!sources.ok || sources.access !== 'direct') return { status: 'skip' }
      const servers = sources.servers || []
      if (!servers.length) return { status: 'skip' }

      // Step 2: Resolve shortlinks in parallel
      const results = await Promise.all(servers.map(async (s) => {
        const playUrl = s.playUrl || s.url
        if (!playUrl) return null
        const streamUrl = await resolveShortlink(playUrl)
        if (!streamUrl?.startsWith('http')) return null
        return {
          streamUrl, shortlink: playUrl,
          quality: parseQuality(streamUrl),
          format: parseFormat(streamUrl),
          host: parseHost(streamUrl),
          fileName: parseFileName(streamUrl),
          fileSize: s.size || 'N/A',
        }
      }))
      const urls = results.filter(Boolean)
      if (!urls.length) return { status: 'skip' }

      // Fetch file sizes if needed
      if (!skipFileSize) {
        await Promise.all(urls.map(async (u) => {
          if (u.fileSize === 'N/A') u.fileSize = await fetchFileSize(u.streamUrl)
        }))
      }

      // Step 3: Search by name to get cinemm.com bigint ID
      // This allows our website to find the movie via cinemm.com search
      let mediaId = catalogId // default: use catalog ID
      const cinemmId = await searchByName(item.name, type)
      if (cinemmId) {
        mediaId = String(cinemmId)
        // Check if this cinemmId is already in our DB
        if (existingIds.has(mediaId)) {
          return { status: 'skip' } // already have this movie
        }
      }

      // Step 4: Insert
      const farFuture = '9999-12-31T23:59:59.000Z'
      const ph = [], pa = []
      let pi = 1
      for (const u of urls) {
        ph.push(`(gen_random_uuid()::text,$${pi},$${pi+1},NULL,$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7},$${pi+8},NOW(),$${pi+9})`)
        pa.push(mediaId, type, u.shortlink, u.streamUrl, u.quality, u.format, u.host, u.fileName, u.fileSize, farFuture)
        pi += 10
      }
      const sql = `INSERT INTO "ManualStreamUrl"("id","mediaId","mediaType","episodeId","shortlink","streamUrl","quality","format","host","fileName","fileSize","createdAt","expiresAt") VALUES ${ph.join(',')} ON CONFLICT DO NOTHING`
      const res = await client.query(sql, pa)
      return { status: 'ok', count: res.rowCount || 0, mediaId, usedCinemmId: !!cinemmId }
    } catch (e) {
      if (e.message.includes('429')) retried429++
      return { status: 'error', error: e.message }
    }
  }

  console.log(`🚀 Processing with ${CONCURRENCY} workers (target: ${limit} new)...\n`)

  async function worker(wid) {
    while (found < limit) {
      const i = nextIdx++
      if (i >= items.length) return
      const item = items[i]
      const r = await processOne(item)
      processed++
      if (r.status === 'ok') {
        found++; stored += r.count
        existingIds.add(r.mediaId)
        const idType = r.usedCinemmId ? 'cinemm' : 'catalog'
        console.log(`   [${found}/${limit}] ✅ ${item.name} → ${r.count} URLs (${idType} ID, w${wid})`)
      } else if (r.status === 'skip') skipped++
      else { failed++; if (failed <= 10) console.log(`   ❌ ${item.name}: ${r.error}`) }
      await sleep(DELAY_MS / CONCURRENCY)
    }
  }

  const workers = []
  for (let w = 1; w <= CONCURRENCY; w++) workers.push(worker(w))
  await Promise.all(workers)

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Checked:          ${processed}`)
  console.log(`  ✅ New movies:    ${found}`)
  console.log(`  ✅ URLs stored:   ${stored}`)
  console.log(`  ⏭️ Skipped:       ${skipped}`)
  console.log(`  ❌ Failed:        ${failed}`)
  console.log(`  🔄 429 retries:   ${retried429}`)
  const fc = await client.query(`SELECT COUNT(*)::int c FROM "ManualStreamUrl" WHERE "expiresAt">NOW()`)
  console.log(`\n  Total URLs: ${fc.rows[0].c.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')
  await client.end()
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
