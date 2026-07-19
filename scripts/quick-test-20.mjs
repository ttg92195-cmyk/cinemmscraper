/**
 * Quick test — crawl only 20 movies + 5 series to verify the full pipeline.
 *
 * Bro's plan: instead of running a 6-hour full crawl (which can fail if the
 * phone's data line drops at night), let's test with just 20 movies first.
 * If those 20 work end-to-end (URLs stored on Railway), we know the full
 * crawl will work too.
 *
 * This script:
 *   1. Loads discovered IDs from crawl-progress.json
 *   2. Takes the first 15 movies + 5 popular movies (Inception, etc.)
 *   3. Takes the first 5 series
 *   4. For each: calls getMovieSourcesAction with NUMBER id (the fix!)
 *   5. If access="direct", submits shortlinks to /api/manual-link
 *   6. Prints summary at the end
 *
 * Run on Termux (with Myanmar VPN on):
 *   node scripts/quick-test-20.mjs
 *
 * Expected runtime: ~5 minutes
 */

import fs from 'fs'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const CINEMM_ORIGIN = 'https://cinemm.com'

const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieSources: '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getEpisodeSources: '605765e4f6aa5ce95c001ef982ddc2a6ac62c60930',
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

// RSC parser
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

async function callAction(actionId, args) {
  const res = await fetch(`${CINEMM_ORIGIN}/`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    throw new Error(`cinemm.com HTTP ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  return { lines: parseRsc(text), raw: text }
}

async function searchCinemm(query, type) {
  const { lines } = await callAction(ACTIONS.search, [query, type])
  const raw = lines.get('1')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : (parsed.results || [])
  } catch {
    return []
  }
}

async function getMovieSources(id) {
  // CRITICAL: pass id as NUMBER, not string
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

async function getSeriesDetails(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  const { lines } = await callAction(ACTIONS.getSeriesDetails, [numericId, true])
  const raw = lines.get('1')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function getEpisodeSources(episodeId) {
  const numericId = typeof episodeId === 'string' ? parseInt(episodeId, 10) : episodeId
  const { lines } = await callAction(ACTIONS.getEpisodeSources, [numericId])
  const raw = lines.get('1')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

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
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    throw new Error(`Railway HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

console.log('═══════════════════════════════════════════════════════')
console.log('  Quick Test: 20 movies + 5 series')
console.log('═══════════════════════════════════════════════════════\n')
console.log(`Railway URL: ${RAILWAY_URL}\n`)

// Load progress
let progress = { discoveredIds: { movie: [], series: [] } }
try {
  progress = JSON.parse(fs.readFileSync('crawl-progress.json', 'utf8'))
} catch (e) {
  console.log('⚠️  No crawl-progress.json found. Will search for movies live.')
}

// ---------------------------------------------------------------
// Step 1: Build the test list — 20 movies
// ---------------------------------------------------------------
console.log('1️⃣  Building test list of 20 movies...\n')

const testMovies = []

// 15 from discovered IDs (first 15)
if (progress.discoveredIds?.movie?.length > 0) {
  const fromDiscovered = progress.discoveredIds.movie.slice(0, 15)
  console.log(`   Adding 15 movies from discovered IDs:`)
  fromDiscovered.forEach((id, i) => console.log(`     [${i + 1}] ${id}`))
  testMovies.push(...fromDiscovered)
}

// 5 popular movies via search
const popularQueries = ['inception', 'joker', 'avatar', 'titanic', 'avengers']
console.log(`\n   Searching for 5 popular movies...`)
for (const q of popularQueries) {
  try {
    const results = await searchCinemm(q, 'movie')
    if (results.length > 0) {
      const id = results[0].id
      const name = results[0].name
      if (!testMovies.includes(id)) {
        testMovies.push(id)
        console.log(`   ✅ "${q}" → ${name} (id: ${id})`)
      }
    }
  } catch (e) {
    console.log(`   ❌ "${q}" → ${e.message}`)
  }
  await sleep(800)
}

console.log(`\n   Total test movies: ${testMovies.length}\n`)

// ---------------------------------------------------------------
// Step 2: Build the test list — 5 series
// ---------------------------------------------------------------
console.log('2️⃣  Building test list of 5 series...\n')

const testSeries = []

if (progress.discoveredIds?.series?.length > 0) {
  testSeries.push(...progress.discoveredIds.series.slice(0, 5))
  console.log(`   Added ${testSeries.length} series from discovered IDs`)
} else {
  // Search for popular series
  const seriesQueries = ['breaking bad', 'game of thrones', 'stranger things', 'friends', 'lost']
  for (const q of seriesQueries) {
    try {
      const results = await searchCinemm(q, 'series')
      if (results.length > 0) {
        testSeries.push(results[0].id)
        console.log(`   ✅ "${q}" → ${results[0].name} (id: ${results[0].id})`)
      }
    } catch (e) {
      console.log(`   ❌ "${q}" → ${e.message}`)
    }
    await sleep(800)
  }
}

console.log(`\n   Total test series: ${testSeries.length}\n`)

// ---------------------------------------------------------------
// Step 3: Process movies
// ---------------------------------------------------------------
console.log('3️⃣  Processing movies...\n')
console.log('═══════════════════════════════════════════════════════\n')

let movieStats = { total: 0, success: 0, noUrls: 0, failed: 0, totalStored: 0 }

for (let i = 0; i < testMovies.length; i++) {
  const id = testMovies[i]
  movieStats.total++
  console.log(`🎬 [${i + 1}/${testMovies.length}] Movie ${id}`)

  try {
    const sources = await getMovieSources(id)
    if (!sources) {
      console.log(`   ⚠️  No response from getMovieSources`)
      movieStats.failed++
      continue
    }

    if (sources.access !== 'direct') {
      console.log(`   ⚠️  access="${sources.access}" (not Myanmar IP?)`)
      movieStats.noUrls++
      continue
    }

    const servers = sources.servers || []
    if (servers.length === 0) {
      console.log(`   ⏭️  No servers`)
      movieStats.noUrls++
      continue
    }

    // Submit shortlinks (cinemm.com returns playUrl shortlinks)
    const shortlinks = servers
      .map((s) => s.playUrl || s.url)
      .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')))

    if (shortlinks.length === 0) {
      console.log(`   ⏭️  No shortlinks in servers`)
      movieStats.noUrls++
      continue
    }

    console.log(`   📤 Submitting ${shortlinks.length} shortlinks to Railway...`)
    const result = await submitToRailway(id, 'movie', null, shortlinks)
    console.log(`   ✅ Stored: ${result.stored}/${shortlinks.length}, Failed: ${result.failed}`)
    if (result.results) {
      result.results.forEach((r, idx) => {
        if (r.stored) {
          console.log(`      [${idx + 1}] ${r.quality || '?'} | ${r.host || '?'} | ${r.fileName || '?'}`.slice(0, 150))
        } else {
          console.log(`      [${idx + 1}] ❌ ${r.error || 'failed'}`)
        }
      })
    }
    movieStats.success++
    movieStats.totalStored += result.stored || 0
  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message}`)
    movieStats.failed++
  }
  await sleep(1500)
}

// ---------------------------------------------------------------
// Step 4: Process series
// ---------------------------------------------------------------
console.log('\n4️⃣  Processing series...\n')
console.log('═══════════════════════════════════════════════════════\n')

let seriesStats = { total: 0, success: 0, episodesProcessed: 0, failed: 0, totalStored: 0 }

for (let i = 0; i < testSeries.length; i++) {
  const id = testSeries[i]
  seriesStats.total++
  console.log(`📺 [${i + 1}/${testSeries.length}] Series ${id}`)

  try {
    const details = await getSeriesDetails(id)
    if (!details) {
      console.log(`   ⚠️  No response`)
      seriesStats.failed++
      continue
    }

    const seasons = details.seasons || []
    if (seasons.length === 0) {
      console.log(`   ⏭️  No seasons`)
      seriesStats.failed++
      continue
    }

    console.log(`   📺 ${seasons.length} season(s)`)
    let seriesSuccess = false

    // Process only first 3 episodes per season for quick test
    for (const season of seasons) {
      const episodes = (season.episodes || []).slice(0, 3)
      console.log(`   Season ${season.season_number}: ${episodes.length} episode(s) to test`)
      for (const ep of episodes) {
        if (!ep.id) continue
        seriesStats.episodesProcessed++
        try {
          const epSources = await getEpisodeSources(ep.id)
          if (!epSources || epSources.access !== 'direct') {
            console.log(`      ⏭️  S${season.season_number}E${ep.episode_number}: access="${epSources?.access || 'null'}"`)
            await sleep(1000)
            continue
          }
          const servers = epSources.servers || []
          const shortlinks = servers
            .map((s) => s.playUrl || s.url)
            .filter(Boolean)
          if (shortlinks.length === 0) {
            console.log(`      ⏭️  S${season.season_number}E${ep.episode_number}: no URLs`)
            await sleep(1000)
            continue
          }
          const result = await submitToRailway(id, 'series', ep.id, shortlinks)
          console.log(`      ✅ S${season.season_number}E${ep.episode_number}: ${result.stored}/${shortlinks.length} stored`)
          seriesStats.totalStored += result.stored || 0
          seriesSuccess = true
        } catch (e) {
          console.log(`      ❌ S${season.season_number}E${ep.episode_number}: ${e.message}`)
        }
        await sleep(1000)
      }
      // Only test first season for quick test
      break
    }

    if (seriesSuccess) seriesStats.success++
  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message}`)
    seriesStats.failed++
  }
  await sleep(1500)
}

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log('\n═══════════════════════════════════════════════════════')
console.log('  📊 SUMMARY')
console.log('═══════════════════════════════════════════════════════\n')

console.log(`🎬 Movies:`)
console.log(`   Total tested    : ${movieStats.total}`)
console.log(`   ✅ Success      : ${movieStats.success}`)
console.log(`   ⏭️  No URLs      : ${movieStats.noUrls}`)
console.log(`   ❌ Failed       : ${movieStats.failed}`)
console.log(`   📦 URLs stored  : ${movieStats.totalStored}`)

console.log(`\n📺 Series:`)
console.log(`   Total tested    : ${seriesStats.total}`)
console.log(`   ✅ Success      : ${seriesStats.success}`)
console.log(`   📦 Episodes processed: ${seriesStats.episodesProcessed}`)
console.log(`   ❌ Failed       : ${seriesStats.failed}`)
console.log(`   📦 URLs stored  : ${seriesStats.totalStored}`)

console.log(`\n📦 Total URLs stored on Railway: ${movieStats.totalStored + seriesStats.totalStored}`)

if (movieStats.success + seriesStats.success > 0) {
  console.log('\n🎉🎉🎉 SUCCESS! The pipeline works end-to-end!')
  console.log('   ✅ Phone → cinemm.com → shortlinks → Railway → stored')
  console.log('\n   You can now run the full crawl with confidence:')
  console.log('   CRAWL_DELAY_MS=2000 node scripts/crawl-from-phone.mjs')
} else {
  console.log('\n⚠️  No URLs were stored. Check the errors above.')
  console.log('   Common causes:')
  console.log('   - VPN IP not Myanmar (look for access="telegram")')
  console.log('   - Network issues (look for HTTP 500/connection errors)')
  console.log('   - Railway server down (check https://cinemmscraper-production.up.railway.app)')
}

console.log('\n═══════════════════════════════════════════════════════')
