/**
 * Mimic a real browser's request to getMovieSourcesAction.
 *
 * Previous tests failed with HTTP 500, even though the same action works
 * when Bro clicks "Show Sources" in cinemm.com's actual website (with VPN).
 *
 * This means our script is missing something the browser sends:
 *   - Maybe a Cookie (user_uuid, session token, Cloudflare cf_*)
 *   - Maybe a header (Sec-Fetch-*, RSC header, Accept-Language)
 *   - Maybe a different User-Agent
 *
 * This script tries 4 progressively more "browser-like" request profiles:
 *   Profile A: Just the bare minimum (what we currently send)
 *   Profile B: Add Sec-Fetch-* headers + Accept-Language
 *   Profile C: Add common Cloudflare cookies (cf_clearance, __cf_bm)
 *   Profile D: Add a Cloudflare clearance token obtained from a real browser
 *
 * For Profile D, Bro needs to:
 *   1. Open cinemm.com in Chrome on the phone
 *   2. Open DevTools (or use a Cookie editor extension)
 *   3. Copy all cookies for cinemm.com
 *   4. Paste them into the COOKIES env var before running this script:
 *        COOKIES='cf_clearance=...; __cf_bm=...; user_uuid=...' \
 *          node scripts/mimic-browser.mjs
 *
 * Usage:
 *   node scripts/mimic-browser.mjs
 *   # or with cookies from browser:
 *   COOKIES='cf_clearance=...; user_uuid=...' node scripts/mimic-browser.mjs
 */

const CINEMM_ORIGIN = 'https://cinemm.com'
const COOKIES_FROM_ENV = process.env.COOKIES || ''

console.log('═══════════════════════════════════════════════════════')
console.log('  Mimic browser request to getMovieSourcesAction')
console.log('═══════════════════════════════════════════════════════\n')

if (COOKIES_FROM_ENV) {
  console.log(`🍪 Using cookies from env: ${COOKIES_FROM_ENV.slice(0, 50)}...\n`)
} else {
  console.log('⚠️  No COOKIES env var set. Profiles A-C will run without cookies.')
  console.log('   For Profile D, copy cookies from cinemm.com in your browser:\n')
  console.log('   1. Open Chrome → cinemm.com (with VPN on)')
  console.log('   2. Tap lock icon → Cookies → cinemm.com')
  console.log('   3. Copy all cookie values')
  console.log('   4. Run: COOKIES=\'name1=val1; name2=val2\' node scripts/mimic-browser.mjs\n')
}

// Real movie ID we know works (from search)
const MOVIE_ID = '1736115700307574' // Inception

// Header profiles (progressively more browser-like)
const profiles = [
  {
    name: 'A: Bare minimum (current script)',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/x-component',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      Origin: CINEMM_ORIGIN,
      Referer: CINEMM_ORIGIN + '/',
      'Next-Action': '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
    },
    body: JSON.stringify([MOVIE_ID]),
  },
  {
    name: 'B: Add Sec-Fetch-* + Accept-Language',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: 'text/x-component',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Action': '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      Origin: CINEMM_ORIGIN,
      Referer: CINEMM_ORIGIN + '/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify([MOVIE_ID]),
  },
  {
    name: 'C: Add common Cloudflare cookies',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: 'text/x-component',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Action': '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      Origin: CINEMM_ORIGIN,
      Referer: CINEMM_ORIGIN + '/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      // Fake but plausible Cloudflare cookies
      Cookie: '__cf_bm=abc123; user_uuid=' + crypto.randomUUID(),
    },
    body: JSON.stringify([MOVIE_ID]),
  },
]

// Profile D: only add if COOKIES env var is set
if (COOKIES_FROM_ENV) {
  profiles.push({
    name: 'D: Real browser cookies from COOKIES env var',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: 'text/x-component',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Action': '40f8eb1c1169207ffd4d06dd202d7580609061d2bb',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      Origin: CINEMM_ORIGIN,
      Referer: CINEMM_ORIGIN + '/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: COOKIES_FROM_ENV,
    },
    body: JSON.stringify([MOVIE_ID]),
  })
}

// Run each profile
for (let i = 0; i < profiles.length; i++) {
  const p = profiles[i]
  console.log(`\n━━━ Profile ${p.name} ━━━`)
  console.log(`POST https://cinemm.com/`)
  console.log(`Body: ${p.body}`)

  try {
    const res = await fetch(CINEMM_ORIGIN + '/', {
      method: 'POST',
      headers: p.headers,
      body: p.body,
      signal: AbortSignal.timeout(20000),
    })

    console.log(`Status: ${res.status} ${res.statusText}`)
    console.log(`CF-Ray: ${res.headers.get('cf-ray') || '(none)'}`)
    console.log(`Content-Type: ${res.headers.get('content-type')}`)

    const text = await res.text()
    if (res.status === 200) {
      console.log(`Body (first 800 chars):`)
      console.log(text.slice(0, 800))

      // Try to parse
      const m = text.match(/1:(\{[\s\S]*\})/)
      if (m) {
        try {
          const parsed = JSON.parse(m[1])
          console.log(`\n✅ PARSED:`)
          console.log(`   ok     : ${parsed.ok}`)
          console.log(`   access : ${parsed.access}`)
          console.log(`   servers: ${(parsed.servers || []).length}`)
          if (parsed.access === 'direct' && (parsed.servers || []).length > 0) {
            console.log(`\n🎉🎉🎉 SUCCESS! This profile works!`)
            console.log(`   Stream URLs:`)
            parsed.servers.forEach((s, idx) => {
              console.log(`   [${idx + 1}] ${s.name || '?'} | ${s.size || '?'} | ${s.url || '?'}`
                .slice(0, 250))
            })
          }
        } catch (e) {
          console.log(`Parse error: ${e.message}`)
        }
      }
    } else {
      console.log(`Body (first 500 chars):`)
      console.log(text.slice(0, 500))
    }
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`)
  }
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done!')
console.log('═══════════════════════════════════════════════════════')
