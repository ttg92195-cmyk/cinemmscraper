/**
 * Test script — verifies that getMovieSourcesAction returns stream URLs
 * when called from Bro's phone (Myanmar IP via VPN).
 *
 * Run on Termux:
 *   node scripts/test-get-sources.mjs
 *
 * What it does:
 *   1. Searches cinemm.com for "inception" → gets a real movie ID
 *   2. Calls getMovieSourcesAction with that ID → sees if access="direct"
 *   3. If yes, prints the stream URLs
 *   4. Also tests with a discovered ID from crawl-progress.json
 */

import fs from 'fs'

const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieSources: '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
}

const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/x-component',
  'Content-Type': 'text/plain;charset=UTF-8',
  'Next-Router-State-Tree':
    '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  Origin: 'https://cinemm.com',
  Referer: 'https://cinemm.com/',
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

async function callAction(actionId, args) {
  const res = await fetch('https://cinemm.com/', {
    method: 'POST',
    headers: { ...headers, 'Next-Action': actionId },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    throw new Error(`cinemm.com HTTP ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  return { lines: parseRsc(text), raw: text, status: res.status }
}

console.log('═══════════════════════════════════════════════════════')
console.log('  Test: getMovieSourcesAction from your phone')
console.log('═══════════════════════════════════════════════════════\n')

// -------------------------------------------------------------
// Step 0: Show what was discovered by the crawler
// -------------------------------------------------------------
try {
  if (fs.existsSync('crawl-progress.json')) {
    const p = JSON.parse(fs.readFileSync('crawl-progress.json', 'utf8'))
    console.log('📦 Crawl progress so far:')
    console.log('   Movies discovered:', (p.discoveredIds?.movie || []).length)
    console.log('   Series discovered:', (p.discoveredIds?.series || []).length)
    console.log('   Movies processed: ', (p.processedIds?.movie || []).length)
    console.log('   Series processed: ', (p.processedIds?.series || []).length)
    console.log('   Submitted:        ', p.submittedCount || 0)
    console.log('   Failed:           ', p.failedCount || 0)
    if (p.discoveredIds?.movie?.length > 0) {
      console.log('   First 5 movie IDs:', p.discoveredIds.movie.slice(0, 5))
    }
    console.log('')
  } else {
    console.log('ℹ️  crawl-progress.json not found — skipping discovery check\n')
  }
} catch (e) {
  console.log('⚠️  Could not read crawl-progress.json:', e.message, '\n')
}

// -------------------------------------------------------------
// Step 1: Search "inception" to get a real movie ID
// -------------------------------------------------------------
console.log('🔍 Step 1: Search "inception" on cinemm.com...')
let realMovieId = null
try {
  const { lines, raw } = await callAction(ACTIONS.search, ['inception', 'movie'])
  const raw1 = lines.get('1')
  if (!raw1) {
    console.log('   ❌ No line "1:" in search response')
    console.log('   Raw response (first 800 chars):')
    console.log('   ' + raw.slice(0, 800).split('\n').join('\n   '))
  } else {
    const parsed = JSON.parse(raw1)
    const items = Array.isArray(parsed) ? parsed : (parsed.results || [])
    if (items.length > 0) {
      realMovieId = items[0].id
      console.log(`   ✅ Found ${items.length} results`)
      console.log(`   First result: "${items[0].name}" (id: ${realMovieId}, type: ${typeof realMovieId})`)
    } else {
      console.log('   ❌ Search returned 0 results')
    }
  }
} catch (e) {
  console.log('   ❌ Search failed:', e.message)
}
console.log('')

// -------------------------------------------------------------
// Step 2: Call getMovieSources with the real ID
// -------------------------------------------------------------
if (realMovieId !== null) {
  console.log(`🎬 Step 2: Call getMovieSourcesAction with movie ID ${realMovieId}...`)
  try {
    const { lines, raw, status } = await callAction(ACTIONS.getMovieSources, [Number(realMovieId)])
    console.log(`   HTTP status: ${status}`)
    const raw1 = lines.get('1')
    if (!raw1) {
      console.log('   ❌ No line "1:" in getMovieSources response')
      console.log('   Raw response (first 1500 chars):')
      console.log('   ' + raw.slice(0, 1500).split('\n').join('\n   '))
    } else {
      // Try to parse JSON
      try {
        const parsed = JSON.parse(raw1)
        console.log('   📋 Parsed response:')
        console.log('      access :', parsed.access)
        console.log('      ok     :', parsed.ok)
        console.log('      servers:', (parsed.servers || []).length, 'server(s)')
        if (parsed.servers && parsed.servers.length > 0) {
          console.log('   🎉 Stream URLs:')
          parsed.servers.forEach((s, idx) => {
            console.log(`      [${idx + 1}] ${s.name || '(no name)'} | ${s.size || '?'} | ${s.url || '(no url)'}`)
          })
        } else {
          console.log('   ⚠️  No servers returned')
          console.log('   Full parsed JSON:')
          console.log('   ' + JSON.stringify(parsed, null, 2).split('\n').join('\n   '))
        }
      } catch (parseErr) {
        console.log('   ⚠️  Response is not JSON. First 500 chars of line "1:":')
        console.log('   ' + raw1.slice(0, 500))
      }
    }
  } catch (e) {
    console.log('   ❌ getMovieSources failed:', e.message)
  }
  console.log('')
}

// -------------------------------------------------------------
// Step 3: Also test with a discovered ID from crawl-progress.json
// -------------------------------------------------------------
try {
  if (fs.existsSync('crawl-progress.json')) {
    const p = JSON.parse(fs.readFileSync('crawl-progress.json', 'utf8'))
    const discovered = p.discoveredIds?.movie || []
    if (discovered.length > 0) {
      const testId = discovered[0]
      console.log(`🎬 Step 3: Test with a discovered ID from crawler: ${testId}`)
      try {
        const { lines, raw, status } = await callAction(ACTIONS.getMovieSources, [Number(testId)])
        console.log(`   HTTP status: ${status}`)
        const raw1 = lines.get('1')
        if (!raw1) {
          console.log('   Raw response (first 800 chars):')
          console.log('   ' + raw.slice(0, 800).split('\n').join('\n   '))
        } else {
          try {
            const parsed = JSON.parse(raw1)
            console.log('   access :', parsed.access)
            console.log('   servers:', (parsed.servers || []).length)
            if (parsed.servers && parsed.servers.length > 0) {
              console.log('   🎉 Stream URLs:')
              parsed.servers.forEach((s, idx) => {
                console.log(`      [${idx + 1}] ${s.name || '(no name)'} | ${s.size || '?'} | ${s.url || '(no url)'}`)
              })
            } else {
              console.log('   Full parsed JSON:')
              console.log('   ' + JSON.stringify(parsed, null, 2).split('\n').join('\n   '))
            }
          } catch (parseErr) {
            console.log('   ⚠️  Response is not JSON. First 500 chars:')
            console.log('   ' + raw1.slice(0, 500))
          }
        }
      } catch (e) {
        console.log('   ❌ Failed:', e.message)
      }
    }
  }
} catch (e) {
  // ignore
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Test complete!')
console.log('═══════════════════════════════════════════════════════')
