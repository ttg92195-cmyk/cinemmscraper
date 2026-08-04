/**
 * Import movies from moviesmm.com — FAST MODE (no name search).
 *
 * KEY DISCOVERY: moviesmm.com's movieSources action works with BOTH:
 *   - cinemm.com bigint IDs (1963177111485498)
 *   - moviesmm.com sequential IDs (24603)
 *
 * This means we DON'T need to search by name! Just use the catalog ID
 * directly with movieSources. This is:
 *   - 2x faster (skip search API call)
 *   - Finds movies we DON'T have (sequential IDs are different from cinemm IDs)
 *   - No name matching issues
 *
 * HOW IT WORKS:
 *   1. Fetch catalog pages from moviesmm.com (random start page)
 *   2. For each item: call movieSources with the CATALOG ID (not cinemm ID)
 *   3. Resolve cinemm.com shortlinks to real stream URLs
 *   4. Store with catalog ID as mediaId
 *
 * NOTE: These movies will have mediaId = sequential ID (e.g. "24603").
 * Our website's cinemm.com search returns bigint IDs.
 * To display these movies, we need a "Browse" feature that fetches
 * from moviesmm.com catalog directly.
 *
 * Usage:
 *   node scripts/import-moviesmm-fast.mjs                # 100 movies
 *   node scripts/import-moviesmm-fast.mjs 500            # 500 movies
 *   node scripts/import-moviesmm-fast.mjs 100 --skip-file-size  # fast
 *   node scripts/import-moviesmm-fast.mjs series 50      # 50 series
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

async function fetchCatalog(type, page, pageSize = 60) {
  const r = await fetch(`${MOVIESMM_URL}/api/catalog?type=${type}&page=${page}&pageSize=${pageSize}`, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function fetchMovieSources(id) {
  const r = await fetch(`${MOVIESMM_URL}/api/cinemm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'movieSources', args: [id, true] }),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
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
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10)

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Import from moviesmm.com — FAST MODE (no name search)')
  console.log('  Uses catalog ID directly with movieSources!')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Type:         ${type}`)
  console.log(`  Limit:        ${limit} new movies`)
  console.log(`  Concurrency:  ${CONCURRENCY}`)
  console.log(`  File sizes:   ${skipFileSize ? 'SKIPPED' : 'Fetched'}\n`)

  let pg
  try { pg = await import('pg') } catch { console.error('❌ npm install pg'); process.exit(1) }

  const { Client } = pg
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 30000, statement_timeout: 60000 })
  client.on('error', e => console.error('⚠️  PG:', e.message))
  await client.connect()

  // Get existing IDs
  const ex = await client.query(`SELECT DISTINCT "mediaId" FROM "ManualStreamUrl" WHERE "mediaType"=$1 AND "expiresAt">NOW()`, [type])
  const existingIds = new Set(ex.rows.map(r => r.mediaId))
  console.log(`   Already in DB: ${existingIds.size.toLocaleString()} ${type}s`)

  // Fetch catalog from random page
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
    await sleep(300)
  }
  const items = allItems
  console.log(`   Collected ${items.length} items\n`)

  let processed = 0, skipped = 0, stored = 0, failed = 0, found = 0, nextIdx = 0

  async function processOne(item) {
    try {
      const mediaId = String(item.id)
      if (existingIds.has(mediaId)) return { status: 'skip' }

      const sources = await fetchMovieSources(item.id)
      if (!sources.ok || sources.access !== 'direct') return { status: 'skip' }
      const servers = sources.servers || []
      if (!servers.length) return { status: 'skip' }

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
          fileSize: s.size || 'N/A', // moviesmm.com already provides size!
        }
      }))
      const urls = results.filter(Boolean)
      if (!urls.length) return { status: 'skip' }

      // Use size from moviesmm.com if available (skip HEAD requests!)
      if (!skipFileSize) {
        await Promise.all(urls.map(async (u) => {
          if (u.fileSize === 'N/A') u.fileSize = await fetchFileSize(u.streamUrl)
        }))
      }

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
      return { status: 'ok', count: res.rowCount || 0, mediaId }
    } catch (e) { return { status: 'error', error: e.message } }
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
        console.log(`   [${found}/${limit}] ✅ ${item.name} → ${r.count} URLs (w${wid})`)
      } else if (r.status === 'skip') skipped++
      else { failed++; if (failed <= 5) console.log(`   ❌ ${item.name}: ${r.error}`) }
      await sleep(DELAY_MS / CONCURRENCY)
    }
  }

  const workers = []
  for (let w = 1; w <= CONCURRENCY; w++) workers.push(worker(w))
  await Promise.all(workers)

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Checked:        ${processed}`)
  console.log(`  ✅ New movies:  ${found}`)
  console.log(`  ✅ URLs stored: ${stored}`)
  console.log(`  ⏭️ Skipped:     ${skipped}`)
  console.log(`  ❌ Failed:      ${failed}`)
  const fc = await client.query(`SELECT COUNT(*)::int c FROM "ManualStreamUrl" WHERE "expiresAt">NOW()`)
  console.log(`\n  Total URLs: ${fc.rows[0].c.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')
  await client.end()
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
