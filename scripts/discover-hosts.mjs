/**
 * Auto-discover new mirror hosts by re-checking cinemm.com.
 *
 * Bro's idea: instead of manually browsing cinemm.com for new hosts,
 * automatically check a sample of movies and detect any NEW hosts
 * that cinemm.com has started using.
 *
 * HOW IT WORKS:
 *   1. Pick N random movies from database that have existing URLs
 *   2. Call cinemm.com's getMovieSourcesAction for each
 *   3. Extract all unique hosts from the returned stream URLs
 *   4. Compare against known hosts (MIRROR_HOSTS + SOURCE_HOSTS)
 *   5. Report any NEW hosts found
 *   6. For each new host, test if it mirrors existing files (same /file/ path)
 *   7. If confirmed as mirror, add its URLs to database
 *
 * Usage:
 *   node scripts/discover-hosts.mjs                    # check 20 random movies
 *   node scripts/discover-hosts.mjs 50                 # check 50 random movies
 *   node scripts/discover-hosts.mjs 100 --auto-add     # auto-add new hosts
 *
 * Required: DATABASE_URL env var
 *
 * Bro's discovery timeline:
 *   Day 5:  md2.streammedia2.com, media.bioscopeapplication.com
 *   Day 8:  stream.cmapplication.site
 *   Day 9:  media.bs-sh.co
 *   Day N:  ??? (this script finds them automatically!)
 */

import fs from 'fs'

const CINEMM_ORIGIN = 'https://cinemm.com'
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL env var is required')
  process.exit(1)
}

// Known hosts — we already have these in our mirror generator
const KNOWN_HOSTS = new Set([
  'stream.cmreel.com',
  'stream.bioscopeapp.com',
  'bioscopeapp.com',
  'md2.streammedia2.com',
  'media.bioscopeapplication.com',
  'stream.cmapplication.site',
  'media.bs-sh.co',
  // cmdrive hosts (pattern, not exact)
])

// Source hosts — URLs from these are used to generate mirrors
const SOURCE_HOSTS = [
  'stream.cmreel.com',
  'stream.bioscopeapp.com',
]

const ACTIONS = {
  getMovieSources: '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
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

const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || '2000', 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Check if host is a known cmdrive host (pattern match)
function isKnownCmdriveHost(host) {
  return /^cmapp.*\.cmdrive\.xyz$/i.test(host)
}

// Check if host is known (exact match or cmdrive pattern)
function isKnownHost(host) {
  if (KNOWN_HOSTS.has(host)) return true
  if (isKnownCmdriveHost(host)) return true
  return false
}

// Parse RSC response line 1
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

async function callAction(actionId, args) {
  const res = await fetch(`${CINEMM_ORIGIN}/`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const text = await res.text()
  return parseRscLine1(text)
}

async function getMovieSources(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  try {
    return await callAction(ACTIONS.getMovieSources, [numericId])
  } catch {
    return null
  }
}

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

async function main() {
  const sampleSize = parseInt(process.argv[2] || '20', 10)
  const autoAdd = process.argv.includes('--auto-add')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mirror Host Auto-Discovery (Bro\'s idea)')
  console.log('  Scans cinemm.com for NEW mirror hosts automatically')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Sample size:    ${sampleSize} movies`)
  console.log(`  Auto-add:       ${autoAdd ? 'YES (will insert new host URLs)' : 'NO (report only)'}`)
  console.log(`  Known hosts:    ${KNOWN_HOSTS.size} + cmdrive pattern\n`)

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
  })
  client.on('error', (err) => console.error('⚠️  Postgres error:', err.message))

  await client.connect()

  // Step 1: Get random movies from database that have existing URLs
  console.log('📥 Selecting random movies from database...\n')
  const result = await client.query(`
    SELECT DISTINCT "mediaId"
    FROM "ManualStreamUrl"
    WHERE "mediaType" = 'movie'
      AND "episodeId" IS NULL
      AND "expiresAt" > NOW()
    ORDER BY RANDOM()
    LIMIT $1
  `, [sampleSize])

  const movieIds = result.rows.map((r) => r.mediaId)
  console.log(`   Selected ${movieIds.length} random movies\n`)

  if (movieIds.length === 0) {
    console.log('❌ No movies with URLs found in database.')
    await client.end()
    return
  }

  // Step 2: Call cinemm.com getMovieSources for each movie
  // Collect all unique hosts found
  const newHosts = new Map() // host → [{ movieId, url, fileName, quality }]
  const allHostsFound = new Set()
  let checked = 0
  let withUrls = 0
  let accessDirect = 0
  let accessTelegram = 0
  let accessUndefined = 0

  console.log(`🔍 Checking cinemm.com for ${movieIds.length} movies...\n`)

  for (let i = 0; i < movieIds.length; i++) {
    const movieId = movieIds[i]
    process.stdout.write(`\r   [${i + 1}/${movieIds.length}] Checking movie ${movieId}...`)

    const sources = await getMovieSources(movieId)
    checked++

    if (!sources) {
      accessUndefined++
      await sleep(DELAY_MS)
      continue
    }

    if (sources.access === 'direct') accessDirect++
    else if (sources.access === 'telegram') accessTelegram++
    else accessUndefined++

    const servers = sources.servers || []
    if (servers.length === 0) {
      await sleep(DELAY_MS)
      continue
    }

    withUrls++

    // Extract all unique hosts from this movie's URLs
    for (const server of servers) {
      const url = server.playUrl || server.url
      if (!url || !url.startsWith('http')) continue

      const host = parseHost(url)
      if (!host) continue

      allHostsFound.add(host)

      // Check if this is a NEW host we don't know about
      if (!isKnownHost(host)) {
        if (!newHosts.has(host)) {
          newHosts.set(host, [])
        }
        newHosts.get(host).push({
          movieId,
          url,
          fileName: parseFileName(url),
          quality: parseQuality(url),
          host,
        })
      }
    }

    await sleep(DELAY_MS)
  }

  console.log('\n')
  console.log('═══════════════════════════════════════════════════════')
  console.log('  📊 SCAN RESULTS')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Movies checked:      ${checked}`)
  console.log(`  Movies with URLs:    ${withUrls}`)
  console.log(`  access="direct":     ${accessDirect}`)
  console.log(`  access="telegram":   ${accessTelegram}`)
  console.log(`  access=undefined:    ${accessUndefined}`)
  console.log(`\n  All hosts found:      ${allHostsFound.size}`)
  console.log(`  Known hosts:         ${[...allHostsFound].filter(h => isKnownHost(h)).length}`)
  console.log(`  🆕 NEW hosts found:  ${newHosts.size}\n`)

  if (newHosts.size === 0) {
    console.log('✅ No new hosts found. cinemm.com is still using the same hosts.\n')
    console.log('💡 Try again later — cinemm.com may add new hosts when they upload new content.')
    console.log('   Run with larger sample: node scripts/discover-hosts.mjs 100\n')
    await client.end()
    return
  }

  // Step 3: Show new hosts found
  console.log('🆕 NEW MIRROR HOSTS DETECTED:\n')
  for (const [host, entries] of newHosts) {
    console.log(`  📦 ${host}`)
    console.log(`     Found in ${entries.length} movie(s):`)
    entries.slice(0, 3).forEach((e, i) => {
      console.log(`       [${i + 1}] movie ${e.movieId} | ${e.quality} | ${e.fileName.slice(0, 50)}`)
    })
    if (entries.length > 3) {
      console.log(`       ... and ${entries.length - 3} more`)
    }
    console.log('')
  }

  // Step 4: Test if new hosts are mirrors (same /file/ path pattern)
  console.log('🧪 Testing if new hosts mirror existing files...\n')

  const confirmedMirrors = [] // { host, testedUrl, contentLength, matchedOriginalUrl }

  for (const [host, entries] of newHosts) {
    // Take first entry and try to construct URL from a known source host
    const entry = entries[0]
    const url = entry.url

    // Check if URL has /file/ path
    const fileIdx = url.indexOf('/file/')
    if (fileIdx === -1) {
      console.log(`  ⚠️  ${host}: URL doesn't have /file/ path — may not be a mirror`)
      continue
    }

    // Test the new host URL directly
    const test = await testUrl(url)
    if (test.ok && test.status === 200) {
      console.log(`  ✅ ${host}: HTTP 200, size: ${test.contentLength ? formatBytes(test.contentLength) : 'N/A'}`)

      // Now find the same file on a known source host to verify it's a mirror
      const path = url.substring(fileIdx + 6)
      for (const sourceHost of SOURCE_HOSTS) {
        const sourceUrl = `https://${sourceHost}/file/${path}`
        const sourceTest = await testUrl(sourceUrl)
        if (sourceTest.ok && sourceTest.contentLength === test.contentLength) {
          console.log(`     ✅ Mirror confirmed! Same file on ${sourceHost} (${formatBytes(sourceTest.contentLength)})`)
          confirmedMirrors.push({
            host,
            testedUrl: url,
            contentLength: test.contentLength,
            matchedOriginalUrl: sourceUrl,
          })
          break
        }
      }
    } else {
      console.log(`  ❌ ${host}: HTTP ${test.status || 'failed'}`)
    }
  }

  console.log('')

  // Step 5: Summary
  console.log('═══════════════════════════════════════════════════════')
  console.log('  📊 DISCOVERY SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  New hosts detected:     ${newHosts.size}`)
  console.log(`  Confirmed as mirrors:   ${confirmedMirrors.length}`)

  if (confirmedMirrors.length > 0) {
    console.log('\n  ✅ CONFIRMED NEW MIRROR HOSTS:\n')
    confirmedMirrors.forEach((m) => {
      console.log(`     ${m.host}`)
      console.log(`       Sample URL: ${m.testedUrl.slice(0, 80)}...`)
      console.log(`       File size:  ${formatBytes(m.contentLength)}`)
      console.log('')
    })

    if (autoAdd) {
      console.log('  💾 Auto-adding new mirror URLs to database...\n')

      // For each confirmed mirror host, generate mirror URLs from all source-host URLs
      const farFuture = '9999-12-31T23:59:59.000Z'
      let totalInserted = 0

      for (const mirror of confirmedMirrors) {
        // Get all source-host URLs from database
        const sourceResult = await client.query(`
          SELECT "mediaId", "mediaType", "episodeId", "streamUrl", "quality", "format", "fileName"
          FROM "ManualStreamUrl"
          WHERE "expiresAt" > NOW()
            AND (
              "streamUrl" LIKE '%stream.cmreel.com/file/%'
              OR "streamUrl" LIKE '%stream.bioscopeapp.com/file/%'
            )
          ORDER BY "createdAt" ASC
        `)

        console.log(`     ${mirror.host}: ${sourceResult.rows.length} source URLs to mirror`)

        // Deduplicate by streamUrl (only 1 per unique URL)
        const seenUrls = new Set()
        const uniqueRows = []
        for (const row of sourceResult.rows) {
          if (seenUrls.has(row.streamUrl)) continue
          seenUrls.add(row.streamUrl)
          uniqueRows.push(row)
        }

        // Generate mirror URLs
        const mirrorCandidates = []
        for (const row of uniqueRows) {
          const fileIdx = row.streamUrl.indexOf('/file/')
          if (fileIdx === -1) continue
          const path = row.streamUrl.substring(fileIdx + 6)
          const mirrorUrl = `https://${mirror.host}/file/${path}`
          mirrorCandidates.push({ row, mirrorUrl })
        }

        // Test mirrors in parallel (batch of 20)
        console.log(`     Testing ${mirrorCandidates.length} mirror URLs...`)
        const workingMirrors = []
        const CONCURRENCY = 20
        let nextIdx = 0
        let testedCount = 0

        async function worker() {
          while (true) {
            const i = nextIdx++
            if (i >= mirrorCandidates.length) return
            const candidate = mirrorCandidates[i]
            const test = await testUrl(candidate.mirrorUrl)
            testedCount++
            if (test.ok && test.status === 200) {
              workingMirrors.push({
                ...candidate,
                contentLength: test.contentLength,
              })
            }
            if (testedCount % 500 === 0) {
              console.log(`       Progress: ${testedCount}/${mirrorCandidates.length} tested, ${workingMirrors.length} working`)
            }
          }
        }

        const workers = []
        for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
        await Promise.all(workers)

        console.log(`       ✅ Working: ${workingMirrors.length}`)

        // Batch insert
        const BATCH = 200
        for (let i = 0; i < workingMirrors.length; i += BATCH) {
          const batch = workingMirrors.slice(i, i + BATCH)
          const valuePlaceholders = []
          const params = []
          let paramIdx = 1
          for (const m of batch) {
            let fileSize = 'N/A'
            if (m.contentLength) fileSize = formatBytes(m.contentLength)

            valuePlaceholders.push(
              `(gen_random_uuid()::text, $${paramIdx}, $${paramIdx + 1}, NULL, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, NOW(), $${paramIdx + 9})`,
            )
            params.push(
              m.row.mediaId,
              m.row.mediaType,
              m.mirrorUrl,
              m.mirrorUrl,
              m.row.quality,
              m.row.format,
              mirror.host,
              m.row.fileName,
              fileSize,
              farFuture,
            )
            paramIdx += 10
          }

          try {
            const sql = `INSERT INTO "ManualStreamUrl" ("id", "mediaId", "mediaType", "episodeId", "shortlink", "streamUrl", "quality", "format", "host", "fileName", "fileSize", "createdAt", "expiresAt") VALUES ${valuePlaceholders.join(', ')} ON CONFLICT DO NOTHING`
            const res = await client.query(sql, params)
            totalInserted += res.rowCount || 0
          } catch (e) {
            console.error(`       ❌ Insert error: ${e.message}`)
          }
        }

        console.log(`       💾 Inserted: ${totalInserted} URLs\n`)
      }

      console.log(`  ✅ Total new mirror URLs inserted: ${totalInserted}\n`)
    } else {
      console.log('💡 To auto-add these mirror URLs, run with --auto-add flag:')
      console.log(`   node scripts/discover-hosts.mjs ${sampleSize} --auto-add\n`)
      console.log('Or manually add the host to scripts/generate-mirrors.mjs MIRROR_HOSTS array')
      console.log('and run generate-mirrors.mjs to add all mirror URLs.\n')
    }
  } else {
    console.log('\n⚠️  New hosts found but none confirmed as mirrors.')
    console.log('   They may use a different URL structure (not /file/ path).\n')
  }

  // Final count
  const finalCount = await client.query(`SELECT COUNT(*)::int as count FROM "ManualStreamUrl" WHERE "expiresAt" > NOW()`)
  console.log(`  Total URLs in database: ${finalCount.rows[0].count.toLocaleString()}`)
  console.log('\n═══════════════════════════════════════════════════════')

  await client.end()
}

main().catch((e) => {
  console.error('❌ FATAL:', e.message)
  process.exit(1)
})
