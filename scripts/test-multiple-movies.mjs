/**
 * Test getMovieSourcesAction with MULTIPLE movie IDs.
 *
 * Hypothesis: maybe Inception's movie ID (1736115700307574) is stale
 * or returns 500 for that specific movie. Let's try multiple popular
 * movies to see if the issue is movie-specific or global.
 *
 * Run: node scripts/test-multiple-movies.mjs
 */

const CINEMM_ORIGIN = 'https://cinemm.com'

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/x-component',
  'Content-Type': 'text/plain;charset=UTF-8',
  'Next-Router-State-Tree':
    '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  Origin: CINEMM_ORIGIN,
  Referer: CINEMM_ORIGIN + '/',
}

const ACTIONS = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieSources: '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getMovieDetails: '60c193f3ef02d7353ffc530e701e0a0dd388f716f0',
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
  const res = await fetch(CINEMM_ORIGIN + '/', {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Next-Action': actionId },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  return { status: res.status, lines: parseRsc(text), raw: text }
}

async function searchCinemm(query, type) {
  const { status, lines } = await callAction(ACTIONS.search, [query, type])
  if (status !== 200) return []
  const raw = lines.get('1')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : (parsed.results || [])
  } catch {
    return []
  }
}

console.log('═══════════════════════════════════════════════════════')
console.log('  Testing multiple movies to find one that works')
console.log('═══════════════════════════════════════════════════════\n')

// Test queries — popular movies likely to be on cinemm.com
const testQueries = [
  'avatar',
  'titanic',
  'joker',
  'batman',
  'avengers',
  'spider',
  'inception',
  'interstellar',
  'parasite',
  'oppenheimer',
]

console.log('1️⃣  Searching for multiple popular movies...\n')
const allMovies = []
for (const q of testQueries) {
  try {
    const results = await searchCinemm(q, 'movie')
    console.log(`   "${q}" → ${results.length} results`)
    for (const r of results.slice(0, 2)) {
      allMovies.push({ id: r.id, name: r.name, query: q })
    }
  } catch (e) {
    console.log(`   "${q}" → ERROR: ${e.message}`)
  }
}

console.log(`\n   Collected ${allMovies.length} movie IDs to test\n`)

console.log('2️⃣  Calling getMovieSourcesAction for each...\n')
let successCount = 0
for (let i = 0; i < allMovies.length; i++) {
  const m = allMovies[i]
  console.log(`   [${i + 1}/${allMovies.length}] "${m.name}" (id: ${m.id}, query: "${m.query}")`)
  try {
    const { status, lines, raw } = await callAction(ACTIONS.getMovieSources, [Number(m.id)])
    if (status !== 200) {
      console.log(`      ❌ HTTP ${status}`)
      console.log(`      Body: ${raw.slice(0, 200)}`)
      continue
    }
    const raw1 = lines.get('1')
    if (!raw1) {
      console.log(`      ⚠️  No line "1:" in response`)
      continue
    }
    try {
      const parsed = JSON.parse(raw1)
      console.log(`      ok: ${parsed.ok}, access: ${parsed.access}, servers: ${(parsed.servers || []).length}`)
      if (parsed.access === 'direct' && (parsed.servers || []).length > 0) {
        successCount++
        console.log(`      🎉 SUCCESS! Stream URLs:`)
        parsed.servers.forEach((s, idx) => {
          console.log(`         [${idx + 1}] ${s.name || '?'} | ${s.size || '?'} | ${s.url || '?'}`
            .slice(0, 200))
        })
        if (successCount >= 3) {
          console.log(`\n   ✅ Found 3 successful movies — stopping early.`)
          break
        }
      } else if (parsed.message) {
        console.log(`      Message: ${parsed.message}`)
      }
    } catch (e) {
      console.log(`      ⚠️  Parse error: ${e.message}`)
      console.log(`      Raw line "1:": ${raw1.slice(0, 300)}`)
    }
  } catch (e) {
    console.log(`      ❌ ERROR: ${e.message}`)
  }
}

console.log('\n═══════════════════════════════════════════════════════')
console.log(`  Result: ${successCount}/${allMovies.length} movies returned direct URLs`)
console.log('═══════════════════════════════════════════════════════')

if (successCount === 0) {
  console.log('\n❌ NO movies returned access="direct" with URLs.')
  console.log('   This means cinemm.com does NOT see your IP as Myanmar.')
  console.log('   Even with VPN off, you may be using a foreign SIM or Wi-Fi.')
  console.log('\n   Possible solutions:')
  console.log('   1. Switch to a Myanmar SIM with mobile data (MPT/Ooredoo/Telenor/Mytel)')
  console.log('   2. Try a different VPN with REAL Myanmar servers')
  console.log('   3. Test from a friend\'s phone that has Myanmar SIM')
} else {
  console.log(`\n✅ ${successCount} movies worked! Your IP IS being treated as Myanmar.`)
  console.log('   The earlier "Inception" test may have been a fluke.')
  console.log('   You can proceed with the full crawl!')
  console.log('\n   Run:')
  console.log('   CRAWL_DELAY_MS=2000 node scripts/crawl-from-phone.mjs')
}
