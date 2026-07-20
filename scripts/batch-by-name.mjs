/**
 * Process a SINGLE movie or series by name (or partial name).
 *
 * Searches cinemm.com for matching items, then processes the FIRST match
 * (or all matches with --all flag) to fetch stream URLs and submit them
 * to Railway.
 *
 * Usage:
 *   node scripts/batch-by-name.mjs movie "Inception"
 *   node scripts/batch-by-name.mjs series "Breaking Bad"
 *   node scripts/batch-by-name.mjs movie "Avengers" --all
 *   node scripts/batch-by-name.mjs series "One Piece" --all
 *
 * Behavior:
 *   1. Searches cinemm.com for items matching the name
 *   2. Without --all: processes the FIRST match only
 *   3. With --all: processes ALL matches (careful — could be many)
 *   4. For movies: fetches getMovieSourcesAction, submits URLs to Railway
 *   5. For series: fetches getSeriesDetailsAction, then for each episode
 *      fetches getEpisodeSourcesAction and submits URLs to Railway
 *   6. Updates crawl-progress.json so the items are marked as 'processed'
 *      (won't be re-processed by batch-crawl.mjs in future runs)
 *
 * Examples:
 *   node scripts/batch-by-name.mjs movie "Dhak Dhak"
 *     → searches "Dhak Dhak" in movies, processes the first match
 *
 *   node scripts/batch-by-name.mjs series "Agatha"
 *     → searches "Agatha" in series, processes the first match
 *
 *   node scripts/batch-by-name.mjs series "One Piece" --all
 *     → searches "One Piece" in series, processes ALL matches
 *       (useful when there are multiple seasons as separate entries)
 */

import fs from 'fs'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const CINEMM_ORIGIN = 'https://cinemm.com'

const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieSources: '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getEpisodeSources: '705765e4f6aa5ce95c001ef982ddc2a6ac62c60930',
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
const PROGRESS_FILE = process.env.CRAWL_PROGRESS || './crawl-progress.json'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- RSC parser ----------
const LINE_START_RE = /^([0-9a-f]+):(T[0-9a-f]+,)?/

function parseRsc(text) {
  const result = new Map()
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(LINE_START_RE)
    if (!m) { i++; continue }
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
      // Also try to find a JSON object embedded at the end (Breaking Bad pattern)
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
            result.set('1', candidateJson)
            break
          } catch {}
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

// ---------- callAction with retry on 500/429 ----------
async function callAction(actionId, args) {
  const retryStatuses = [429, 500, 502, 503, 504]
  const retryDelays = [5000, 15000, 30000]
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
      lastError = e
      if (attempt < retryDelays.length) {
        console.log(`    ⏳ Network error (${e.message}), retry in ${retryDelays[attempt] / 1000}s...`)
        await sleep(retryDelays[attempt])
        continue
      }
      throw e
    }

    if (res.ok) {
      const text = await res.text()
      return { lines: parseRsc(text), raw: text }
    }

    if (retryStatuses.includes(res.status) && attempt < retryDelays.length) {
      console.log(`    ⏳ HTTP ${res.status}, retry in ${retryDelays[attempt] / 1000}s (attempt ${attempt + 1}/3)...`)
      await sleep(retryDelays[attempt])
      continue
    }

    throw new Error(`cinemm.com HTTP ${res.status} ${res.statusText}`)
  }
  throw lastError || new Error('cinemm.com: max retries exceeded')
}

// ---------- Action callers ----------
async function searchCinemm(query, type) {
  const { lines } = await callAction(ACTIONS.search, [query, type])
  const raw = lines.get('1')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return parsed.results || parsed.items || []
  } catch { return [] }
}

async function getMovieSources(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  const { lines } = await callAction(ACTIONS.getMovieSources, [numericId])
  const raw = lines.get('1')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function getSeriesDetails(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  const { lines } = await callAction(ACTIONS.getSeriesDetails, [numericId, true])
  const raw = lines.get('1')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function getEpisodeSources(episodeId, episodeNumber) {
  const numericEpId = typeof episodeId === 'string' ? parseInt(episodeId, 10) : episodeId
  const numericEpNum = typeof episodeNumber === 'string' ? parseInt(episodeNumber, 10) : (episodeNumber || 1)
  const { lines } = await callAction(ACTIONS.getEpisodeSources, [numericEpId, numericEpNum])
  const raw = lines.get('1')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ---------- Railway submit with retry on 502 ----------
async function submitToRailwayWithRetry(mediaId, mediaType, episodeId, streamUrls) {
  const body = {
    mediaId: String(mediaId),
    mediaType,
    shortlinks: streamUrls,
  }
  if (episodeId) body.episodeId = String(episodeId)

  const retryDelays = [10000, 20000, 30000]
  let lastError = null
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const res = await fetch(`${RAILWAY_URL}/api/manual-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      })
      if (!res.ok) {
        throw new Error(`Railway HTTP ${res.status}: ${await res.text()}`)
      }
      return res.json()
    } catch (e) {
      lastError = e
      const msg = e.message || ''
      const isRetryable = /HTTP 5\d\d|fetch failed|ETIMEDOUT|ECONNRESET|network/i.test(msg)
      if (!isRetryable || attempt >= retryDelays.length) throw e
      console.log(`    ⏳ Railway error, retry in ${retryDelays[attempt] / 1000}s (attempt ${attempt + 1}/3)...`)
      await sleep(retryDelays[attempt])
    }
  }
  throw lastError
}

// ---------- Progress file I/O (atomic, with backup) ----------
function loadProgress() {
  let raw
  try {
    raw = fs.readFileSync(PROGRESS_FILE, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        discoveredIds: { movie: [], series: [] },
        processedIds: { movie: [], series: [] },
        submittedCount: 0,
        failedCount: 0,
        seriesNames: {},
        movieNames: {},
        lastRun: null,
      }
    }
    throw e
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    const backupPath = `${PROGRESS_FILE}.corrupt-${Date.now()}`
    try { fs.writeFileSync(backupPath, raw) } catch {}
    console.error(`\n❌ FATAL: ${PROGRESS_FILE} is corrupt. Backed up to ${backupPath}. Aborting.`)
    process.exit(1)
  }

  if (!data.discoveredIds) data.discoveredIds = { movie: [], series: [] }
  if (!data.processedIds) data.processedIds = { movie: [], series: [] }
  if (!data.submittedCount) data.submittedCount = 0
  if (!data.failedCount) data.failedCount = 0
  if (!data.seriesNames) data.seriesNames = {}
  if (!data.movieNames) data.movieNames = {}
  return data
}

function saveProgress(p) {
  p.lastRun = new Date().toISOString()
  const jsonStr = JSON.stringify(p, null, 2)
  try {
    try {
      const current = fs.readFileSync(PROGRESS_FILE, 'utf8')
      fs.writeFileSync(`${PROGRESS_FILE}.bak`, current)
    } catch {}
    const tmpPath = `${PROGRESS_FILE}.tmp`
    fs.writeFileSync(tmpPath, jsonStr)
    fs.renameSync(tmpPath, PROGRESS_FILE)
  } catch (e) {
    console.error(`\n⚠️  Failed to save progress: ${e.message}`)
  }
}

// ---------- Processors ----------
async function processMovie(id, progress) {
  const sources = await getMovieSources(id)
  if (!sources) {
    console.log(`  ⚠️  No response`)
    return { stored: 0, status: 'no-response' }
  }
  if (sources.access !== 'direct') {
    console.log(`  ⚠️  access="${sources.access}" (VPN IP not Myanmar?)`)
    return { stored: 0, status: 'not-direct' }
  }
  const servers = sources.servers || []
  if (servers.length === 0) {
    console.log(`  ⏭️  No servers`)
    return { stored: 0, status: 'no-servers' }
  }
  const urls = servers
    .map((s) => s.playUrl || s.url)
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')))
  if (urls.length === 0) {
    console.log(`  ⏭️  No URLs in servers`)
    return { stored: 0, status: 'no-urls' }
  }

  // Cache movie name from filename
  if (!progress.movieNames) progress.movieNames = {}
  if (!progress.movieNames[id]) {
    const firstFileName = servers[0]?.filename || servers[0]?.name || ''
    if (firstFileName) {
      const cleaned = firstFileName
        .replace(/\.(mkv|mp4|avi|mov|webm).*$/i, '')
        .replace(/\b(8K|4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDTV|HEVC|AVC|CM|MPK|MW|YK|TRUE|Edit)\b.*$/i, '')
        .replace(/[._]/g, ' ')
        .trim()
      if (cleaned) progress.movieNames[id] = cleaned
    }
  }
  const movieName = progress.movieNames[id] || '(unknown)'
  console.log(`  🎬 "${movieName}"`)

  try {
    const result = await submitToRailwayWithRetry(id, 'movie', null, urls)
    progress.submittedCount += result.stored || 0
    progress.failedCount += result.failed || 0
    console.log(`  ✅ ${result.stored}/${urls.length} stored`)
    if (result.results) {
      result.results.forEach((r, idx) => {
        if (r.stored) {
          console.log(`     [${idx + 1}] ${r.quality || '?'} | ${r.host || '?'} | ${(r.fileName || '').slice(0, 60)}`)
        } else if (r.error) {
          console.log(`     [${idx + 1}] ❌ ${r.error}`)
        }
      })
    }
    return { stored: result.stored || 0, status: 'success' }
  } catch (e) {
    progress.failedCount++
    console.error(`  ❌ Submit failed: ${e.message}`)
    return { stored: 0, status: 'submit-failed' }
  }
}

async function processSeries(id, progress) {
  const details = await getSeriesDetails(id)
  if (!details) {
    console.log(`  ⚠️  No response`)
    return { stored: 0, status: 'no-response' }
  }
  const seasons = details.seasons || []
  if (seasons.length === 0) {
    console.log(`  ⏭️  No seasons`)
    return { stored: 0, status: 'no-seasons' }
  }

  const seriesName = progress.seriesNames?.[id] || '(unknown)'
  const totalEpisodesCount = seasons.reduce((sum, s) => sum + (s.episodes?.length || 0), 0)
  console.log(`  📺 "${seriesName}" — ${seasons.length} season(s), ${totalEpisodesCount} episode(s)`)

  if (!progress.seriesNames) progress.seriesNames = {}

  let totalStored = 0
  let totalEpisodes = 0

  for (let seasonIdx = 0; seasonIdx < seasons.length; seasonIdx++) {
    const season = seasons[seasonIdx]
    const seasonNum = seasonIdx + 1
    const episodes = season.episodes || []
    console.log(`  Season ${seasonNum} (${season.name || 'unnamed'}): ${episodes.length} episode(s)`)

    for (const ep of episodes) {
      if (!ep.id) continue
      const epNum = ep.episode_number ?? ep.episodeNumber ?? 1
      totalEpisodes++
      try {
        const sources = await getEpisodeSources(ep.id, epNum)
        if (!sources || sources.access !== 'direct') {
          console.log(`    ⏭️  S${seasonNum}E${epNum}: access="${sources?.access || 'null'}"`)
          await sleep(DELAY_MS)
          continue
        }
        const servers = sources.servers || []
        const urls = servers
          .map((s) => s.playUrl || s.url)
          .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')))
        if (urls.length === 0) {
          console.log(`    ⏭️  S${seasonNum}E${epNum}: no URLs`)
          await sleep(DELAY_MS)
          continue
        }
        const result = await submitToRailwayWithRetry(id, 'series', ep.id, urls)
        progress.submittedCount += result.stored || 0
        progress.failedCount += result.failed || 0
        totalStored += result.stored || 0
        console.log(`    ✅ S${seasonNum}E${epNum}: ${result.stored}/${urls.length} stored`)
      } catch (e) {
        progress.failedCount++
        console.error(`    ❌ S${seasonNum}E${epNum}: ${e.message}`)
      }
      await sleep(DELAY_MS)
    }
  }
  return { stored: totalStored, status: 'success', episodes: totalEpisodes }
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2)

  // Parse args: type, name, optional --all flag
  const type = args[0]
  let nameArg = ''
  let processAll = false
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--all') {
      processAll = true
    } else if (!nameArg) {
      nameArg = args[i]
    }
  }

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Process by Name — search cinemm.com + process matches')
  console.log('═══════════════════════════════════════════════════════\n')

  if (type !== 'movie' && type !== 'series') {
    console.log('Usage:')
    console.log('  node scripts/batch-by-name.mjs movie "Inception"')
    console.log('  node scripts/batch-by-name.mjs series "Breaking Bad"')
    console.log('  node scripts/batch-by-name.mjs movie "Avengers" --all')
    console.log('  node scripts/batch-by-name.mjs series "One Piece" --all')
    console.log('')
    console.log('Without --all: processes only the FIRST search result.')
    console.log('With --all: processes ALL search results (careful, could be many).')
    console.log('')
    console.log('Optional env vars:')
    console.log('  CRAWL_DELAY_MS=2000     (default: 2000ms between requests)')
    console.log('  RAILWAY_URL=...         (default: production URL)')
    process.exit(0)
  }

  if (!nameArg) {
    console.error(`❌ Missing name. Usage: node scripts/batch-by-name.mjs ${type} "Name" [--all]`)
    process.exit(1)
  }

  console.log(`  Type:        ${type}`)
  console.log(`  Search:      "${nameArg}"`)
  console.log(`  Mode:        ${processAll ? 'ALL matches' : 'FIRST match only'}`)
  console.log(`  Railway URL: ${RAILWAY_URL}`)
  console.log(`  Delay:       ${DELAY_MS}ms\n`)

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
    console.log('   Try a different spelling or shorter query.')
    process.exit(0)
  }

  // Step 2: Filter to selected items
  const selected = processAll ? items : items.slice(0, 1)
  console.log(`🚀 Processing ${selected.length} ${type}(s)...\n`)

  // Step 3: Load progress (for caching names + marking as processed)
  const progress = loadProgress()

  // Step 4: Cache the names from search results
  if (!progress[`${type}Names`]) progress[`${type}Names`] = {}
  for (const it of selected) {
    if (it.name || it.title) {
      progress[`${type}Names`][it.id] = it.name || it.title
    }
  }
  saveProgress(progress)

  // Step 5: Process each selected item
  const stats = {
    success: 0,
    noUrls: 0,
    failed: 0,
    stored: 0,
    episodesProcessed: 0,
  }

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i]
    const name = item.name || item.title || '(unknown)'
    console.log(`━━━ [${i + 1}/${selected.length}] ${type} ${item.id} — "${name}" (${item.year || '?'}) ━━━`)

    let result
    try {
      if (type === 'movie') {
        result = await processMovie(item.id, progress)
      } else {
        result = await processSeries(item.id, progress)
        if (result.episodes) stats.episodesProcessed += result.episodes
      }
    } catch (e) {
      progress.failedCount++
      console.error(`  ❌ ERROR: ${e.message}`)
      result = { stored: 0, status: 'error' }
    }

    stats.stored += result.stored || 0
    if (result.status === 'success') stats.success++
    else if (result.status === 'no-servers' || result.status === 'no-urls' || result.status === 'no-seasons' || result.status === 'not-direct') stats.noUrls++
    else stats.failed++

    // Mark as processed in progress file (so batch-crawl.mjs skips it)
    if (!progress.processedIds[type].includes(String(item.id))) {
      progress.processedIds[type].push(String(item.id))
    }

    // Also add to discoveredIds if not present (so progress stays consistent)
    if (!progress.discoveredIds[type].includes(String(item.id))) {
      progress.discoveredIds[type].push(String(item.id))
    }

    saveProgress(progress)
    if (i < selected.length - 1) await sleep(DELAY_MS)
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  ${type.toUpperCase()}s processed: ${selected.length}`)
  console.log(`  ✅ Success:    ${stats.success}`)
  console.log(`  ⏭️  No URLs:    ${stats.noUrls}`)
  console.log(`  ❌ Failed:     ${stats.failed}`)
  console.log(`  📦 URLs stored: ${stats.stored}`)
  if (type === 'series') {
    console.log(`  📺 Episodes processed: ${stats.episodesProcessed}`)
  }
  console.log(`\n  Total URLs stored all-time: ${progress.submittedCount}`)
  console.log('\n🔍 Verify on the website:')
  console.log(`   ${RAILWAY_URL}`)
  console.log('\n═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
