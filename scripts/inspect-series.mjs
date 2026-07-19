/**
 * Inspect series details response format.
 *
 * Series processing fails because season_number and episode_number are
 * undefined in our parsed response. Let's print the raw response to see
 * the actual field names cinemm.com uses.
 *
 * Run: node scripts/inspect-series.mjs
 */

import fs from 'fs'

const CINEMM_ORIGIN = 'https://cinemm.com'
const ACTIONS = {
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

console.log('═══════════════════════════════════════════════════════')
console.log('  Inspect Series Details Response Format')
console.log('═══════════════════════════════════════════════════════\n')

// Load discovered series IDs
let seriesIds = []
try {
  const p = JSON.parse(fs.readFileSync('crawl-progress.json', 'utf8'))
  seriesIds = p.discoveredIds?.series || []
  console.log(`Found ${seriesIds.length} discovered series IDs`)
} catch {
  console.log('⚠️  No crawl-progress.json')
}

if (seriesIds.length === 0) {
  console.log('No series to test. Exiting.')
  process.exit(0)
}

const testId = seriesIds[0]
console.log(`\nTesting with first series ID: ${testId}\n`)

// 1. Get series details
console.log('1️⃣  Calling getSeriesDetailsAction...')
const numericId = Number(testId)
console.log(`   Args: [${numericId}, true]`)

const res = await fetch(`${CINEMM_ORIGIN}/`, {
  method: 'POST',
  headers: { ...COMMON_HEADERS, 'Next-Action': ACTIONS.getSeriesDetails },
  body: JSON.stringify([numericId, true]),
  signal: AbortSignal.timeout(20000),
})
console.log(`   HTTP Status: ${res.status}`)

const text = await res.text()
const lines = parseRsc(text)
const raw1 = lines.get('1')

if (!raw1) {
  console.log('   ❌ No line "1:" in response')
  console.log('   Raw response (first 2000 chars):')
  console.log(text.slice(0, 2000))
  process.exit(0)
}

console.log(`   Response length: ${raw1.length} chars\n`)

// Try to parse
try {
  const parsed = JSON.parse(raw1)
  console.log('2️⃣  Parsed response keys:')
  console.log('   ', Object.keys(parsed).join(', '))

  console.log('\n3️⃣  Top-level values:')
  for (const [k, v] of Object.entries(parsed)) {
    const vStr = typeof v === 'string' ? `"${v.slice(0, 80)}"` :
                 Array.isArray(v) ? `[Array len=${v.length}]` :
                 typeof v === 'object' && v !== null ? `{Object keys=${Object.keys(v).join(',')}}` :
                 String(v)
    console.log(`   ${k}: ${vStr}`)
  }

  // Find seasons — could be under 'seasons' or nested somewhere
  console.log('\n4️⃣  Looking for seasons data...')
  let seasons = null
  if (Array.isArray(parsed.seasons)) {
    seasons = parsed.seasons
    console.log(`   Found at parsed.seasons (length: ${seasons.length})`)
  } else if (parsed.data?.seasons) {
    seasons = parsed.data.seasons
    console.log(`   Found at parsed.data.seasons (length: ${seasons.length})`)
  } else if (parsed.series?.seasons) {
    seasons = parsed.series.seasons
    console.log(`   Found at parsed.series.seasons (length: ${seasons.length})`)
  } else {
    // Search recursively
    const findSeasons = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return null
      if (Array.isArray(obj) && obj.length > 0 && obj[0]?.episodes) {
        return { seasons: obj, path }
      }
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') {
          const result = findSeasons(v, path ? `${path}.${k}` : k)
          if (result) return result
        }
      }
      return null
    }
    const found = findSeasons(parsed)
    if (found) {
      seasons = found.seasons
      console.log(`   Found at parsed.${found.path} (length: ${seasons.length})`)
    } else {
      console.log('   ❌ Could not find seasons array')
      console.log('\n   Full response (first 3000 chars):')
      console.log(raw1.slice(0, 3000))
      process.exit(0)
    }
  }

  // Inspect first season
  console.log('\n5️⃣  First season keys:')
  if (seasons.length > 0) {
    const s0 = seasons[0]
    console.log(`   ${Object.keys(s0).join(', ')}`)
    console.log('\n   First season values:')
    for (const [k, v] of Object.entries(s0)) {
      const vStr = typeof v === 'string' ? `"${v.slice(0, 80)}"` :
                   Array.isArray(v) ? `[Array len=${v.length}]` :
                   typeof v === 'object' && v !== null ? `{Object}` :
                   String(v)
      console.log(`   ${k}: ${vStr}`)
    }

    // Inspect first episode
    if (s0.episodes && s0.episodes.length > 0) {
      const e0 = s0.episodes[0]
      console.log('\n6️⃣  First episode keys:')
      console.log(`   ${Object.keys(e0).join(', ')}`)
      console.log('\n   First episode values:')
      for (const [k, v] of Object.entries(e0)) {
        const vStr = typeof v === 'string' ? `"${v.slice(0, 80)}"` :
                     Array.isArray(v) ? `[Array len=${v.length}]` :
                     typeof v === 'object' && v !== null ? `{Object}` :
                     String(v)
        console.log(`   ${k}: ${vStr}`)
      }

      // Test calling getEpisodeSourcesAction with proper args
      const epId = e0.id
      const epNum = e0.episode_number ?? e0.episodeNumber ?? e0.episode_num ?? e0.number ?? 1
      console.log(`\n7️⃣  Test getEpisodeSourcesAction with proper args:`)
      console.log(`   episodeId: ${epId} (type: ${typeof epId})`)
      console.log(`   episodeNum: ${epNum} (type: ${typeof epNum})`)

      const epRes = await fetch(`${CINEMM_ORIGIN}/`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Next-Action': ACTIONS.getEpisodeSources },
        body: JSON.stringify([Number(epId), Number(epNum)]),
        signal: AbortSignal.timeout(20000),
      })
      console.log(`   HTTP Status: ${epRes.status}`)
      const epText = await epRes.text()
      const epLines = parseRsc(epText)
      const epRaw1 = epLines.get('1')
      if (epRaw1) {
        try {
          const epParsed = JSON.parse(epRaw1)
          console.log('   Response:')
          console.log(`     ok     : ${epParsed.ok}`)
          console.log(`     access : ${epParsed.access}`)
          console.log(`     servers: ${(epParsed.servers || []).length}`)
          if (epParsed.servers && epParsed.servers.length > 0) {
            console.log('   🎉 Stream URLs:')
            epParsed.servers.forEach((s, idx) => {
              console.log(`     [${idx + 1}] ${s.name} | ${s.quality || '?'} | ${s.playUrl || s.url || '?'}`.slice(0, 200))
            })
          } else if (epParsed.message) {
            console.log(`     message: ${epParsed.message}`)
          }
        } catch (e) {
          console.log('   ⚠️  Parse error:', e.message)
          console.log('   Raw (first 500):', epRaw1.slice(0, 500))
        }
      } else {
        console.log('   ❌ No line "1:"')
        console.log('   Raw (first 500):', epText.slice(0, 500))
      }
    }
  }
} catch (e) {
  console.log('❌ JSON parse error:', e.message)
  console.log('Raw line "1:" (first 1000 chars):')
  console.log(raw1.slice(0, 1000))
}

console.log('\n═══════════════════════════════════════════════════════')
