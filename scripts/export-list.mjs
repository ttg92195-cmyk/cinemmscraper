/**
 * Export a human-readable list of discovered movies + series with names.
 *
 * Reads crawl-progress.json and:
 *   1. For each discovered series ID, checks if we have a cached name
 *      (from previous processing). If yes, uses it.
 *      If no, fetches series details from cinemm.com (just one HTTP call
 *      per series — much cheaper than full processing).
 *   2. Same for movies — uses cached name if available, otherwise tries
 *      to fetch it via search.
 *   3. Writes two files:
 *      - series-list.txt  — ID | Name | Year | Seasons | Episodes | Status
 *      - movie-list.txt   — ID | Name | Status
 *   4. Also writes series-list.json / movie-list.json for programmatic use.
 *
 * Usage:
 *   node scripts/export-list.mjs               # all discovered items
 *   node scripts/export-list.mjs series        # only series
 *   node scripts/export-list.mjs movie         # only movies
 *   node scripts/export-list.mjs series 50     # only first 50 series
 *
 * Output files are written to current directory.
 */

import fs from 'fs'

const CINEMM_ORIGIN = 'https://cinemm.com'
const PROGRESS_FILE = process.env.CRAWL_PROGRESS || './crawl-progress.json'

const ACTIONS = {
  search:              '60ffdc3034e91f62a96097852d58446360f909809e',
  getSeriesDetails:    '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getMovieSources:     '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
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
      try {
        return JSON.parse(trimmed)
      } catch {}
    }
    searchFrom = pos - 1
  }
}

async function callAction(actionId, args) {
  const res = await fetch(`${CINEMM_ORIGIN}/`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const text = await res.text()
  return parseRscLine1(text)
}

async function getSeriesDetails(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  try {
    const res = await fetch(`${CINEMM_ORIGIN}/`, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'Next-Action': ACTIONS.getSeriesDetails },
      body: JSON.stringify([numericId, true]),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return null
    const text = await res.text()

    // Strategy: scan the entire response for JSON objects that look like
    // {ok:true, seasons:[...]} or {ok:true, overview:...}.
    // The RSC format may embed this JSON at the end of a multi-line text
    // chunk (e.g. after overview text on lines 1-20, the JSON appears on
    // line 21 with prefix "1:{...}").
    // We use a regex to find ALL JSON objects in the response and pick
    // the one that has the seasons/ok keys.
    const jsonRegex = /\{[^{}]*"ok"\s*:\s*(?:true|false)[^{}]*\}/g
    let match
    let parsed = null
    while ((match = jsonRegex.exec(text)) !== null) {
      try {
        const candidate = JSON.parse(match[0])
        if (candidate && (candidate.ok !== undefined || candidate.seasons)) {
          // Check if it has seasons (we want the FULL JSON, not just first {ok:true,...})
          if (candidate.seasons && Array.isArray(candidate.seasons)) {
            parsed = candidate
            break
          }
          // If first match doesn't have seasons, keep searching — the regex
          // above only matches up to first close brace. For nested objects
          // we need a different approach.
        }
      } catch {}
    }

    // If simple regex didn't find it (because seasons is a nested array),
    // try a more aggressive approach: find any line starting with N:{...}
    // and try to parse the longest JSON we can extract from it.
    if (!parsed) {
      for (const line of text.split('\n')) {
        // Look for lines that contain "seasons" + "ok"
        if (!line.includes('"seasons"') || !line.includes('"ok"')) continue
        // Extract the JSON portion — find first { and last }
        const firstBrace = line.indexOf('{')
        if (firstBrace < 0) continue
        // Find matching close brace by counting nesting
        let depth = 0
        let end = -1
        for (let i = firstBrace; i < line.length; i++) {
          if (line[i] === '{') depth++
          else if (line[i] === '}') {
            depth--
            if (depth === 0) {
              end = i
              break
            }
          }
        }
        if (end < 0) continue
        const jsonStr = line.substring(firstBrace, end + 1)
        try {
          const candidate = JSON.parse(jsonStr)
          if (candidate?.seasons) {
            parsed = candidate
            break
          }
        } catch {}
      }
    }

    if (!parsed) return null

    // Resolve overview $N reference using the lines map (multi-line text chunks)
    if (typeof parsed.overview === 'string' && parsed.overview.startsWith('$')) {
      // Build line map for resolving $N reference
      const linesMap = new Map()
      const textSplit = text.split('\n')
      let i = 0
      while (i < textSplit.length) {
        const line = textSplit[i]
        const m = line.match(/^([0-9a-f]+):(T[0-9a-f]+,)?/)
        if (!m) {
          i++
          continue
        }
        const lineId = m[1]
        const isText = !!m[2]
        let payload = line.substring(m[0].length)
        if (isText) {
          i++
          while (i < textSplit.length) {
            const next = textSplit[i]
            // Don't consume next line if it starts a new RSC chunk
            if (/^[0-9a-f]+:/.test(next)) break
            payload += '\n' + next
            i++
          }
        } else {
          i++
        }
        if (!linesMap.has(lineId)) {
          linesMap.set(lineId, { isText, payload })
        }
      }
      const refId = parsed.overview.substring(1)
      const ref = linesMap.get(refId)
      if (ref) {
        const cleaned = ref.payload.replace(/^T[0-9a-f]+,/, '')
        parsed.overview = cleaned
      }
    }
    return parsed
  } catch {
    return null
  }
}

async function getMovieSources(id) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id
  try {
    return await callAction(ACTIONS.getMovieSources, [numericId])
  } catch {
    return null
  }
}

// Search by movie/series ID is not directly possible — we'd need to know
// the name first. So for movies without a cached name, we try to extract
// a name from the getMovieSources response (file names contain titles).
function extractMovieNameFromSources(sources) {
  if (!sources?.servers?.length) return null
  const firstFileName = sources.servers[0]?.filename || sources.servers[0]?.name || ''
  if (!firstFileName) return null
  return firstFileName
    .replace(/\.(mkv|mp4|avi|mov|webm).*$/i, '')
    .replace(/\b(8K|4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDTV|HEVC|AVC|CM|MPK|MW|YK|TRUE|Edit)\b.*$/i, '')
    .replace(/[._]/g, ' ')
    .trim()
}

// Try to extract a series name from its overview text.
// Overview often starts with the series name in quotes or after intro phrases.
// Examples seen:
//   "ထုတ်လွှင့်ခဲ့ ဖူးသမျှ TV series တွေထဲက အကောင်းဆုံး TV series တခုကိုပြောပါဆိုရင် Breaking Bad..."
//   "ဒစ္စနေးရဲ့ မာဗယ်စကြဝဠာထဲက မှော်စီးရီးအသစ်တစ်ခု... အဓိက မင်းသမီးကတော့ စုန်းမကြီး အက်ဂ်သာ..."
//
// This is hard to do reliably. Instead, we use a different strategy:
// we just label the series with the first ~50 chars of the overview
// so Bro can recognize it.
function extractSeriesNameFromOverview(overview) {
  if (!overview) return null
  // Strip leading RSC markers like "$2"
  const cleaned = overview.replace(/^\$\d+\s*/, '').trim()
  if (cleaned.length < 5) return null
  // Take first 80 chars as a "preview" name
  const preview = cleaned.substring(0, 80).trim()
  return preview + (cleaned.length > 80 ? '...' : '')
}

// Try to find a name for a series ID via search by ID prefix.
// cinemm.com's searchAction takes a query string and type. We try
// the ID as a query — if it matches the ID, we get the name.
async function lookupNameViaSearch(id, type) {
  try {
    const parsed = await callAction(ACTIONS.search, [String(id), type])
    const items = parsed?.results || parsed?.items || []
    // Find exact ID match
    const match = items.find((it) => String(it.id) === String(id))
    if (match) {
      return { name: match.name || match.title || '', year: match.year || '', poster: match.poster || '' }
    }
    return null
  } catch {
    return null
  }
}

// ---------- Main ----------
async function main() {
  const onlyType = process.argv[2] // 'series' | 'movie' | undefined (both)
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 0 // 0 = no limit

  if (onlyType && onlyType !== 'series' && onlyType !== 'movie') {
    console.log('Usage:')
    console.log('  node scripts/export-list.mjs               # all discovered items')
    console.log('  node scripts/export-list.mjs series        # only series')
    console.log('  node scripts/export-list.mjs movie         # only movies')
    console.log('  node scripts/export-list.mjs series 50     # only first 50 series')
    process.exit(0)
  }

  let progress
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`❌ ${PROGRESS_FILE} not found. Run discovery first:`)
      console.error(`   node scripts/crawl-from-phone.mjs`)
      process.exit(1)
    }
    console.error(`❌ ${PROGRESS_FILE} is corrupt: ${e.message}`)
    console.error(`   Backing up to ${PROGRESS_FILE}.corrupt-${Date.now()} and aborting.`)
    try {
      const raw = fs.readFileSync(PROGRESS_FILE, 'utf8')
      fs.writeFileSync(`${PROGRESS_FILE}.corrupt-${Date.now()}`, raw)
    } catch {}
    process.exit(1)
  }
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Export discovered items list with names')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`Movies:    discovered ${progress.discoveredIds?.movie?.length || 0}, processed ${progress.processedIds?.movie?.length || 0}`)
  console.log(`Series:    discovered ${progress.discoveredIds?.series?.length || 0}, processed ${progress.processedIds?.series?.length || 0}`)
  console.log(`URLs stored: ${progress.submittedCount || 0}`)
  console.log('')

  const types = onlyType ? [onlyType] : ['movie', 'series']

  for (const type of types) {
    const discovered = progress.discoveredIds?.[type] || []
    const processed = new Set(progress.processedIds?.[type] || [])
    const cachedNames = progress[`${type}Names`] || {}
    const items = limit > 0 ? discovered.slice(0, limit) : discovered

    console.log(`\n>>> Processing ${items.length} ${type} IDs (delay ${DELAY_MS}ms)...\n`)

    const results = []
    let idx = 0
    for (const id of items) {
      idx++
      const isProcessed = processed.has(id)
      const cachedName = cachedNames[id]

      let name = cachedName || '(unknown)'
      let year = ''
      let seasons = 0
      let episodes = 0

      if (!cachedName) {
        // Need to fetch — call cinemm.com
        // Strategy: try search by ID first (gets name + year + poster).
        // For series, also call getSeriesDetails for season/episode counts.
        if (type === 'series') {
          // First try search to get the name (rarely works for series IDs
          // since cinemm.com's search is name-based, not ID-based)
          const searchResult = await lookupNameViaSearch(id, 'series')
          if (searchResult?.name) {
            name = searchResult.name
            year = searchResult.year
          }
          // Then fetch details for season/episode counts
          const details = await getSeriesDetails(id)
          if (details) {
            seasons = details.seasons?.length || 0
            episodes = details.seasons?.reduce((s, sn) => s + (sn.episodes?.length || 0), 0) || 0
            // If no name yet, try to extract from overview (preview)
            if (name === '(unknown)' && details.overview) {
              const preview = extractSeriesNameFromOverview(details.overview)
              if (preview) name = preview
            }
          }
        } else {
          // Movie — try search by ID first
          const searchResult = await lookupNameViaSearch(id, 'movie')
          if (searchResult?.name) {
            name = searchResult.name
            year = searchResult.year
          } else {
            // Fall back to extracting from getMovieSources file names
            const sources = await getMovieSources(id)
            if (sources?.servers?.length) {
              const extracted = extractMovieNameFromSources(sources)
              if (extracted) name = extracted
            }
          }
        }
        // Save name back to cache for future runs
        if (name !== '(unknown)') {
          cachedNames[id] = name
        }
        await sleep(DELAY_MS)
      } else if (type === 'series') {
        // For cached series, also try to fetch seasons/episodes count
        const details = await getSeriesDetails(id)
        if (details) {
          seasons = details.seasons?.length || 0
          episodes = details.seasons?.reduce((s, sn) => s + (sn.episodes?.length || 0), 0) || 0
        }
        await sleep(DELAY_MS)
      }

      const status = isProcessed ? '✅ processed' : '⏳ pending'
      const line = type === 'series'
        ? `${id} | ${name} | ${seasons}S ${episodes}E | ${status}`
        : `${id} | ${name} | ${status}`

      console.log(`  [${idx}/${items.length}] ${line}`)
      results.push({ id, name, year, seasons, episodes, processed: isProcessed })
    }

    // Save files
    const txtFile = `${type}-list.txt`
    const jsonFile = `${type}-list.json`
    const txtContent = results.map((r) =>
      type === 'series'
        ? `${r.id} | ${r.name} | ${r.seasons}S ${r.episodes}E | ${r.processed ? '✅ processed' : '⏳ pending'}`
        : `${r.id} | ${r.name} | ${r.processed ? '✅ processed' : '⏳ pending'}`,
    ).join('\n')

    fs.writeFileSync(txtFile, txtContent + '\n')
    fs.writeFileSync(jsonFile, JSON.stringify(results, null, 2))
    console.log(`\n✅ Wrote ${txtFile} (${results.length} entries)`)
    console.log(`✅ Wrote ${jsonFile}`)

    // Save updated names back to progress file
    progress[`${type}Names`] = cachedNames
  }

  // Persist updated name caches (atomic write with backup)
  try {
    try {
      const current = fs.readFileSync(PROGRESS_FILE, 'utf8')
      fs.writeFileSync(`${PROGRESS_FILE}.bak`, current)
    } catch {}
    const tmpPath = `${PROGRESS_FILE}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(progress, null, 2))
    fs.renameSync(tmpPath, PROGRESS_FILE)
  } catch (e) {
    console.error(`⚠️  Failed to save progress: ${e.message}`)
  }
  console.log(`\n✅ Updated name caches in ${PROGRESS_FILE}`)
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  Done!')
  console.log('═══════════════════════════════════════════════════════')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
