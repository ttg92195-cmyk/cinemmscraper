/**
 * Find current cinemm.com Server Action IDs.
 *
 * cinemm.com periodically regenerates action IDs when they redeploy.
 * The IDs we hardcoded in src/lib/cinemm.ts may become stale.
 *
 * This script:
 *   1. Fetches cinemm.com's homepage HTML
 *   2. Finds the JS bundle URLs in <script src="...">
 *   3. Downloads each JS bundle
 *   4. Searches for createServerReference() calls
 *   5. Prints the action IDs + their function names
 *
 * Run on Termux (or anywhere with internet):
 *   node scripts/find-action-ids.mjs
 *
 * Compare output to ACTIONS in src/lib/cinemm.ts:
 *   search:              '60ffdc3034e91f62a96097852d58446360f909809e'
 *   getMovieServers:     '60c193f3ef02d7353ffc530e701e0a0dd388f716f0'
 *   getMovieSources:     '60f8eb1c1169207ffd4d06dd202d7580609061d2bb'
 *   getSeriesDetails:    '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f'
 *   getEpisodeServers:   '705765e4f6aa5ce95c001ef982ddc2a6ac62c60930'
 */

const CINEMM_ORIGIN = 'https://cinemm.com'

console.log('═══════════════════════════════════════════════════════')
console.log('  Finding current cinemm.com Server Action IDs')
console.log('═══════════════════════════════════════════════════════\n')

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

// Step 2: Find all JS bundle URLs
const scriptUrls = Array.from(
  homeHtml.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g),
).map((m) => m[1])
console.log(`\n2️⃣  Found ${scriptUrls.length} script tags`)

// Also look for script srcs in __next_f.push chunks (Next.js SPA)
const nextFSrcMatches = homeHtml.matchAll(/"src":"(\/_next\/static\/[^"]+\.js)"/g)
for (const m of nextFSrcMatches) {
  if (!scriptUrls.includes(m[1])) scriptUrls.push(m[1])
}
console.log(`   Total JS URLs to check: ${scriptUrls.length}`)

// Filter to only likely-candidate bundles (page bundles, not framework chunks)
const candidateUrls = scriptUrls.filter((u) => {
  // Skip common framework chunks
  if (/webpack|react|main|framework|polyfills|commons/.test(u)) return false
  // Include page-specific bundles
  if (/app\/|page-|_app|layout/.test(u)) return true
  // Include any chunk that might have action references
  return true
})
console.log(`   Candidate bundles: ${candidateUrls.length}`)

// Step 3: Download each JS bundle and search for createServerReference
console.log('\n3️⃣  Downloading bundles and searching for createServerReference...')

const allActionRefs = []
for (let i = 0; i < candidateUrls.length; i++) {
  const url = candidateUrls[i]
  const fullUrl = url.startsWith('http') ? url : CINEMM_ORIGIN + url
  try {
    const res = await fetch(fullUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      console.log(`   [${i + 1}/${candidateUrls.length}] SKIP ${url} (HTTP ${res.status})`)
      continue
    }
    const js = await res.text()
    const sizeKB = (js.length / 1024).toFixed(1)

    // Pattern: createServerReference("hex_id", ..., "functionName")
    // Also: registerServerReference(..., "functionName", ...)
    // Also: e("hex_id", binding) — short minified forms
    const patterns = [
      /createServerReference\(\s*["']([0-9a-f]{40,})["']\s*,\s*[^,]+,\s*["']([^"']+)["']/g,
      /registerServerReference\([^,]+,\s*["']([0-9a-f]{40,})["']\s*,\s*["']([^"']+)["']/g,
      /createServerReference\(\s*["']([0-9a-f]{40,})["']\s*,\s*[^)]+["']([^"']+)["']/g,
    ]

    let found = 0
    for (const pattern of patterns) {
      for (const m of js.matchAll(pattern)) {
        const id = m[1]
        const name = m[2]
        allActionRefs.push({ id, name, source: url })
        found++
      }
    }

    // Also look for "createServerReference" calls with just ID (no name)
    // Pattern: createServerReference("hex_id", ...)
    if (found === 0) {
      const anonPattern = /createServerReference\(\s*["']([0-9a-f]{40,})["']/g
      for (const m of js.matchAll(anonPattern)) {
        // Look at surrounding context to find the variable name
        const id = m[1]
        const startIdx = Math.max(0, m.index - 200)
        const endIdx = Math.min(js.length, m.index + 200)
        const context = js.substring(startIdx, endIdx)
        // Try to find a function name nearby (variable assignment like: var foo = createServerReference...)
        const nameMatch = context.match(/var\s+(\w+)\s*=\s*createServerReference|(\w+)\s*=\s*createServerReference|createServerReference\([^,]+,\s*[^,]+,\s*["']([^"']+)["']/)
        const name = nameMatch?.[3] || nameMatch?.[1] || nameMatch?.[2] || '(anonymous)'
        allActionRefs.push({ id, name, source: url })
        found++
      }
    }

    console.log(
      `   [${i + 1}/${candidateUrls.length}] ${sizeKB}KB ${url.split('/').pop()} → ${found} action(s)`,
    )
  } catch (e) {
    console.log(`   [${i + 1}/${candidateUrls.length}] ERROR ${url.split('/').pop()}: ${e.message}`)
  }
}

// Step 4: Print results
console.log('\n4️⃣  Found Server Action references:')
console.log('═══════════════════════════════════════════════════════')
if (allActionRefs.length === 0) {
  console.log('❌ No createServerReference calls found!')
  console.log('   cinemm.com may have changed their build setup.')
  console.log('   Manual check needed: open cinemm.com in browser,')
  console.log('   DevTools → Network → click a movie → look for POST')
  console.log('   request to cinemm.com with "Next-Action" header.')
} else {
  // Group by name (deduplicate)
  const byName = new Map()
  for (const ref of allActionRefs) {
    if (!byName.has(ref.name)) byName.set(ref.name, ref)
  }
  for (const [name, ref] of byName) {
    console.log(`   ${name}`)
    console.log(`     ID    : ${ref.id}`)
    console.log(`     Source: ${ref.source}`)
    console.log('')
  }
}

// Step 5: Compare to known IDs
console.log('═══════════════════════════════════════════════════════')
console.log('5️⃣  Comparison to known IDs in src/lib/cinemm.ts:')
console.log('═══════════════════════════════════════════════════════')
const known = {
  search: '60ffdc3034e91f62a96097852d58446360f909809e',
  getMovieServers: '60c193f3ef02d7353ffc530e701e0a0dd388f716f0',
  getMovieSources: '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
  getSeriesDetails: '40b9e9dc40d8b3b16f4984f373bb59cf57515e283f',
  getEpisodeServers: '705765e4f6aa5ce95c001ef982ddc2a6ac62c60930',
}

for (const [key, oldId] of Object.entries(known)) {
  // Look for action whose name contains key (case-insensitive)
  const match = allActionRefs.find(
    (r) =>
      r.name.toLowerCase().includes(key.toLowerCase().replace('getmovie', 'getMovie').replace('getseries', 'getSeries').replace('getepisode', 'getEpisode')) ||
      r.name.toLowerCase().includes(key.toLowerCase().replace('servers', 'sources').replace('servers', 'sources')),
  )
  if (match) {
    if (match.id === oldId) {
      console.log(`   ✅ ${key}: ID unchanged (${oldId})`)
    } else {
      console.log(`   ⚠️  ${key}: ID CHANGED!`)
      console.log(`      Old: ${oldId}`)
      console.log(`      New: ${match.id}  (name: ${match.name})`)
    }
  } else {
    console.log(`   ❓ ${key}: not found in current bundle (old ID: ${oldId})`)
  }
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done!')
console.log('═══════════════════════════════════════════════════════')
