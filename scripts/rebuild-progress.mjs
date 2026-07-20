/**
 * Rebuild crawl-progress.json from Railway DB.
 *
 * When the local progress file is lost/corrupt, this script:
 *   1. Re-runs discovery phase (or uses cached discovery IDs if .bak exists)
 *   2. For each discovered ID, checks Railway DB if URLs are stored
 *   3. Marks IDs with stored URLs as "processed"
 *   4. Saves a new crawl-progress.json
 *
 * This is faster than re-crawling because:
 *   - No need to call cinemm.com's getMovieSources/getEpisodeSources
 *   - Just queries our own Railway DB
 *
 * Usage:
 *   node scripts/rebuild-progress.mjs              # both movies + series
 *   node scripts/rebuild-progress.mjs movie        # only movies
 *   node scripts/rebuild-progress.mjs series       # only series
 *
 * Optional env vars:
 *   RAILWAY_URL — default https://cinemmscraper-production.up.railway.app
 *   CRAWL_PROGRESS — default ./crawl-progress.json
 */

import fs from 'fs'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const PROGRESS_FILE = process.env.CRAWL_PROGRESS || './crawl-progress.json'
const DELAY_MS = 100 // 100ms between Railway API calls (be polite)

const CINEMM_ORIGIN = 'https://cinemm.com'
const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- cinemm.com search (for discovery) ----------
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
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) return []
  const text = await res.text()
  const parsed = parseRscLine1(text)
  return parsed?.results || parsed?.items || []
}

async function getSeriesEpisodeIds(seriesId) {
  // Get all episode IDs for a series (needed to check Railway for each)
  const res = await fetch(`${CINEMM_ORIGIN}/`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': ACTIONS.getSeriesDetails },
    body: JSON.stringify([Number(seriesId), true]),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) return []
  const text = await res.text()
  // Find JSON with seasons
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line.includes('"seasons"') || !line.includes('"ok"')) continue
    const firstBrace = line.indexOf('{')
    if (firstBrace < 0) continue
    let depth = 0
    let end = -1
    for (let i = firstBrace; i < line.length; i++) {
      if (line[i] === '{') depth++
      else if (line[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    try {
      const candidate = JSON.parse(line.substring(firstBrace, end + 1))
      if (candidate?.seasons) {
        const episodeIds = []
        for (const season of candidate.seasons) {
          for (const ep of season.episodes || []) {
            if (ep.id) episodeIds.push(String(ep.id))
          }
        }
        return episodeIds
      }
    } catch {}
  }
  return []
}

// ---------- Railway URL check ----------
async function getStoredUrlsFromRailway(mediaId, mediaType, episodeId) {
  const url = new URL(`${RAILWAY_URL}/api/manual-link`)
  url.searchParams.set('mediaId', String(mediaId))
  url.searchParams.set('mediaType', mediaType)
  if (episodeId) url.searchParams.set('episodeId', String(episodeId))
  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return 0
    const data = await res.json()
    return data.count || 0
  } catch {
    return 0
  }
}

// ---------- Discovery ----------
async function discoverIds(type) {
  console.log(`\n🔍 [${type}] Discovering IDs via single-char search...`)
  const known = new Set()
  const queries = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
  for (const q of queries) {
    try {
      const items = await searchCinemm(q, type)
      for (const item of items) {
        if (item.id) known.add(String(item.id))
      }
      process.stdout.write(`  "${q}" → ${items.length} results (total: ${known.size})\r`)
    } catch (e) {
      console.log(`  "${q}" → ERROR: ${e.message}`)
    }
    await sleep(500) // be polite to cinemm.com
  }
  console.log(`  ✓ [${type}] Discovered ${known.size} unique IDs`)
  return Array.from(known)
}

// ---------- Main ----------
async function main() {
  const onlyType = process.argv[2] // 'movie' | 'series' | undefined

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Rebuild crawl-progress.json from Railway DB')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Railway URL:    ${RAILWAY_URL}`)
  console.log(`  Progress file:  ${PROGRESS_FILE}`)
  console.log('')

  // Load existing progress if any (to preserve any cached names)
  let existing = { discoveredIds: { movie: [], series: [] }, processedIds: { movie: [], series: [] }, submittedCount: 0, failedCount: 0, seriesNames: {}, movieNames: {} }
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    existing = { ...existing, ...data }
    console.log(`📂 Loaded existing progress: discovered ${existing.discoveredIds.movie.length + existing.discoveredIds.series.length} IDs`)
  } catch {
    console.log(`📂 No existing progress file — starting fresh`)
  }

  const types = onlyType ? [onlyType] : ['movie', 'series']
  let totalUrls = 0

  for (const type of types) {
    // Step 1: Discover IDs (or use existing)
    let discoveredIds = existing.discoveredIds?.[type] || []
    if (discoveredIds.length === 0) {
      discoveredIds = await discoverIds(type)
      existing.discoveredIds[type] = discoveredIds
    } else {
      console.log(`\n📚 [${type}] Using ${discoveredIds.length} cached discovered IDs`)
    }

    // Step 2: For each ID, check Railway for stored URLs
    console.log(`\n🔗 [${type}] Checking Railway DB for stored URLs...`)
    const processedIds = []
    let idx = 0
    for (const id of discoveredIds) {
      idx++
      let hasUrls = false

      if (type === 'movie') {
        // Movies: just check the top-level
        const count = await getStoredUrlsFromRailway(id, 'movie')
        if (count > 0) {
          hasUrls = true
          totalUrls += count
        }
      } else {
        // Series: check episode-level URLs
        // First, get episode IDs
        const episodeIds = await getSeriesEpisodeIds(id)
        for (const epId of episodeIds) {
          const count = await getStoredUrlsFromRailway(id, 'series', epId)
          if (count > 0) {
            hasUrls = true
            totalUrls += count
          }
          await sleep(DELAY_MS)
        }
      }

      if (hasUrls) {
        processedIds.push(id)
        process.stdout.write(`  [${idx}/${discoveredIds.length}] ${type} ${id} → ✅ has URLs\n`)
      } else {
        process.stdout.write(`  [${idx}/${discoveredIds.length}] ${type} ${id} → ⏳ no URLs yet\n`.replace('\n', '\r'))
      }

      if (type === 'movie') await sleep(DELAY_MS)

      // Save progress every 50 items (in case script crashes)
      if (idx % 50 === 0) {
        existing.processedIds[type] = processedIds.slice()
        existing.submittedCount = totalUrls
        try {
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(existing, null, 2))
        } catch {}
      }
    }

    existing.processedIds[type] = processedIds
    console.log(`  ✓ [${type}] ${processedIds.length}/${discoveredIds.length} IDs already have URLs on Railway`)
  }

  existing.submittedCount = totalUrls
  existing.lastRun = new Date().toISOString()

  // Atomic save
  try {
    const tmpPath = `${PROGRESS_FILE}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2))
    fs.renameSync(tmpPath, PROGRESS_FILE)
  } catch (e) {
    console.error(`⚠️  Failed to save: ${e.message}`)
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  ✅ REBUILD COMPLETE')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Movies:    ${existing.processedIds.movie.length}/${existing.discoveredIds.movie.length} processed`)
  console.log(`  Series:    ${existing.processedIds.series.length}/${existing.discoveredIds.series.length} processed`)
  console.log(`  URLs on Railway: ${totalUrls}`)
  console.log(`  Progress file:   ${PROGRESS_FILE}`)
  console.log('')
  console.log('  Next: run batch-crawl.mjs to continue processing the remaining items.')
  console.log('═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
