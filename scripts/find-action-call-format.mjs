/**
 * Find how getMovieSourcesAction is called in cinemm.com's client code.
 *
 * We confirmed the action ID is correct, but the call still returns 500.
 * This script downloads the page bundle and looks for where the action
 * is actually invoked — that tells us the exact argument format cinemm.com
 * expects.
 *
 * Run on Termux:
 *   node scripts/find-action-call-format.mjs
 */

console.log('═══════════════════════════════════════════════════════')
console.log('  Finding how getMovieSourcesAction is called')
console.log('═══════════════════════════════════════════════════════\n')

// The page bundle that contains the action references
const PAGE_BUNDLE_URL = 'https://cinemm.com/_next/static/chunks/app/page-25c30ba841a9da84.js'

console.log(`1️⃣  Downloading page bundle...`)
console.log(`   ${PAGE_BUNDLE_URL}`)

const res = await fetch(PAGE_BUNDLE_URL, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
  },
  signal: AbortSignal.timeout(20000),
})
if (!res.ok) {
  console.error(`❌ Failed: HTTP ${res.status}`)
  process.exit(1)
}
const js = await res.text()
console.log(`   ✅ Downloaded ${(js.length / 1024).toFixed(1)}KB\n`)

// Step 2: Find variable names bound to each action
console.log('2️⃣  Finding action variable bindings...')
console.log('   Looking for patterns like: let X = createServerReference("...", ..., "actionName")\n')

// Pattern: varName = (0,y.createServerReference)("hex", ..., "actionName")
const bindingPattern = /(\w+)\s*=\s*\(0,\w+\.createServerReference\)\s*\(\s*["']([0-9a-f]{40,})["']\s*,\s*[^,)]+\s*,\s*[^,)]+\s*,\s*[^,)]+\s*,\s*["']([^"']+)["']\s*\)/g

const bindings = new Map() // actionName -> { varName, hex }
for (const m of js.matchAll(bindingPattern)) {
  const varName = m[1]
  const hex = m[2]
  const actionName = m[3]
  bindings.set(actionName, { varName, hex })
  console.log(`   ${actionName}`)
  console.log(`     Variable: ${varName}`)
  console.log(`     Hex:      ${hex}`)
}

if (bindings.size === 0) {
  console.log('   ⚠️  No bindings found with strict pattern. Trying relaxed...')
  // Relaxed: just match createServerReference + name
  const relaxed = /(\w+)\s*=\s*\(0,\w+\.createServerReference\)\([^)]*["']([^"']{15,})["']\s*\)/g
  for (const m of js.matchAll(relaxed)) {
    console.log(`   Found: var=${m[1]}, lastString=${m[2]}`)
  }
}

// Step 3: For each action, find where its variable is CALLED
console.log('\n3️⃣  Finding where each action is called...')
console.log('   Looking for patterns like: await X(args) where X is the action variable\n')

for (const [actionName, { varName }] of bindings) {
  console.log(`   ─── ${actionName} (variable: ${varName}) ───`)

  // Find all places where this variable is invoked.
  // Common patterns:
  //   await X(args)              → direct call
  //   await (0,X)(args)          → module-style call
  //   X(args)                    → sync call
  //   X.call(null, args)         → explicit call
  const callPatterns = [
    new RegExp(`await\\s+\\(0,\\s*${varName}\\)\\s*\\(([^)]{0,500})\\)`, 'g'),
    new RegExp(`await\\s+${varName}\\s*\\(([^)]{0,500})\\)`, 'g'),
    new RegExp(`\\b${varName}\\s*\\(([^)]{0,500})\\)`, 'g'),
  ]

  let found = 0
  for (const pattern of callPatterns) {
    for (const m of js.matchAll(pattern)) {
      const args = m[1]
      // Get context (200 chars before the call)
      const start = Math.max(0, m.index - 200)
      const contextBefore = js.substring(start, m.index).replace(/\s+/g, ' ').slice(-150)
      console.log(`      Call ${found + 1}:`)
      console.log(`        Args: ${args}`)
      console.log(`        Before: ...${contextBefore}`)
      found++
      if (found >= 5) break // limit to 5 per action
    }
    if (found >= 5) break
  }
  if (found === 0) {
    console.log(`      (no direct calls found — action may be passed as callback)`)
  }
  console.log('')
}

// Step 4: Also look for any callServer() invocations (alternative pattern)
console.log('4️⃣  Looking for callServer() invocations with action IDs...')
const callServerPattern = /callServer\s*\(\s*["']([0-9a-f]{40,})["']\s*,\s*([^)]{0,500})\)/g
let callServerCount = 0
for (const m of js.matchAll(callServerPattern)) {
  console.log(`   callServer("${m[1].slice(0, 20)}...", ${m[2]})`)
  callServerCount++
}
if (callServerCount === 0) {
  console.log('   (no direct callServer invocations with hex IDs)')
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done! Use the args above to fix the crawler.')
console.log('═══════════════════════════════════════════════════════')
