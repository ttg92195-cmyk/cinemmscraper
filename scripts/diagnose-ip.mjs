/**
 * Final diagnostic — what does cinemm.com see when we call from this IP?
 *
 * We confirmed:
 *   - Action ID is correct (still in the bundle)
 *   - Argument format is correct (just [id])
 *   - But getMovieSourcesAction returns HTTP 500
 *
 * The bundle code shows:
 *   if ("direct" !== t.access) { ... return }
 *
 * Hypothesis: cinemm.com does server-side IP geolocation. If our IP is
 * NOT Myanmar, the action throws an error (HTTP 500).
 *
 * This script does 4 things to confirm:
 *   1. Calls a public IP-geolocation API to see what country our IP is in
 *   2. Calls getMovieSourcesAction with a known movie ID (Inception)
 *   3. Inspects the EXACT error response (headers, body)
 *   4. Also tries calling with extra headers (Cookie, user_uuid) to see
 *      if cinemm.com needs a visitor UUID
 *
 * Run on Termux:
 *   node scripts/diagnose-ip.mjs
 */

const CINEMM_ORIGIN = 'https://cinemm.com'

console.log('═══════════════════════════════════════════════════════')
console.log('  IP & cinemm.com diagnostic')
console.log('═══════════════════════════════════════════════════════\n')

// -------------------------------------------------------------
// Test 1: What's our public IP and what country?
// -------------------------------------------------------------
console.log('1️⃣  Checking our public IP and country...')
try {
  const ipRes = await fetch('https://ipapi.co/json/', {
    signal: AbortSignal.timeout(10000),
  })
  if (ipRes.ok) {
    const ipData = await ipRes.json()
    console.log('   IP Address :', ipData.ip)
    console.log('   Country    :', ipData.country_name, `(${ipData.country})`)
    console.log('   Region     :', ipData.region)
    console.log('   City       :', ipData.city)
    console.log('   ISP        :', ipData.org)
    if (ipData.country === 'MM') {
      console.log('   ✅ IP is in Myanmar — cinemm.com should accept it')
    } else {
      console.log(`   ❌ IP is in ${ipData.country_name}, NOT Myanmar!`)
      console.log('   This is why getMovieSourcesAction fails with HTTP 500.')
      console.log('   Solution: switch VPN server to a Myanmar location,')
      console.log('             or use Myanmar SIM mobile data.')
    }
  } else {
    console.log('   ⚠️  ipapi.co returned HTTP', ipRes.status)
    // Try alternative
    const altRes = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10000),
    })
    if (altRes.ok) {
      const altData = await altRes.json()
      console.log('   Your IP (ipify):', altData.ip)
    }
  }
} catch (e) {
  console.log('   ❌ IP check failed:', e.message)
}
console.log('')

// -------------------------------------------------------------
// Test 2: Get a real movie ID via search (we know this works)
// -------------------------------------------------------------
console.log('2️⃣  Searching "inception" to get a real movie ID...')
let movieId = null
try {
  const searchRes = await fetch(CINEMM_ORIGIN + '/', {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/x-component',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      Origin: CINEMM_ORIGIN,
      Referer: CINEMM_ORIGIN + '/',
      'Next-Action': '60ffdc3034e91f62a96097852d58446360f909809e',
    },
    body: JSON.stringify(['inception', 'movie']),
    signal: AbortSignal.timeout(15000),
  })
  console.log('   Search HTTP status:', searchRes.status)
  const searchText = await searchRes.text()

  // Find line "1:" JSON
  const m = searchText.match(/\n1:(\{[\s\S]*?\})\n/)
  if (m) {
    const parsed = JSON.parse(m[1])
    const items = Array.isArray(parsed) ? parsed : parsed.results || []
    if (items.length > 0) {
      movieId = items[0].id
      console.log('   ✅ Found movie:', items[0].name, '(ID:', movieId, ')')
    }
  } else {
    // Try glued JSON pattern
    const m2 = searchText.match(/1:\{[\s\S]*\}/)
    if (m2) {
      const parsed = JSON.parse(m2[0].slice(2))
      const items = Array.isArray(parsed) ? parsed : parsed.results || []
      if (items.length > 0) {
        movieId = items[0].id
        console.log('   ✅ Found movie:', items[0].name, '(ID:', movieId, ')')
      }
    }
  }
  if (!movieId) {
    console.log('   ⚠️  Could not parse search response. First 500 chars:')
    console.log('   ' + searchText.slice(0, 500))
  }
} catch (e) {
  console.log('   ❌ Search failed:', e.message)
}
console.log('')

if (!movieId) {
  console.log('⚠️  Cannot continue without a movie ID. Exiting.')
  process.exit(1)
}

// -------------------------------------------------------------
// Test 3: Call getMovieSourcesAction and inspect EVERYTHING
// -------------------------------------------------------------
console.log(`3️⃣  Calling getMovieSourcesAction(movieId=${movieId})...`)
console.log('   Inspecting response in detail:\n')

try {
  const srcRes = await fetch(CINEMM_ORIGIN + '/', {
    method: 'POST',
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
    body: JSON.stringify([Number(movieId)]),
    signal: AbortSignal.timeout(20000),
  })

  console.log('   HTTP Status  :', srcRes.status, srcRes.statusText)
  console.log('   Content-Type :', srcRes.headers.get('content-type'))
  console.log('   Response headers:')
  for (const [k, v] of srcRes.headers.entries()) {
    console.log(`     ${k}: ${v}`)
  }

  const body = await srcRes.text()
  console.log('\n   Response body (first 2000 chars):')
  console.log('   ' + body.slice(0, 2000).split('\n').join('\n   '))

  if (body.length > 2000) {
    console.log(`\n   ... (${body.length - 2000} more bytes)`)
  }

  // Try to parse error
  if (body.includes('"digest"')) {
    console.log('\n   📋 Error detected in response (RSC error chunk).')
    console.log('   This is a server-side throw. cinemm.com rejected the request.')
  }

  // Try to parse as JSON
  const jsonMatch = body.match(/1:(\{[\s\S]*\})/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      console.log('\n   📋 Parsed JSON from line "1:":')
      console.log('   ' + JSON.stringify(parsed, null, 2).split('\n').join('\n   '))
    } catch {
      console.log('\n   ⚠️  Could not parse JSON from response.')
    }
  }
} catch (e) {
  console.log('   ❌ Fetch failed:', e.message)
}
console.log('')

// -------------------------------------------------------------
// Test 4: Try with a fake user_uuid cookie (cinemm.com may need it)
// -------------------------------------------------------------
console.log('4️⃣  Trying again with a random user_uuid cookie...')
try {
  const fakeUuid = crypto.randomUUID()
  console.log(`   Using UUID: ${fakeUuid}`)

  const srcRes = await fetch(CINEMM_ORIGIN + '/', {
    method: 'POST',
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
      Cookie: `user_uuid=${fakeUuid}`,
    },
    body: JSON.stringify([Number(movieId)]),
    signal: AbortSignal.timeout(20000),
  })

  console.log('   HTTP Status:', srcRes.status, srcRes.statusText)
  const body = await srcRes.text()
  console.log('   Body (first 800 chars):')
  console.log('   ' + body.slice(0, 800).split('\n').join('\n   '))

  const jsonMatch = body.match(/1:(\{[\s\S]*\})/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      console.log('\n   📋 Parsed JSON:')
      console.log('   ' + JSON.stringify(parsed, null, 2).split('\n').join('\n   '))
      if (parsed.access === 'direct') {
        console.log('\n   🎉🎉🎉 access="direct" — VPN IS WORKING with cookie!')
        console.log('   The fix is to add user_uuid cookie to the crawler.')
      } else if (parsed.access === 'telegram') {
        console.log('\n   ⚠️  access="telegram" — VPN IP is still not Myanmar.')
      }
    } catch {
      console.log('\n   ⚠️  Could not parse JSON.')
    }
  }
} catch (e) {
  console.log('   ❌ Failed:', e.message)
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Diagnostic complete!')
console.log('═══════════════════════════════════════════════════════')
