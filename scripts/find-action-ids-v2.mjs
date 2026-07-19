/**
 * Find current cinemm.com Server Action IDs — v2 (more thorough).
 *
 * v1 only searched for createServerReference() calls. v2 also searches for:
 *   - registerServerReference()
 *   - registerServerAction()
 *   - callServer()
 *   - "Next-Action" header usage patterns
 *   - Any 40+ char hex string in action-binding context
 *   - Common minified patterns like e("hex_id", binding)
 *
 * Also: downloads ALL bundles (v1 skipped some), including framework chunks
 * and the failing bundle (with retry).
 *
 * Usage:
 *   node scripts/find-action-ids-v2.mjs
 *
 * Output: list of all 40+ hex strings found in cinemm.com's JS bundles,
 * with context so we can identify which ones are action IDs.
 */

const CINEMM_ORIGIN = 'https://cinemm.com'

console.log('═══════════════════════════════════════════════════════')
console.log('  Finding cinemm.com Action IDs — v2 (thorough)')
console.log('═══════════════════════════════════════════════════════\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Step 1: Fetch homepage
console.log('1️⃣  Fetching cinemm.com homepage...')
const homeRes = await fetch(CINEMM_ORIGIN + '/', {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
  },
  signal: AbortSignal.timeout(15000),
})
if (!homeRes.ok) {
  console.error('❌ Homepage fetch failed:', homeRes.status, homeRes.statusText)
  process.exit(1)
}
const homeHtml = await homeRes.text()
console.log(`   ✅ Got ${(homeHtml.length / 1024).toFixed(1)}KB of HTML`)

// Step 2: Find ALL script URLs (be more permissive)
const scriptUrls = new Set()
// Pattern 1: <script src="...">
for (const m of homeHtml.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)) {
  scriptUrls.add(m[1])
}
// Pattern 2: "src":"/_next/static/..."  (in JSON inside __next_f chunks)
for (const m of homeHtml.matchAll(/["']src["']:\s*["'](\/[^"']+\.js[^"']*)["']/g)) {
  scriptUrls.add(m[1])
}
// Pattern 3: Look for chunks referenced in RSC data
for (const m of homeHtml.matchAll(/\/_next\/static\/[a-zA-Z0-9/_-]+\.js/g)) {
  scriptUrls.add(m[0])
}

const allUrls = Array.from(scriptUrls)
console.log(`\n2️⃣  Found ${allUrls.length} unique JS URLs:`)
for (const u of allUrls) console.log(`   - ${u}`)

// Step 3: Download each bundle (with retry) and search for hex IDs
console.log('\n3️⃣  Downloading and analyzing each bundle...\n')

const allFindings = [] // { url, hex, context }

for (let i = 0; i < allUrls.length; i++) {
  const url = allUrls[i]
  const fullUrl = url.startsWith('http') ? url : CINEMM_ORIGIN + url
  const basename = url.split('/').pop().split('?')[0]

  let js = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(fullUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {
        console.log(
          `   [${i + 1}/${allUrls.length}] ${basename} → HTTP ${res.status} (attempt ${attempt}/3)`,
        )
        if (attempt < 3) {
          await sleep(2000)
          continue
        }
        break
      }
      js = await res.text()
      break
    } catch (e) {
      console.log(
        `   [${i + 1}/${allUrls.length}] ${basename} → ERROR: ${e.message} (attempt ${attempt}/3)`,
      )
      if (attempt < 3) {
        await sleep(2000)
        continue
      }
      break
    }
  }

  if (!js) {
    console.log(`   [${i + 1}/${allUrls.length}] ❌ ${basename} — could not download`)
    continue
  }

  const sizeKB = (js.length / 1024).toFixed(1)
  console.log(`   [${i + 1}/${allUrls.length}] ✅ ${basename} (${sizeKB}KB)`)

  // Search for ALL 40+ char hex strings (action IDs are typically 40-50 hex chars)
  // Also include patterns like abc123def... of length 40+
  const hexPattern = /['"]([0-9a-f]{40,60})['"]/g
  let count = 0
  for (const m of js.matchAll(hexPattern)) {
    const hex = m[1]
    // Get surrounding context (60 chars before, 100 after)
    const start = Math.max(0, m.index - 60)
    const end = Math.min(js.length, m.index + hex.length + 2 + 100)
    const context = js.substring(start, end).replace(/\n/g, ' ')
    allFindings.push({ url: basename, hex, context })
    count++
  }
  if (count > 0) {
    console.log(`      Found ${count} hex string(s) of length 40+`)
  }

  // Also look for "Next-Action" string usage (which would indicate action ID handling)
  if (js.includes('Next-Action') || js.includes('next-action')) {
    console.log(`      ⚠️  Contains "Next-Action" reference (likely action binding file!)`)
  }

  // Look for registerServerReference, createServerReference (case-insensitive)
  const refPatterns = [
    /createServerReference/gi,
    /registerServerReference/gi,
    /registerServerAction/gi,
    /callServer/gi,
  ]
  for (const p of refPatterns) {
    const matches = js.match(p)
    if (matches && matches.length > 0) {
      console.log(`      📌 Contains "${matches[0]}" × ${matches.length}`)
    }
  }
}

// Step 4: Print unique hex strings
console.log('\n4️⃣  All 40+ hex strings found in cinemm.com bundles:')
console.log('═══════════════════════════════════════════════════════')

// Dedupe by hex value
const byHex = new Map()
for (const f of allFindings) {
  if (!byHex.has(f.hex)) byHex.set(f.hex, [])
  byHex.get(f.hex).push(f)
}

if (byHex.size === 0) {
  console.log('❌ No 40+ hex strings found in any bundle.')
  console.log('   This is unusual. cinemm.com may be using a different ID format.')
  console.log('   Possible next steps:')
  console.log('   - Inspect the bundles manually (look for base64, UUIDs, etc.)')
  console.log('   - Check if cinemm.com moved action IDs to a different bundle')
} else {
  console.log(`Found ${byHex.size} unique hex string(s):\n`)
  for (const [hex, occurrences] of byHex) {
    console.log(`   Hex: ${hex}`)
    console.log(`   Length: ${hex.length}`)
    console.log(`   Found in: ${occurrences.map((o) => o.url).join(', ')}`)
    console.log(`   Context:  ...${occurrences[0].context}...`)
    console.log('')
  }
}

// Step 5: Check known IDs
console.log('═══════════════════════════════════════════════════════')
console.log('5️⃣  Check if known IDs are present anywhere:')
console.log('═══════════════════════════════════════════════════════')
const known = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieServers: '60c193f3ef02d7353ffc530e701e0a0dd388f716f0',
  getMovieSources: '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getEpisodeServers: '705765e4f6aa5ce95c001ef982ddc2a6ac62c60930',
}

for (const [name, id] of Object.entries(known)) {
  const found = byHex.has(id)
  console.log(`   ${found ? '✅' : '❌'} ${name}: ${found ? 'STILL PRESENT' : 'MISSING'} (${id})`)
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done!')
console.log('═══════════════════════════════════════════════════════')
