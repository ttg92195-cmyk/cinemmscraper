#!/usr/bin/env node
/**
 * cinemm.com Crawler — runs on Termux (phone with Myanmar data IP)
 * =================================================================
 *
 * WHAT THIS DOES
 * --------------
 * 1. Searches cinemm.com alphabetically to discover all movie + series IDs.
 * 2. For each ID, calls getMovieSourcesAction / getEpisodeSourcesAction.
 *    Because the phone has a Myanmar IP, cinemm.com returns access:"direct"
 *    with real stream URLs (no Telegram redirect).
 * 3. Submits the stream URLs to the Railway server's /api/manual-link
 *    endpoint, which stores them permanently in SQLite.
 * 4. Saves progress to ./crawl-progress.json so we can resume after
 *    interruption (network drop, phone sleep, etc).
 *
 * After running this once, every user of cinemmscraper sees stream URLs
 * for every crawled movie — no proxy, no Telegram bot, no Myanmar IP
 * required on the server side.
 *
 * ONE-TIME SETUP (on Termux)
 * --------------------------
 *   pkg update && pkg upgrade -y
 *   pkg install nodejs git -y          # Node 18+ has built-in fetch
 *   git clone https://github.com/ttg92195-cmyk/cinemmscraper
 *   cd cinemmscraper
 *
 * RUN
 * ---
 *   node scripts/crawl-from-phone.mjs
 *
 * Optional env vars:
 *   RAILWAY_URL       Default: https://cinemmscraper-production.up.railway.app
 *   CRAWL_DELAY_MS    Default: 800     (delay between cinemm.com requests)
 *   CRAWL_PROGRESS    Default: ./crawl-progress.json
 *   CRAWL_TYPES       Default: movie,series  (comma-separated; can be just "movie")
 *   CRAWL_QUERY_MODE  Default: auto    (auto|single|double — see below)
 *
 * QUERY MODES
 * -----------
 *   single  → search "a","b",...,"9" (36 queries per type, ~1000 results)
 *   double  → search "aa","ab",...,"99" (1296 queries per type, ~20000 results)
 *   auto    → start with single, fall back to double for any letter that
 *             returned exactly 30 results (likely more exist)
 *
 * PROGRESS FILE FORMAT
 * --------------------
 *   {
 *     "discoveredIds": { "movie": [123, 456, ...], "series": [789, ...] },
 *     "processedIds":  { "movie": [123, ...],       "series": [789, ...] },
 *     "submittedCount": 1234,
 *     "failedCount": 12,
 *     "lastRun": "2026-07-19T10:30:00Z"
 *   }
 *
 * TROUBLESHOOTING
 * ---------------
 *   - "ECONNREFUSED" / "ETIMEDOUT" → phone lost data. Wait + re-run.
 *   - All movies return access:"telegram" → phone IP is NOT Myanmar.
 *     Switch to a Myanmar SIM / disable Wi-Fi / disable any VPN.
 *   - "FloodWait" / 429 → cinemm.com is rate-limiting. Increase
 *     CRAWL_DELAY_MS to 2000 and re-run.
 */

import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || '800', 10)
const PROGRESS_FILE = process.env.CRAWL_PROGRESS || './crawl-progress.json'
const TYPES = (process.env.CRAWL_TYPES || 'movie,series')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s === 'movie' || s === 'series')
const QUERY_MODE = process.env.CRAWL_QUERY_MODE || 'auto'

// cinemm.com Server Action IDs (from src/lib/cinemm.ts — updated 2026-07-15)
const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieSources: '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getEpisodeSources: '605765e4f6aa5ce95c001ef982ddc2a6ac62c60930',
}

const CINEMM_ORIGIN = 'https://cinemm.com'
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

// ---------------------------------------------------------------------------
// RSC parser (copied from src/lib/cinemm.ts — same logic, plain JS)
// ---------------------------------------------------------------------------

const LINE_START_RE = /^([0-9a-f]+):(T[0-9a-f]+,)?/

function parseRsc(text) {
  const result = new Map()
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(LINE_START_RE)
    if (!m) {
      i++
      continue
    }
    const id = m[1]
    const isText = !!m[2]
    const payloadStart = m[0].length
    let payload = line.substring(payloadStart)
    if (isText) {
      i++
      while (i < lines.length) {
        const next = lines[i]
        if (LINE_START_RE.test(next) && next.length > 0) break
        payload += '\n' + next
        i++
      }
      // Look for glued "1:{...}" JSON at end of text chunk
      const markerStr = '1:{'
      let searchFrom = payload.length
      while (true) {
        const markerPos = payload.lastIndexOf(markerStr, searchFrom)
        if (markerPos <= 0) break
        const afterMarker = payload.substring(markerPos + markerStr.length)
        const trimmedAfter = afterMarker.trimEnd()
        if (trimmedAfter.endsWith('}')) {
          const candidateJson = '{' + trimmedAfter
          try {
            JSON.parse(candidateJson)
            payload = payload.substring(0, markerPos).trimEnd()
            result.set('1', candidateJson)
            break
          } catch {
            // not valid JSON — keep searching backwards
          }
        }
        searchFrom = markerPos - 1
      }
    } else {
      i++
    }
    if (!result.has(id)) result.set(id, payload)
  }
  return result
}

// ---------------------------------------------------------------------------
// cinemm.com Server Action call
// ---------------------------------------------------------------------------

// Track 500-error rate — if too many in a row, auto-increase delay
let consecutive500Errors = 0
let currentDelayMs = DELAY_MS

async function callAction(actionId, args) {
  // Retry with exponential backoff for 500/502/503/429 errors.
  // 500 errors are common when cinemm.com is rate-limiting or temporarily
  // overloaded. We retry up to 3 times with 5s, 15s, 30s delays.
  const retryStatuses = [429, 500, 502, 503, 504]
  const retryDelays = [5000, 15000, 30000] // 5s, 15s, 30s

  let lastError = null
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    let res
    try {
      res = await fetch(`${CINEMM_ORIGIN}/`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(25000),
      })
    } catch (e) {
      // Network error — retry
      lastError = e
      if (attempt < retryDelays.length) {
        console.log(
          `    ⏳ Network error (${e.message}), retrying in ${retryDelays[attempt] / 1000}s...`,
        )
        await sleep(retryDelays[attempt])
        continue
      }
      throw e
    }

    if (res.ok) {
      // Success — reset 500 counter, maybe decrease delay
      if (consecutive500Errors > 0) {
        console.log(`    ✅ Recovered after ${consecutive500Errors} 500-error(s)`)
      }
      consecutive500Errors = 0
      // Slowly restore original delay (don't drop below 1.5x baseline)
      if (currentDelayMs > DELAY_MS * 1.5) {
        currentDelayMs = Math.max(DELAY_MS * 1.5, currentDelayMs * 0.7)
      }
      const text = await res.text()
      return { lines: parseRsc(text), raw: text }
    }

    // Non-OK response
    if (retryStatuses.includes(res.status) && attempt < retryDelays.length) {
      // Retryable error — back off and retry
      consecutive500Errors++
      // Auto-increase delay if we're getting a lot of 500s
      if (consecutive500Errors >= 3 && currentDelayMs < DELAY_MS * 5) {
        currentDelayMs = Math.min(DELAY_MS * 5, currentDelayMs * 1.5)
        console.log(
          `    ⚠️  ${consecutive500Errors} 500-errors in a row — auto-increasing delay to ${currentDelayMs}ms`,
        )
      }
      console.log(
        `    ⏳ HTTP ${res.status}, retrying in ${retryDelays[attempt] / 1000}s (attempt ${attempt + 1}/${retryDelays.length})...`,
      )
      await sleep(retryDelays[attempt])
      continue
    }

    // Non-retryable error (4xx other than 429) — fail fast
    throw new Error(`cinemm.com HTTP ${res.status} ${res.statusText}`)
  }
  // Exhausted all retries
  throw lastError || new Error('cinemm.com: max retries exceeded')
}

// ---------------------------------------------------------------------------
// Search cinemm.com for movies/series
// ---------------------------------------------------------------------------

async function searchCinemm(query, type) {
  const { lines } = await callAction(ACTIONS.search, [query, type])
  const raw = lines.get('1')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : parsed.results || []
    return items
      .filter((it) => it && typeof it.id !== 'undefined')
      .map((it) => ({
        id: it.id,
        name: it.name || '',
        year: it.year || '',
        poster: it.poster === '$undefined' ? '' : it.poster || '',
        type,
      }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Get movie sources (returns stream URLs when called from Myanmar IP)
// ---------------------------------------------------------------------------

async function getMovieSources(id) {
  // IMPORTANT: cinemm.com expects the movie ID as a NUMBER, not a string.
  // Sending ["1234567"] (string) causes HTTP 500.
  // Sending [1234567] (number) works and returns access:"direct" with servers.
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  const { lines } = await callAction(ACTIONS.getMovieSources, [numericId])
  const raw = lines.get('1')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Get series details (returns seasons + episodes)
// ---------------------------------------------------------------------------

async function getSeriesDetails(id) {
  // getSeriesDetailsAction expects (id: number, fetchOverview: boolean)
  const numericSeriesId = typeof id === 'string' ? parseInt(id, 10) : id
  const { lines } = await callAction(ACTIONS.getSeriesDetails, [numericSeriesId, true])
  const raw = lines.get('1')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    // Series details may have $undefined placeholders; clean them
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Get episode sources (returns stream URLs for a specific episode)
// ---------------------------------------------------------------------------

async function getEpisodeSources(episodeId) {
  // getEpisodeSourcesAction expects (episodeId: number, episodeNumber: number)
  // We only have episodeId here — pass it as a number.
  const numericEpId = typeof episodeId === 'string' ? parseInt(episodeId, 10) : episodeId
  const { lines } = await callAction(ACTIONS.getEpisodeSources, [numericEpId])
  const raw = lines.get('1')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Submit stream URLs to Railway server
// ---------------------------------------------------------------------------

async function submitToRailway(mediaId, mediaType, episodeId, streamUrls) {
  const body = {
    mediaId: String(mediaId),
    mediaType,
    shortlinks: streamUrls, // server detects these are direct URLs (not cinemm.com/p/...)
  }
  if (episodeId) body.episodeId = String(episodeId)

  const res = await fetch(`${RAILWAY_URL}/api/manual-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000), // server may HEAD each URL for size
  })
  if (!res.ok) {
    throw new Error(`Railway HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Progress file I/O
// ---------------------------------------------------------------------------

function loadProgress() {
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    if (!data.discoveredIds) data.discoveredIds = { movie: [], series: [] }
    if (!data.processedIds) data.processedIds = { movie: [], series: [] }
    if (!data.submittedCount) data.submittedCount = 0
    if (!data.failedCount) data.failedCount = 0
    return data
  } catch {
    return {
      discoveredIds: { movie: [], series: [] },
      processedIds: { movie: [], series: [] },
      submittedCount: 0,
      failedCount: 0,
      lastRun: null,
    }
  }
}

function saveProgress(p) {
  p.lastRun = new Date().toISOString()
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2))
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Discovery: build list of all movie/series IDs via alphabetical search
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function genSingleCharQueries() {
  return ALPHABET.split('')
}

function genDoubleCharQueries() {
  const out = []
  for (const c1 of ALPHABET) {
    for (const c2 of ALPHABET) {
      out.push(c1 + c2)
    }
  }
  return out
}

async function discoverIdsForType(type, progress) {
  const known = new Set(progress.discoveredIds[type])
  const singleChars = genSingleCharQueries()
  console.log(`\n🔍 [${type}] Phase 1: single-char search (${singleChars.length} queries)`)

  // Always do single-char first — it's cheap (36 queries) and gives us a baseline
  const lettersNeedingDouble = []
  for (const q of singleChars) {
    try {
      const items = await searchCinemm(q, type)
      for (const it of items) known.add(it.id)
      console.log(`  "${q}" → ${items.length} results (total unique: ${known.size})`)
      if (items.length >= 30) lettersNeedingDouble.push(q)
    } catch (e) {
      console.error(`  "${q}" → ERROR: ${e.message}`)
    }
    saveProgress(progress)
    await sleep(currentDelayMs)
  }

  progress.discoveredIds[type] = Array.from(known)
  saveProgress(progress)

  // Phase 2: double-char search for letters that returned 30 (likely more exist)
  // Or always do double-char if mode is "double"
  let doubleQueries = []
  if (QUERY_MODE === 'double') {
    doubleQueries = genDoubleCharQueries()
  } else if (QUERY_MODE === 'auto' && lettersNeedingDouble.length > 0) {
    console.log(
      `\n🔍 [${type}] Phase 2: double-char search for ${lettersNeedingDouble.length} letters ` +
        `that returned 30 results (likely more)`,
    )
    for (const c of lettersNeedingDouble) {
      for (const c2 of ALPHABET) {
        doubleQueries.push(c + c2)
      }
    }
  } else {
    console.log(`\n✅ [${type}] Skipping double-char search (mode=${QUERY_MODE})`)
  }

  for (let i = 0; i < doubleQueries.length; i++) {
    const q = doubleQueries[i]
    try {
      const items = await searchCinemm(q, type)
      const before = known.size
      for (const it of items) known.add(it.id)
      const newCount = known.size - before
      if (newCount > 0) {
        console.log(
          `  [${i + 1}/${doubleQueries.length}] "${q}" → ${items.length} results (+${newCount} new, total: ${known.size})`,
        )
      }
    } catch (e) {
      console.error(`  [${i + 1}/${doubleQueries.length}] "${q}" → ERROR: ${e.message}`)
    }
    if ((i + 1) % 20 === 0) {
      progress.discoveredIds[type] = Array.from(known)
      saveProgress(progress)
    }
    await sleep(currentDelayMs)
  }

  progress.discoveredIds[type] = Array.from(known)
  saveProgress(progress)
  console.log(`📚 [${type}] Discovered ${known.size} unique IDs total`)
}

// ---------------------------------------------------------------------------
// Process movies: fetch sources + submit to Railway
// ---------------------------------------------------------------------------

async function processMovie(id, progress) {
  const sources = await getMovieSources(id)
  if (!sources) {
    console.log(`  ⏭️  movie ${id}: no response`)
    return
  }
  if (sources.access !== 'direct') {
    console.log(`  ⚠️  movie ${id}: access="${sources.access}" (not Myanmar IP?)`)
    return
  }
  const servers = sources.servers || []
  if (servers.length === 0) {
    console.log(`  ⏭️  movie ${id}: no servers`)
    return
  }
  const urls = servers.map((s) => s.url).filter(Boolean)
  if (urls.length === 0) {
    console.log(`  ⏭️  movie ${id}: servers have no URLs`)
    return
  }
  try {
    const result = await submitToRailway(id, 'movie', null, urls)
    progress.submittedCount += result.stored || 0
    progress.failedCount += result.failed || 0
    console.log(`  ✅ movie ${id}: ${result.stored}/${urls.length} stored, ${result.failed} failed`)
  } catch (e) {
    progress.failedCount++
    console.error(`  ❌ movie ${id}: submit failed: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// Process series: fetch episodes + submit each episode's sources
// ---------------------------------------------------------------------------

async function processSeries(id, progress) {
  const details = await getSeriesDetails(id)
  if (!details) {
    console.log(`  ⏭️  series ${id}: no response`)
    return
  }
  const seasons = details.seasons || []
  if (seasons.length === 0) {
    console.log(`  ⏭️  series ${id}: no seasons`)
    return
  }
  console.log(`  📺 series ${id}: ${seasons.length} seasons`)
  for (const season of seasons) {
    const episodes = season.episodes || []
    for (const ep of episodes) {
      if (!ep.id) continue
      try {
        const sources = await getEpisodeSources(ep.id)
        if (!sources || sources.access !== 'direct') {
          console.log(
            `    ⏭️  S${season.season_number}E${ep.episode_number}: access="${sources?.access || 'null'}"`,
          )
          await sleep(currentDelayMs)
          continue
        }
        const servers = sources.servers || []
        const urls = servers.map((s) => s.url).filter(Boolean)
        if (urls.length === 0) {
          console.log(`    ⏭️  S${season.season_number}E${ep.episode_number}: no URLs`)
          await sleep(currentDelayMs)
          continue
        }
        const result = await submitToRailway(id, 'series', ep.id, urls)
        progress.submittedCount += result.stored || 0
        progress.failedCount += result.failed || 0
        console.log(
          `    ✅ S${season.season_number}E${ep.episode_number}: ${result.stored}/${urls.length} stored`,
        )
      } catch (e) {
        progress.failedCount++
        console.error(`    ❌ S${season.season_number}E${ep.episode_number}: ${e.message}`)
      }
      await sleep(currentDelayMs)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  cinemm.com Crawler — runs from your phone (Myanmar IP)')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  Railway URL:    ${RAILWAY_URL}`)
  console.log(`  Types:          ${TYPES.join(', ')}`)
  console.log(`  Query mode:     ${QUERY_MODE}`)
  console.log(`  Delay:          ${DELAY_MS}ms`)
  console.log(`  Progress file:  ${PROGRESS_FILE}`)
  console.log('═══════════════════════════════════════════════════════════\n')

  const progress = loadProgress()
  console.log(
    `📂 Loaded progress: discovered ${Object.values(progress.discoveredIds).flat().length} IDs, ` +
      `processed ${Object.values(progress.processedIds).flat().length}, ` +
      `submitted ${progress.submittedCount}, failed ${progress.failedCount}\n`,
  )

  // Phase 1: discover all IDs for each type
  for (const type of TYPES) {
    if (progress.discoveredIds[type].length === 0) {
      await discoverIdsForType(type, progress)
    } else {
      console.log(`📚 [${type}] Already discovered ${progress.discoveredIds[type].length} IDs — skipping discovery`)
    }
  }

  // Phase 2: process each ID
  for (const type of TYPES) {
    const ids = progress.discoveredIds[type]
    const processed = new Set(progress.processedIds[type])
    const queue = ids.filter((id) => !processed.has(id))

    console.log(
      `\n🚀 [${type}] Processing ${queue.length} IDs ` +
        `(skipping ${processed.size} already done)...\n`,
    )

    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      const label = `[${i + 1}/${queue.length}]`
      let success = false
      let errorMsg = ''
      try {
        if (type === 'movie') {
          console.log(`${label} movie ${id}`)
          await processMovie(id, progress)
          success = true
        } else {
          console.log(`${label} series ${id}`)
          await processSeries(id, progress)
          success = true
        }
      } catch (e) {
        progress.failedCount++
        errorMsg = e instanceof Error ? e.message : String(e)
        console.error(`${label} ERROR: ${errorMsg}`)
      }
      // Decide whether to mark this ID as "processed" (skip on next run):
      //   - Success → mark as processed
      //   - Failed with HTTP 5xx / 429 / network error → DON'T mark (retry next run)
      //   - Failed with "access:telegram" or "no servers" → mark as processed
      //     (movie exists but has no URLs — no point retrying)
      if (success) {
        progress.processedIds[type].push(id)
      } else if (/HTTP 5\d\d|HTTP 429|network|ETIMEDOUT|ECONN|fetch failed/i.test(errorMsg)) {
        // Transient error — will retry on next run
        console.log(`    🔁 Will retry on next run (transient error)`)
      } else {
        // Permanent failure (e.g. access:telegram, no servers) — skip on next run
        progress.processedIds[type].push(id)
      }
      if ((i + 1) % 10 === 0) {
        saveProgress(progress)
        console.log(
          `\n📊 Progress: ${i + 1}/${queue.length} | ` +
            `Total submitted: ${progress.submittedCount} | ` +
            `Failed: ${progress.failedCount}\n`,
        )
      }
      await sleep(currentDelayMs)
    }
    saveProgress(progress)
  }

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  🎉 Done!')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  Total discovered: ${Object.values(progress.discoveredIds).flat().length}`)
  console.log(`  Total processed:  ${Object.values(progress.processedIds).flat().length}`)
  console.log(`  Total submitted:  ${progress.submittedCount}`)
  console.log(`  Total failed:     ${progress.failedCount}`)
  console.log('═══════════════════════════════════════════════════════════\n')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
