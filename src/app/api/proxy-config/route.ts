import { NextRequest, NextResponse } from 'next/server'
import { getCache, setCache } from '@/lib/cache'

export const runtime = 'nodejs'

/**
 * /api/proxy-config
 *
 * Stores/retrieves the proxy address that Bro provides from their phone
 * (via an app like Every Proxy). The server uses this proxy when making
 * requests to cinemm.com so that cinemm.com sees a Myanmar IP and returns
 * real stream URLs (access: "direct" instead of access: "telegram").
 *
 * GET  /api/proxy-config           → returns current proxy + status
 * POST /api/proxy-config           → { proxy: "http://IP:PORT" } sets the proxy
 * DELETE /api/proxy-config         → clears the proxy
 * POST /api/proxy-config?action=test → tests the proxy by calling cinemm.com
 *
 * Cache key: "proxy:config" (no TTL — persistent until changed)
 */

interface ProxyConfig {
  proxy: string // e.g. "http://192.168.1.5:8080" or "http://user:pass@IP:PORT"
  setAt: string
  lastTested?: string
  lastTestOk?: boolean
  lastTestResult?: string
}

const CACHE_KEY = 'proxy:config'

export async function GET() {
  const config = await getCache<ProxyConfig>(CACHE_KEY)
  return NextResponse.json({
    configured: !!config,
    proxy: config?.proxy ?? null,
    setAt: config?.setAt ?? null,
    lastTested: config?.lastTested ?? null,
    lastTestOk: config?.lastTestOk ?? null,
    lastTestResult: config?.lastTestResult ?? null,
  })
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  // If action=test, test the existing proxy
  if (action === 'test') {
    return await testProxy()
  }

  // Otherwise, set a new proxy
  let body: { proxy?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const proxy = body.proxy?.trim()
  if (!proxy) {
    return NextResponse.json({ error: 'Missing "proxy" field' }, { status: 400 })
  }

  // Validate URL format
  try {
    const parsed = new URL(proxy)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Must be http: or https:')
    }
  } catch {
    return NextResponse.json(
      { error: 'Invalid proxy URL. Must be like http://IP:PORT or http://user:pass@IP:PORT' },
      { status: 400 },
    )
  }

  const config: ProxyConfig = {
    proxy,
    setAt: new Date().toISOString(),
  }
  await setCache(CACHE_KEY, config)

  return NextResponse.json({
    ok: true,
    message: 'Proxy configured. Use ?action=test to verify it works.',
    proxy,
  })
}

export async function DELETE() {
  await setCache(CACHE_KEY, null as any)
  return NextResponse.json({ ok: true, message: 'Proxy cleared' })
}

/**
 * Test the proxy by calling cinemm.com's search action.
 * If the proxy is a Myanmar IP, cinemm.com should return real results.
 */
async function testProxy() {
  const config = await getCache<ProxyConfig>(CACHE_KEY)
  if (!config) {
    return NextResponse.json({ error: 'No proxy configured' }, { status: 400 })
  }

  try {
    // Test 1: Can we reach cinemm.com through the proxy?
    const res = await fetch('https://cinemm.com/', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': '60ffdc3034e91f62a96097852d58446360f909809e',
        Origin: 'https://cinemm.com',
      },
      body: JSON.stringify(['Inception', 'movie']),
      signal: AbortSignal.timeout(15000),
      // @ts-expect-error — Next.js fetch doesn't have `agent` but Node's does
      agent: createProxyAgent(config.proxy),
    })

    if (!res.ok) {
      const result = `cinemm.com returned HTTP ${res.status}`
      await updateTestResult(config, false, result)
      return NextResponse.json({ ok: false, error: result })
    }

    const text = await res.text()
    const hasResults = text.includes('"results"') && text.includes('"id"')

    // Test 2: If search works, try getMovieSourcesAction to see if we get "direct"
    let sourcesResult = '(not tested)'
    if (hasResults) {
      const idMatch = text.match(/"id":(\d+)/)
      if (idMatch) {
        const movieId = idMatch[1]
        const sourcesRes = await fetch('https://cinemm.com/', {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/x-component',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Next-Action': '60f8eb1c1169207ffd4d06dd202d7580609061d2bb',
            Origin: 'https://cinemm.com',
          },
          body: JSON.stringify([movieId]),
          signal: AbortSignal.timeout(15000),
          // @ts-expect-error
          agent: createProxyAgent(config.proxy),
        })
        if (sourcesRes.ok) {
          const sourcesText = await sourcesRes.text()
          if (sourcesText.includes('"direct"')) {
            sourcesResult = '✅ access: "direct" — Myanmar IP confirmed! Stream URLs available!'
          } else if (sourcesText.includes('"telegram"')) {
            sourcesResult = '⚠️ access: "telegram" — proxy IP is NOT Myanmar'
          } else {
            sourcesResult = `Unknown response: ${sourcesText.slice(0, 200)}`
          }
        }
      }
    }

    const result = hasResults
      ? `✅ Search works! ${sourcesResult}`
      : `Search returned no results. Response: ${text.slice(0, 200)}`

    await updateTestResult(config, hasResults, result)
    return NextResponse.json({ ok: hasResults, result, sourcesResult })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    await updateTestResult(config, false, msg)
    return NextResponse.json({ ok: false, error: msg })
  }
}

async function updateTestResult(config: ProxyConfig, ok: boolean, result: string) {
  await setCache(CACHE_KEY, {
    ...config,
    lastTested: new Date().toISOString(),
    lastTestOk: ok,
    lastTestResult: result,
  })
}

/**
 * Create a Node.js HTTP agent that routes through the proxy.
 * Supports both plain HTTP proxies and authenticated proxies.
 *
 * Uses undici's ProxyAgent (built into Node 18+ / Next.js). If undici is
 * unavailable, returns undefined and the caller falls back to direct fetch.
 *
 * Note: This is a synchronous function because fetch()'s `agent` option
 * requires a value, not a Promise. We use createRequire to dynamically
 * load undici at runtime without TypeScript/Rollup trying to resolve it
 * at build time.
 */
function createProxyAgent(proxyUrl: string): import('http').Agent | undefined {
  try {
    // Use Node's built-in createRequire to load undici at runtime.
    // This avoids the bundler trying to statically resolve 'undici'
    // (which IS a Node built-in module but TypeScript may not see it).
    const module = require('module')
    const require_ = module.createRequire(import.meta.url || __filename)
    const undici = require_('undici')
    if (undici && typeof undici.ProxyAgent === 'function') {
      return new undici.ProxyAgent(proxyUrl)
    }
  } catch {
    // undici not available — fall through
  }
  console.error('[proxy] No proxy agent available — undici is required (Node 18+)')
  return undefined
}
