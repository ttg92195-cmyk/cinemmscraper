/**
 * Batch Crawler — process 20 items at a time (Bro's smart plan).
 *
 * Why this exists:
 *   - Full 6500+ item crawl takes 30+ hours and can fail if VPN IP gets
 *     blocked mid-run
 *   - Bro wants to do small batches (20 items), verify the URLs work,
 *     then do another batch when he has time
 *   - If VPN IP gets blocked, just switch VPN server and continue
 *
 * Usage:
 *   node scripts/batch-crawl.mjs movie     # process next 20 un-processed movies
 *   node scripts/batch-crawl.mjs series    # process next 20 un-processed series
 *   node scripts/batch-crawl.mjs movie 50  # process next 50 movies (custom batch size)
 *
 * Behavior:
 *   1. Loads crawl-progress.json
 *   2. Filters to un-processed IDs of the chosen type
 *   3. Takes next 20 (or custom count)
 *   4. For each: calls getMovieSourcesAction / getEpisodeSourcesAction
 *   5. Submits shortlinks to Railway (with retry on 502)
 *   6. Saves progress after each item (so you can Ctrl+C anytime)
 *   7. Prints summary at the end
 *
 * Re-running with same type continues from where you left off — already
 * processed IDs are auto-skipped. So running it 10 times = 200 items total.
 *
 * If VPN IP gets blocked mid-batch:
 *   - Ctrl+C to stop
 *   - Switch VPN server (or wait 30 min for IP cooldown)
 *   - Re-run same command — picks up where it stopped
 */

import fs from 'fs'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const CINEMM_ORIGIN = 'https://cinemm.com'

const ACTIONS = {
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

const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || '1500', 10)
// Number of movies/series to process in parallel. Each makes its own
// cinemm.com + Railway calls, so 3 parallel = ~3x faster than sequential.
// Higher than 3 risks cinemm.com rate-limiting (HTTP 429/500).
const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || '3', 10)
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
let consecutive500Errors = 0

async function callAction(actionId, args) {
  const retryStatuses = [429, 500, 502, 503, 504]
  // Tighter retry delays: 3s, 8s, 15s (was 5s, 15s, 30s).
  // Most 500 errors are transient (cinemm.com overloaded), and waiting
  // 30s just wastes time. 3s is enough for most cases.
  const retryDelays = [3000, 8000, 15000]
  let lastError = null

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    let res
    try {
      res = await fetch(`${CINEMM_ORIGIN}/`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20000),
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
      if (consecutive500Errors > 0) {
        console.log(`    ✅ Recovered after ${consecutive500Errors} 500-error(s)`)
      }
      consecutive500Errors = 0
      const text = await res.text()
      return { lines: parseRsc(text), raw: text }
    }

    if (retryStatuses.includes(res.status) && attempt < retryDelays.length) {
      consecutive500Errors++
      console.log(`    ⏳ HTTP ${res.status}, retry in ${retryDelays[attempt] / 1000}s (attempt ${attempt + 1}/3)...`)
      await sleep(retryDelays[attempt])
      continue
    }

    throw new Error(`cinemm.com HTTP ${res.status} ${res.statusText}`)
  }
  throw lastError || new Error('cinemm.com: max retries exceeded')
}

// ---------- Action callers ----------
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
async function submitToRailway(mediaId, mediaType, episodeId, streamUrls) {
  const body = {
    mediaId: String(mediaId),
    mediaType,
    shortlinks: streamUrls,
  }
  if (episodeId) body.episodeId = String(episodeId)

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
}

async function submitToRailwayWithRetry(mediaId, mediaType, episodeId, streamUrls) {
  // Tighter retry delays: 4s, 8s, 12s (was 10s, 20s, 30s).
  // Railway cold-start 502s usually resolve in 4s; waiting 30s was overkill.
  const retryDelays = [4000, 8000, 12000]
  let lastError = null
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return await submitToRailway(mediaId, mediaType, episodeId, streamUrls)
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

// ---------- Railway warm-up (prevents first-request 502) ----------
/**
 * Railway free tier sleeps the service after ~5 min of inactivity.
 * The first request after sleep returns 502 while the container spins up.
 * This function sends a lightweight GET to wake the server before we
 * start the real batch, saving us a 10-30s retry cycle on the first item.
 */
async function warmupRailway() {
  const start = Date.now()
  try {
    const res = await fetch(`${RAILWAY_URL}/api/manual-link?mediaId=0&mediaType=movie`, {
      signal: AbortSignal.timeout(30000),
    })
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    if (res.ok) {
      console.log(`   ✅ Railway warm (${elapsed}s)`)
    } else {
      console.log(`   ⚠️  Railway warmup HTTP ${res.status} (${elapsed}s) — continuing anyway`)
    }
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`   ⚠️  Railway warmup failed (${elapsed}s): ${e.message} — continuing anyway`)
  }
}

// ---------- Progress file I/O ----------
function loadProgress() {
  // CRITICAL: Never return empty progress on parse failure — that would
  // cause saveProgress() to overwrite the (possibly corrupt) file with
  // empty data, destroying hours of work. Instead, ABORT with a clear
  // error message so Bro can manually inspect/recover the file.
  let raw
  try {
    raw = fs.readFileSync(PROGRESS_FILE, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      // File doesn't exist yet — this is the FIRST run, so empty progress is correct.
      console.log(`  ℹ️  ${PROGRESS_FILE} not found — starting fresh (first run)`)
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
    // File is corrupt — DON'T return empty progress (would overwrite).
    // Save a backup of the corrupt file so Bro can recover, then abort.
    const backupPath = `${PROGRESS_FILE}.corrupt-${Date.now()}`
    try {
      fs.writeFileSync(backupPath, raw)
    } catch {}
    console.error(`\n❌ FATAL: ${PROGRESS_FILE} is corrupt (JSON parse failed).`)
    console.error(`   Backed up to: ${backupPath}`)
    console.error(`   Manual recovery options:`)
    console.error(`     1. Inspect the backup file: cat ${backupPath} | head -50`)
    console.error(`     2. If mostly intact, fix the JSON manually and rename to ${PROGRESS_FILE}`)
    console.error(`     3. If unrecoverable, delete it and re-run discovery phase`)
    console.error(`   Aborting to prevent data loss.\n`)
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

  // Atomic write strategy:
  //   1. Write to a temp file (PROGRESS_FILE.tmp)
  //   2. If write succeeds, rename to the real file
  //   3. If a previous .bak exists, leave it (it's the backup from 2 saves ago)
  //
  // Additionally, before writing, we back up the current file to .bak
  // so we always have the previous version recoverable.
  try {
    // Back up current file (if it exists) to .bak
    try {
      const current = fs.readFileSync(PROGRESS_FILE, 'utf8')
      fs.writeFileSync(`${PROGRESS_FILE}.bak`, current)
    } catch {
      // No current file — that's fine for the first save
    }

    // Write to temp file first
    const tmpPath = `${PROGRESS_FILE}.tmp`
    fs.writeFileSync(tmpPath, jsonStr)

    // Atomic rename to real file (POSIX atomic on same filesystem)
    fs.renameSync(tmpPath, PROGRESS_FILE)
  } catch (e) {
    console.error(`\n⚠️  Failed to save progress: ${e.message}`)
    console.error(`   Progress data is in memory only — will be lost on exit.`)
    console.error(`   Last successful save: ${p.lastRun}`)
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

  // Try to extract movie name from file names in stream URLs
  // (e.g. "An.Autumn.Afternoon.1962.1080p.BluRay MPK.mp4" -> "An.Autumn.Afternoon")
  if (!progress.movieNames) progress.movieNames = {}
  if (!progress.movieNames[id]) {
    const firstFileName = servers[0]?.filename || servers[0]?.name || ''
    if (firstFileName) {
      // Strip quality/format suffixes to get a rough title
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

  // Series name comes from search results, not getSeriesDetails.
  // We try to fetch it via a search if not cached.
  const seriesName = progress.seriesNames?.[id] || details.name || details.title || '(unknown)'
  const totalEpisodesCount = seasons.reduce(
    (sum, s) => sum + (s.episodes?.length || 0),
    0,
  )
  console.log(`  📺 "${seriesName}" — ${seasons.length} season(s), ${totalEpisodesCount} episode(s)`)

  // Cache the name if we got it fresh
  if (!progress.seriesNames) progress.seriesNames = {}
  if (seriesName !== '(unknown)' && !progress.seriesNames[id]) {
    progress.seriesNames[id] = seriesName
  }

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
  const type = process.argv[2] // 'movie' or 'series'
  const batchSize = parseInt(process.argv[3] || '20', 10)

  if (type !== 'movie' && type !== 'series') {
    console.log('═══════════════════════════════════════════════════════')
    console.log('  Batch Crawler — process N items at a time')
    console.log('═══════════════════════════════════════════════════════\n')
    console.log('Usage:')
    console.log('  node scripts/batch-crawl.mjs movie       # next 20 movies')
    console.log('  node scripts/batch-crawl.mjs series      # next 20 series')
    console.log('  node scripts/batch-crawl.mjs movie 50    # next 50 movies')
    console.log('')
    console.log('Re-running with same type continues from where you left off.')
    console.log('Already-processed IDs are auto-skipped.\n')
    console.log('Optional env vars:')
    console.log('  CRAWL_DELAY_MS=2000     (default: 2000ms between requests)')
    console.log('  RAILWAY_URL=...         (default: production URL)')
    process.exit(0)
  }

  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Batch Crawler — ${type.toUpperCase()} (batch size: ${batchSize})`)
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`Railway URL: ${RAILWAY_URL}`)
  console.log(`Delay:       ${DELAY_MS}ms\n`)

  const progress = loadProgress()
  const discovered = progress.discoveredIds[type] || []
  const processed = new Set(progress.processedIds[type] || [])

  console.log(`📂 Progress:`)
  console.log(`   Discovered ${type}s: ${discovered.length}`)
  console.log(`   Already processed:  ${processed.size}`)
  console.log(`   Remaining:          ${discovered.length - processed.size}`)

  if (discovered.length === 0) {
    console.log(`\n❌ No ${type} IDs discovered yet. Run discovery first:`)
    console.log(`   CRAWL_TYPES=${type} CRAWL_QUERY_MODE=auto node scripts/crawl-from-phone.mjs`)
    process.exit(1)
  }

  // Get next batch of un-processed IDs
  const queue = discovered.filter((id) => !processed.has(id)).slice(0, batchSize)

  if (queue.length === 0) {
    console.log(`\n🎉 All ${discovered.length} ${type}s already processed!`)
    console.log(`   Total submitted: ${progress.submittedCount}`)
    console.log(`   Total failed:    ${progress.failedCount}`)
    process.exit(0)
  }

  // Warm up Railway server (prevents 502 cold-start on first item)
  console.log(`🔥 Warming up Railway server...`)
  await warmupRailway()

  console.log(`\n🚀 Processing ${queue.length} ${type}(s) this batch...`)
  console.log(`   Concurrency: ${CONCURRENCY} (parallel ${type}s at a time)`)
  console.log(`   Delay between cinemm.com calls: ${DELAY_MS}ms\n`)

  const stats = {
    success: 0,
    noUrls: 0,
    failed: 0,
    stored: 0,
    episodesProcessed: 0, // series only
  }

  // ---------- Concurrent processing ----------
  // Process CONCURRENCY items at a time. Each task:
  //   1. Calls cinemm.com getMovieSources/getSeriesDetails
  //   2. Calls Railway /api/manual-link to store URLs
  //   3. Updates shared progress + stats
  //
  // The shared `progress` object is mutated only by the task itself (no
  // overlap because each task works on a different ID), so no locking
  // needed. saveProgress() uses atomic write so concurrent saves are safe
  // (last write wins, but each task only adds its own ID).
  let nextIndex = 0
  let completedCount = 0

  async function worker(workerId) {
    while (true) {
      const i = nextIndex++
      if (i >= queue.length) return

      const id = queue[i]
      const tag = `[${i + 1}/${queue.length}]`
      console.log(`━━━ ${tag} ${type} ${id} (worker ${workerId}) ━━━`)

      let result
      try {
        if (type === 'movie') {
          result = await processMovie(id, progress)
        } else {
          result = await processSeries(id, progress)
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

      // Mark as processed (skip on next run) — only for permanent results
      if (result.status === 'success' || result.status === 'no-servers' || result.status === 'no-urls' || result.status === 'no-seasons' || result.status === 'no-response' || result.status === 'not-direct') {
        progress.processedIds[type].push(id)
      } else {
        console.log(`  🔁 Will retry on next batch (transient error)`)
      }

      completedCount++
      // Save every 5 completed items (not every item — reduces disk I/O)
      if (completedCount % 5 === 0 || completedCount === queue.length) {
        saveProgress(progress)
      }
      // Brief delay before next item (lets cinemm.com breathe)
      await sleep(DELAY_MS / CONCURRENCY)
    }
  }

  // Launch CONCURRENCY workers in parallel
  const workers = []
  for (let w = 1; w <= CONCURRENCY; w++) {
    workers.push(worker(w))
  }
  await Promise.all(workers)

  // Final save (in case last batch wasn't a multiple of 5)
  saveProgress(progress)

  // Summary
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 BATCH SUMMARY')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  ${type.toUpperCase()}s processed this batch: ${queue.length}`)
  console.log(`  ✅ Success:    ${stats.success}`)
  console.log(`  ⏭️  No URLs:    ${stats.noUrls}`)
  console.log(`  ❌ Failed:     ${stats.failed}`)
  console.log(`  📦 URLs stored: ${stats.stored}`)
  if (type === 'series') {
    console.log(`  📺 Episodes processed: ${stats.episodesProcessed}`)
  }
  console.log(`\n  Total ${type} progress: ${progress.processedIds[type].length}/${discovered.length}`)
  console.log(`  Total URLs stored all-time: ${progress.submittedCount}`)

  const remaining = discovered.length - progress.processedIds[type].length
  if (remaining > 0) {
    console.log(`\n➡️  ${remaining} ${type}(s) remaining for next batch.`)
    console.log(`   Run: node scripts/batch-crawl.mjs ${type}`)
  } else {
    console.log(`\n🎉 All ${discovered.length} ${type}s done!`)
  }

  console.log('\n🔍 Verify on the website:')
  console.log(`   ${RAILWAY_URL}`)
  console.log('\n═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
