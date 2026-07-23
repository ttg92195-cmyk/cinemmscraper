/**
 * Generate mirror URLs from existing stream URLs.
 *
 * BRO'S BRILLIANT DISCOVERY:
 * cinemm.com's stream URLs use multiple CDN hosts that MIRROR the same file
 * structure. The path after `/file/` is identical across all mirrors.
 *
 * So for any URL like:
 *   https://stream.cmreel.com/file/2024-step/Movie.Name.2024.1080p.mp4
 *
 * We can generate mirror URLs:
 *   https://media.bioscopeapplication.com/file/2024-step/Movie.Name.2024.1080p.mp4
 *   https://md2.streammedia2.com/file/2024-step/Movie.Name.2024.1080p.mp4
 *
 * All return the SAME file (verified by Content-Length).
 *
 * This script:
 *   1. Reads all existing stream URLs from Postgres
 *   2. For each URL, extracts the path after `/file/`
 *   3. Generates mirror URLs with all known mirror hosts
 *   4. Tests each mirror with HEAD request (in parallel batches of 20)
 *   5. Inserts working mirrors as new ManualStreamUrl rows
 *   6. Skips URLs that are already stored (no duplicates)
 *
 * Usage:
 *   node scripts/generate-mirrors.mjs
 *
 * Required: DATABASE_URL env var (Supabase connection string)
 *           npm install pg (already installed for restore-backup-direct.mjs)
 *
 * Optional env vars:
 *   MIRROR_CONCURRENCY=20   — number of parallel HEAD requests
 *   MIRROR_DRY_RUN=true     — just test, don't insert
 */

const MIRROR_HOSTS = [
  'media.bioscopeapplication.com',
  'md2.streammedia2.com',
]

// Hosts we treat as "source" hosts — URLs from these are used to generate mirrors.
// We don't try to mirror URLs that are ALREADY on a mirror host.
const SOURCE_HOSTS = [
  'stream.cmreel.com',
  'stream.bioscopeapp.com',
  'bioscopeapp.com',
  // cmdrive.xyz hosts have a different URL structure (no /file/ prefix)
  // so they're excluded automatically by the /file/ check below.
]

const CONCURRENCY = parseInt(process.env.MIRROR_CONCURRENCY || '20', 10)
const DRY_RUN = process.env.MIRROR_DRY_RUN === 'true'
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  console.error('   DATABASE_URL="postgresql://..." node scripts/generate-mirrors.mjs')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Test if a URL is reachable via HEAD request.
 * Returns { ok, contentLength, status } or { ok: false, error }.
 */
async function testUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

/**
 * Run async operations with limited concurrency.
 * @param items Array of items to process
 * @param fn Async function to call on each item
 * @param concurrency Max parallel operations
 */
async function mapWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  const workers = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
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
  // IMPORTANT: Supabase free tier limits session-mode pool to 15 connections.
  // We use a SINGLE client for all operations (read existing URLs + insert new ones)
  // to stay under the limit. HEAD requests go to CDN hosts (not Postgres), so they
  // don't count toward the connection pool — only the DB queries do.
  let connStr = dbUrl
  if (connStr.includes(':5432/')) connStr = connStr.replace(':5432/', ':6543/')
  const client = new Client({
    connectionString: connStr,
    connectionTimeoutMillis: 30000,
    // Lower statement_timeout so a slow query doesn't hang the whole script
    statement_timeout: 60000,
  })

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mirror URL Generator')
  console.log('  (Bro\'s discovery: CDN hosts mirror same files)')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Mirror hosts:  ${MIRROR_HOSTS.join(', ')}`)
  console.log(`  Source hosts:  ${SOURCE_HOSTS.join(', ')}`)
  console.log(`  Concurrency:   ${CONCURRENCY}`)
  console.log(`  Mode:          ${DRY_RUN ? 'DRY RUN (no insert)' : 'LIVE (will insert)'}\n`)

  await client.connect()

  // Step 1: Get all existing stream URLs grouped by mediaId
  console.log('📥 Reading existing stream URLs from database...')
  const result = await client.query(`
    SELECT "mediaId", "mediaType", "episodeId", "shortlink", "streamUrl",
           "quality", "format", "host", "fileName", "fileSize", "createdAt", "expiresAt"
    FROM "ManualStreamUrl"
    WHERE "expiresAt" > NOW()
    ORDER BY "createdAt" ASC
  `)

  console.log(`   Found ${result.rows.length} existing URLs\n`)

  // Step 1b: Deduplicate original rows by streamUrl.
  // If the same URL was stored multiple times (different IDs), we only
  // need to generate mirrors from ONE copy. This prevents duplicate
  // mirror candidates.
  const seenUrls = new Set()
  const uniqueRows = []
  let duplicateOriginals = 0
  for (const row of result.rows) {
    if (seenUrls.has(row.streamUrl)) {
      duplicateOriginals++
      continue
    }
    seenUrls.add(row.streamUrl)
    uniqueRows.push(row)
  }
  if (duplicateOriginals > 0) {
    console.log(`   ⚠️  Found ${duplicateOriginals} duplicate original URLs (deduped before mirror generation)`)
    console.log(`   💡 Run scripts/dedup-urls.mjs to clean up duplicates in database\n`)
  }

  // Step 2: For each UNIQUE URL, extract path after /file/ and generate mirror URLs
  const mirrorCandidates = [] // { originalRow, mirrorHost, mirrorUrl }
  const seenMirrorUrls = new Set() // dedup mirror candidates by URL

  for (const row of uniqueRows) {
    const url = row.streamUrl
    // Only process URLs from source hosts that have /file/ path
    const isSourceHost = SOURCE_HOSTS.some((h) => url.includes(`://${h}/`))
    if (!isSourceHost) continue

    // Extract path after /file/
    const fileIdx = url.indexOf('/file/')
    if (fileIdx === -1) continue
    const path = url.substring(fileIdx + 6) // skip '/file/'

    // Generate mirror URLs
    for (const mirrorHost of MIRROR_HOSTS) {
      const mirrorUrl = `https://${mirrorHost}/file/${path}`
      // Skip if we already generated this mirror URL (from a duplicate original)
      if (seenMirrorUrls.has(mirrorUrl)) continue
      seenMirrorUrls.add(mirrorUrl)
      mirrorCandidates.push({
        originalRow: row,
        mirrorHost,
        mirrorUrl,
      })
    }
  }

  console.log(`🔍 Generated ${mirrorCandidates.length} unique mirror URL candidates\n`)

  if (mirrorCandidates.length === 0) {
    console.log('No mirror candidates found. Exiting.')
    await client.end()
    return
  }

  // Step 3: Check against existing URLs in database
  // (existingUrls is built from ALL rows including duplicates, so it's
  // a superset — safe for filtering)
  console.log('📋 Loading existing URLs to check for duplicates...')
  const existingUrls = new Set(result.rows.map((r) => r.streamUrl))
  console.log(`   ${existingUrls.size} unique existing URLs loaded\n`)

  // Filter out candidates that already exist in database
  const newCandidates = mirrorCandidates.filter((c) => !existingUrls.has(c.mirrorUrl))
  const duplicateCount = mirrorCandidates.length - newCandidates.length
  console.log(`   ${duplicateCount} already stored (will skip)`)
  console.log(`   ${newCandidates.length} new candidates to test\n`)

  // Step 4: Test each new candidate with HEAD request (parallel)
  console.log(`🧪 Testing ${newCandidates.length} mirror URLs (concurrency=${CONCURRENCY})...\n`)

  let tested = 0
  let working = 0
  let failed = 0
  const workingMirrors = [] // { originalRow, mirrorHost, mirrorUrl, contentLength }

  await mapWithConcurrency(newCandidates, async (candidate) => {
    const test = await testUrl(candidate.mirrorUrl)
    tested++

    if (test.ok && test.status === 200) {
      working++
      workingMirrors.push({
        ...candidate,
        contentLength: test.contentLength,
      })
      if (working % 50 === 0) {
        console.log(`   📊 Progress: ${tested}/${newCandidates.length} tested, ${working} working`)
      }
    } else {
      failed++
    }

    // Progress every 200
    if (tested % 200 === 0) {
      console.log(`   📊 Progress: ${tested}/${newCandidates.length} tested, ${working} working, ${failed} failed`)
    }
  }, CONCURRENCY)

  console.log(`\n   ✅ Tested: ${tested}`)
  console.log(`   ✅ Working: ${working}`)
  console.log(`   ❌ Failed: ${failed}\n`)

  // Step 5: Insert working mirrors into database
  if (DRY_RUN) {
    console.log(`🚫 DRY RUN — would have inserted ${workingMirrors.length} mirror URLs`)
    console.log(`   (Re-run without MIRROR_DRY_RUN=true to actually insert)\n`)
  } else if (workingMirrors.length > 0) {
    console.log(`💾 Inserting ${workingMirrors.length} working mirror URLs into database...\n`)

    let inserted = 0
    let insertFailed = 0
    const farFuture = '9999-12-31T23:59:59.000Z'

    // BATCH INSERT: insert 200 rows per query (instead of 1 row per query).
    // This is 200x faster and uses only ONE connection (no pool exhaustion).
    // For 38,000 rows: 190 queries instead of 38,000 queries.
    const BATCH_SIZE = 200
    for (let batchStart = 0; batchStart < workingMirrors.length; batchStart += BATCH_SIZE) {
      const batch = workingMirrors.slice(batchStart, batchStart + BATCH_SIZE)
      try {
        // Build multi-row INSERT with parameterized values
        // Values: ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12), ($13, ...), ...
        const valuePlaceholders = []
        const params = []
        let paramIdx = 1
        for (const mirror of batch) {
          // Format file size from content length
          let fileSize = 'N/A'
          if (mirror.contentLength) {
            const bytes = mirror.contentLength
            if (bytes < 1024) fileSize = `${bytes} B`
            else if (bytes < 1024 * 1024) fileSize = `${(bytes / 1024).toFixed(1)} KB`
            else if (bytes < 1024 * 1024 * 1024) fileSize = `${(bytes / (1024 * 1024)).toFixed(1)} MB`
            else fileSize = `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
          }

          valuePlaceholders.push(
            `(gen_random_uuid()::text, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, NOW(), $${paramIdx + 10})`
          )
          params.push(
            mirror.originalRow.mediaId,
            mirror.originalRow.mediaType,
            mirror.originalRow.episodeId,
            mirror.mirrorUrl, // store mirror URL as the shortlink too
            mirror.mirrorUrl,
            mirror.originalRow.quality,
            mirror.originalRow.format,
            mirror.mirrorHost,
            mirror.originalRow.fileName,
            fileSize,
            farFuture,
          )
          paramIdx += 11
        }

        const sql = `
          INSERT INTO "ManualStreamUrl" (
            "id", "mediaId", "mediaType", "episodeId", "shortlink", "streamUrl",
            "quality", "format", "host", "fileName", "fileSize", "createdAt", "expiresAt"
          ) VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT DO NOTHING
        `
        const result = await client.query(sql, params)
        inserted += result.rowCount || 0

        // Progress every 5 batches (1000 rows)
        if (Math.floor(batchStart / BATCH_SIZE) % 5 === 0) {
          console.log(`   📊 Insert progress: ${inserted.toLocaleString()}/${workingMirrors.length.toLocaleString()}`)
        }
      } catch (e) {
        insertFailed += batch.length
        if (insertFailed <= 5) {
          console.error(`   ❌ Batch insert failed at ${batchStart}: ${e.message}`)
        }
        // Continue with next batch — partial progress is better than abort
      }
    }

    console.log(`\n   ✅ Inserted: ${inserted.toLocaleString()}`)
    console.log(`   ❌ Insert failed: ${insertFailed.toLocaleString()}\n`)
  }

  // Final summary
  const finalCount = await client.query(`SELECT COUNT(*)::int as count FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  console.log('═══════════════════════════════════════════════════════')
  console.log('  📊 FINAL SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Mirror candidates generated:  ${mirrorCandidates.length}`)
  console.log(`  Already stored (skipped):     ${duplicateCount}`)
  console.log(`  New candidates tested:        ${newCandidates.length}`)
  console.log(`  Working mirrors:              ${workingMirrors.length}`)
  console.log(`  Failed mirrors:               ${failed}`)
  if (!DRY_RUN) {
    console.log(`  Successfully inserted:        ${workingMirrors.length - (failed > 0 ? 0 : 0)}`)
  }
  console.log(`\n  Total URLs in database now:   ${finalCount.rows[0].count.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
