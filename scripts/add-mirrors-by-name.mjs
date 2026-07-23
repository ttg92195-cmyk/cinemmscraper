/**
 * Add mirror URLs to a specific movie/series by name.
 *
 * Bro's brilliant idea: instead of crawling cinemm.com (slow + IP block risk),
 * just add mirror URLs to an existing movie using its already-stored URLs.
 *
 * HOW IT WORKS:
 *   1. Search cinemm.com for the movie name (1 API call)
 *   2. Check if the movie already has stream URLs in our database
 *   3. If yes: generate mirror URLs from existing source-host URLs
 *      (md2.streammedia2.com + media.bioscopeapplication.com)
 *   4. Test each mirror with HEAD request (parallel)
 *   5. Insert working mirrors into database
 *   6. Skip cinemm.com getMovieSources call entirely!
 *
 * USE CASES:
 *   - Movie already crawled but no mirror URLs yet
 *   - Quick mirror update without re-crawling
 *   - No IP block risk (no cinemm.com calls for sources)
 *
 * Usage:
 *   node scripts/add-mirrors-by-name.mjs movie "The Avengers"
 *   node scripts/add-mirrors-by-name.mjs series "Breaking Bad"
 *   node scripts/add-mirrors-by-name.mjs movie "Avengers" --all
 *
 * Required: DATABASE_URL env var (for direct Postgres access)
 *
 * Comparison with batch-by-name.mjs:
 *   batch-by-name.mjs:        cinemm.com → getMovieSources → store all URLs
 *   add-mirrors-by-name.mjs:  cinemm.com → search only → use existing URLs → add mirrors only
 *
 * Speed: ~10x faster (no getMovieSources call, no shortlink resolution)
 */

import fs from 'fs'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-rr48.vercel.app'
).replace(/\/+$/, '')

const CINEMM_ORIGIN = 'https://cinemm.com'
const dbUrl = process.env.DATABASE_URL

const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
}

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/x-component',
  'Content-Type': 'text/plain;charset=UTF-8',
  'Next-Router-State-Tree':
    '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  Referer: `${CINEMM_ORIGIN}/`,
  Origin: CINEMM_ORIGIN,
}

const MIRROR_HOSTS = [
  'media.bioscopeapplication.com',
  'md2.streammedia2.com',
]

// Hosts we treat as "source" hosts — URLs from these are used to generate mirrors
const SOURCE_HOSTS = [
  'stream.cmreel.com',
  'stream.bioscopeapp.com',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- RSC parser ----------
function parseRscLine1(text) {
  const markerStr = '1:{'
  let searchFrom = text.length
  while (true) {
    const pos = text.lastIndexOf(markerStr, searchFrom)
    if (pos < 0) return null
    const after = text.substring(pos + 2)
    const trimmed = after.trimEnd()
    if (trimmed.endsWith('}')) {
      try { return JSON.parse(trimmed) } catch {}
    }
    searchFrom = pos - 1
  }
}

async function searchCinemm(query, type) {
  const res = await fetch(`${CINEMM_ORIGIN}/`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': ACTIONS.search },
    body: JSON.stringify([query, type]),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) return []
  const text = await res.text()
  const parsed = parseRscLine1(text)
  return parsed?.results || parsed?.items || []
}

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

async function testUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(10000),
    })
    const contentLength = res.headers.get('content-length')
    return {
      ok: res.ok,
      status: res.status,
      contentLength: contentLength ? parseInt(contentLength, 10) : null,
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2)
  const type = args[0]
  let nameArg = ''
  let processAll = false
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--all') processAll = true
    else if (!nameArg) nameArg = args[i]
  }

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Add Mirror URLs by Name (Bro\'s fast method)')
  console.log('  No cinemm.com source crawling — uses existing URLs only')
  console.log('═══════════════════════════════════════════════════════\n')

  if (type !== 'movie' && type !== 'series') {
    console.log('Usage:')
    console.log('  node scripts/add-mirrors-by-name.mjs movie "The Avengers"')
    console.log('  node scripts/add-mirrors-by-name.mjs series "Breaking Bad"')
    console.log('  node scripts/add-mirrors-by-name.mjs movie "Avengers" --all')
    console.log('')
    console.log('Required: DATABASE_URL env var')
    console.log('')
    console.log('How it works:')
    console.log('  1. Search cinemm.com for the name (1 API call)')
    console.log('  2. Check existing URLs in database')
    console.log('  3. Generate mirror URLs from existing source-host URLs')
    console.log('  4. Test + insert working mirrors')
    console.log('  5. NO cinemm.com getMovieSources call (10x faster!)')
    process.exit(0)
  }

  if (!nameArg) {
    console.error(`❌ Missing name. Usage: node scripts/add-mirrors-by-name.mjs ${type} "Name"`)
    process.exit(1)
  }

  if (!dbUrl) {
    console.error('❌ DATABASE_URL env var is required')
    process.exit(1)
  }

  console.log(`  Type:        ${type}`)
  console.log(`  Search:      "${nameArg}"`)
  console.log(`  Mode:        ${processAll ? 'ALL matches' : 'FIRST match only'}`)
  console.log(`  Database:    ${dbUrl.replace(/:[^:@]+@/, ':***@').slice(0, 50)}...`)
  console.log(`  Mirror hosts: ${MIRROR_HOSTS.join(', ')}\n`)

  // Load pg for direct Postgres access
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
    statement_timeout: 60000,
    idle_in_transaction_session_timeout: 60000,
  })
  client.on('error', (err) => console.error('⚠️  Postgres error:', err.message))

  // Step 1: Search cinemm.com
  console.log(`🔍 Searching cinemm.com for "${nameArg}" (${type})...`)
  const items = await searchCinemm(nameArg, type)
  console.log(`   Found ${items.length} result(s):\n`)
  items.forEach((it, i) => {
    console.log(`   [${i + 1}] ID: ${it.id} | ${it.name || it.title || '(no name)'} (${it.year || '?'})`)
  })
  console.log('')

  if (items.length === 0) {
    console.log(`❌ No ${type} found matching "${nameArg}".`)
    process.exit(0)
  }

  const selected = processAll ? items : items.slice(0, 1)
  console.log(`🚀 Processing ${selected.length} ${type}(s)...\n`)

  await client.connect()

  let totalMirrorsAdded = 0
  let totalSkipped = 0

  for (let s = 0; s < selected.length; s++) {
    const item = selected[s]
    const mediaId = String(item.id)
    const name = item.name || item.title || '(unknown)'
    console.log(`━━━ [${s + 1}/${selected.length}] ${type} ${mediaId} — "${name}" (${item.year || '?'}) ━━━`)

    // Step 2: Get existing URLs from database
    const result = await client.query(
      `SELECT "streamUrl", "quality", "format", "host", "fileName"
       FROM "ManualStreamUrl"
       WHERE "mediaId" = $1 AND "mediaType" = $2 AND "episodeId" IS NULL
         AND "expiresAt" > NOW()`,
      [mediaId, type],
    )

    if (result.rows.length === 0) {
      console.log(`  ⚠️  No existing URLs in database. Run batch-by-name.mjs first to get original URLs.`)
      console.log(`     Command: node scripts/batch-by-name.mjs ${type} "${name}"\n`)
      continue
    }

    console.log(`  📦 Found ${result.rows.length} existing URLs`)

    // Step 3: Generate mirror candidates from source-host URLs
    const mirrorCandidates = []
    const seenMirrorUrls = new Set()

    for (const row of result.rows) {
      const url = row.streamUrl
      const isSourceHost = SOURCE_HOSTS.some((h) => url.includes(`://${h}/`))
      if (!isSourceHost) continue

      const fileIdx = url.indexOf('/file/')
      if (fileIdx === -1) continue
      const path = url.substring(fileIdx + 6)

      for (const mirrorHost of MIRROR_HOSTS) {
        const mirrorUrl = `https://${mirrorHost}/file/${path}`
        if (seenMirrorUrls.has(mirrorUrl)) continue
        seenMirrorUrls.add(mirrorUrl)
        mirrorCandidates.push({
          originalRow: row,
          mirrorHost,
          mirrorUrl,
        })
      }
    }

    if (mirrorCandidates.length === 0) {
      console.log(`  ⚠️  No source-host URLs found (need stream.cmreel.com or stream.bioscopeapp.com)`)
      console.log(`     Mirror generation only works on URLs with /file/ path from source hosts.\n`)
      continue
    }

    // Check which mirrors already exist
    const existingMirrorUrls = new Set(result.rows.map((r) => r.streamUrl))
    const newCandidates = mirrorCandidates.filter((c) => !existingMirrorUrls.has(c.mirrorUrl))
    const alreadyStored = mirrorCandidates.length - newCandidates.length

    console.log(`  🔍 Generated ${mirrorCandidates.length} mirror candidates`)
    console.log(`     ${alreadyStored} already stored (skipped)`)
    console.log(`     ${newCandidates.length} new candidates to test\n`)

    if (newCandidates.length === 0) {
      console.log(`  ✅ All mirrors already exist — nothing to add\n`)
      totalSkipped += mirrorCandidates.length
      continue
    }

    // Step 4: Test mirrors (parallel, concurrency 10)
    console.log(`  🧪 Testing ${newCandidates.length} mirrors...`)
    const CONCURRENCY = 10
    let tested = 0
    let working = 0
    let failed = 0
    const workingMirrors = []

    let nextIdx = 0
    async function worker() {
      while (true) {
        const i = nextIdx++
        if (i >= newCandidates.length) return
        const candidate = newCandidates[i]
        const test = await testUrl(candidate.mirrorUrl)
        tested++
        if (test.ok && test.status === 200) {
          working++
          workingMirrors.push({ ...candidate, contentLength: test.contentLength })
        } else {
          failed++
        }
      }
    }
    const workers = []
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
    await Promise.all(workers)

    console.log(`     ✅ Working: ${working}`)
    console.log(`     ❌ Failed: ${failed}\n`)

    if (workingMirrors.length === 0) {
      console.log(`  ⚠️  No working mirrors found\n`)
      continue
    }

    // Step 5: Insert working mirrors (batch insert)
    console.log(`  💾 Inserting ${workingMirrors.length} mirrors...`)
    const farFuture = '9999-12-31T23:59:59.000Z'
    let inserted = 0

    // Batch insert (200 per query)
    const BATCH = 200
    for (let i = 0; i < workingMirrors.length; i += BATCH) {
      const batch = workingMirrors.slice(i, i + BATCH)
      const valuePlaceholders = []
      const params = []
      let paramIdx = 1
      for (const mirror of batch) {
        let fileSize = 'N/A'
        if (mirror.contentLength) fileSize = formatBytes(mirror.contentLength)

        valuePlaceholders.push(
          `(gen_random_uuid()::text, $${paramIdx}, $${paramIdx + 1}, NULL, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, NOW(), $${paramIdx + 9})`,
        )
        params.push(
          mediaId,
          type,
          mirror.mirrorUrl,
          mirror.mirrorUrl,
          parseQuality(mirror.mirrorUrl),
          parseFormat(mirror.mirrorUrl),
          mirror.mirrorHost,
          parseFileName(mirror.mirrorUrl),
          fileSize,
          farFuture,
        )
        paramIdx += 10
      }

      try {
        const sql = `INSERT INTO "ManualStreamUrl" ("id", "mediaId", "mediaType", "episodeId", "shortlink", "streamUrl", "quality", "format", "host", "fileName", "fileSize", "createdAt", "expiresAt") VALUES ${valuePlaceholders.join(', ')} ON CONFLICT DO NOTHING`
        const res = await client.query(sql, params)
        inserted += res.rowCount || 0
      } catch (e) {
        console.error(`  ❌ Batch insert failed: ${e.message}`)
      }
    }

    console.log(`  ✅ Inserted: ${inserted} mirror URLs\n`)
    totalMirrorsAdded += inserted

    if (s < selected.length - 1) await sleep(500)
  }

  await client.end()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  ${type.toUpperCase()}s processed: ${selected.length}`)
  console.log(`  Mirror URLs added: ${totalMirrorsAdded}`)
  console.log(`  Already existed (skipped): ${totalSkipped}`)
  console.log(`\n🔍 Verify on the website:`)
  console.log(`   ${RAILWAY_URL}`)
  console.log('\n═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
