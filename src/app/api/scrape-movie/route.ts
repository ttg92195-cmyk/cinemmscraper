import { NextRequest, NextResponse } from 'next/server'
import * as cheerio from 'cheerio'
import {
  searchCinemm,
  getDetails,
  type MediaType,
  type CinemmDetails,
} from '@/lib/cinemm'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/scrape-movie?id=<num>&type=<movie|series>&source=<CM>&name=<...>
 *
 * Scrapes cinemm.com to get movie/series overview + Telegram link.
 *
 * Strategy chain (each step falls through to the next on failure):
 *   0. Resolve poster — if `poster` query param is missing, search cinemm.com
 *      and look up the matching item by id to grab its poster URL.
 *   1. getDetails() — call cinemm.com's Server Actions directly (no browser)
 *      to fetch overview + servers. Works on Railway because it's just HTTP.
 *   2. Playwright (local dev / full Docker image) — renders SPA, clicks result
 *      Used as a last-resort when Server Actions return empty overview.
 *   3. ScraperAPI (render=true) — server-side render via ScraperAPI service
 *   4. Fallback — just construct Telegram link from ID
 *
 * IMPORTANT: On Railway/Vercel standalone builds, Playwright's browsers.json
 * is missing from the standalone bundle, so import('playwright') will throw.
 * That's expected — we catch it and fall through to ScraperAPI.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id') ?? ''
  const type = searchParams.get('type') ?? 'movie'
  const name = searchParams.get('name') ?? ''
  const year = searchParams.get('year') ?? ''
  let poster = searchParams.get('poster') ?? ''
  const source = searchParams.get('source') ?? 'CM'
  const visitorUuid = searchParams.get('uuid') || null

  if (!id) {
    return NextResponse.json({ error: 'Missing "id"' }, { status: 400 })
  }

  const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`
  const telegramLink = `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`

  // Track all attempts for the final response
  const attempts: Array<{
    method: string
    ok: boolean
    error?: string
    overview?: string
    servers?: number
  }> = []

  // ============================================================
  // Step 0: Resolve poster URL if not supplied
  // ============================================================
  if (!poster && name) {
    try {
      const { items } = await searchCinemm(name, type as MediaType, { useCache: true })
      const match = items.find(
        (it) => String(it.id) === String(id) || (it.name && it.name.toLowerCase() === name.toLowerCase()),
      )
      if (match?.poster) {
        poster = match.poster
        attempts.push({ method: 'poster-resolve', ok: true })
      } else {
        attempts.push({
          method: 'poster-resolve',
          ok: false,
          error: `No matching item for id=${id} name=${name} in ${items.length} results`,
        })
      }
    } catch (e) {
      attempts.push({
        method: 'poster-resolve',
        ok: false,
        error: e instanceof Error ? e.message : 'searchCinemm failed',
      })
    }
  }

  // ============================================================
  // Step 1: getDetails() — cinemm.com Server Actions (HTTP only)
  // ============================================================
  // This is the fastest path and works on Railway because it's plain HTTP.
  // cinemm.com returns overview as RSC line "2:" (text chunk).
  try {
    const details: CinemmDetails = await getDetails(
      { id: parseInt(id, 10), type: type as MediaType, source, name, year, poster },
      { useCache: true, visitorUuid },
    )

    const overview = details.overview || ''
    const servers = 'servers' in details ? details.servers : []
    const hasContent = overview.length > 0 || servers.length > 0

    attempts.push({
      method: 'getDetails',
      ok: hasContent,
      overview: overview.slice(0, 100),
      servers: servers.length,
      error: hasContent ? undefined : (details.error ?? 'empty overview + servers'),
    })

    if (hasContent) {
      // Found it! Return immediately.
      return NextResponse.json({
        id: parseInt(id, 10),
        name,
        year,
        poster,
        type,
        source,
        overview,
        telegramLink,
        streamUrls: servers.map((s) => s.url).filter(Boolean),
        servers,
        fetchedAt: new Date().toISOString(),
        sourceUrl: searchUrl,
        error: null,
        method: 'getDetails',
        attempts,
        remaining: details.remaining,
      })
    }
  } catch (e) {
    attempts.push({
      method: 'getDetails',
      ok: false,
      error: e instanceof Error ? e.message : 'getDetails failed',
    })
  }

  // ============================================================
  // Step 2: Playwright (local dev / full Docker image only)
  // ============================================================
  // On Railway standalone, this throws on import — caught and fall through.
  let browser: any = null
  try {
    const pw = await import('playwright')

    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(3000)

    const resultEl = page.locator(`text=${name}`).first()
    const resultCount = await resultEl.count()
    if (resultCount > 0) {
      await resultEl.click()
      await page.waitForTimeout(5000)
    }

    const pageText = await page.evaluate(() => document.body.innerText)
    const overview = extractOverviewFromText(pageText)

    const actualTelegramLink = await page
      .locator('a[href*="t.me"]')
      .first()
      .getAttribute('href')
      .catch(() => null)

    await browser.close()
    browser = null

    attempts.push({ method: 'playwright', ok: true, overview: overview.slice(0, 100) })

    return NextResponse.json({
      id: parseInt(id, 10),
      name,
      year,
      poster,
      type,
      source,
      overview,
      telegramLink: actualTelegramLink || telegramLink,
      streamUrls: [],
      fetchedAt: new Date().toISOString(),
      sourceUrl: searchUrl,
      error: null,
      method: 'playwright',
      attempts,
    })
  } catch (playwrightError) {
    const msg = playwrightError instanceof Error ? playwrightError.message : 'Playwright failed'
    console.error('[scrape-movie] Playwright failed:', msg)
    if (browser) await browser.close().catch(() => {})
    attempts.push({ method: 'playwright', ok: false, error: msg })
    // DO NOT return — fall through to ScraperAPI
  }

  // ============================================================
  // Step 3: ScraperAPI (render=true) — works on Railway/Vercel
  // ============================================================
  const apiKey = process.env.SCRAPER_API_KEY
  if (apiKey) {
    try {
      const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(searchUrl)}&render=true&country_code=us`
      const scrapeRes = await fetch(scraperUrl, {
        headers: { 'Accept': 'text/html' },
        signal: AbortSignal.timeout(45000), // increased to 45s
      })

      if (scrapeRes.ok) {
        const html = await scrapeRes.text()
        const overview = extractOverviewFromHtml(html)

        // Try to find a Telegram link in the HTML
        const $ = cheerio.load(html)
        const actualTelegramLink = $('a[href*="t.me"]').first().attr('href') || null

        // Try to find a poster image in the search results
        const extractedPoster =
          $('img[src*="image.tmdb.org"], img[src*="cinemm"], img[src*="poster"]').first().attr('src') || poster

        // ScraperAPI "succeeded" only if we got a real overview (not RSC junk)
        const ok = overview.length > 0 && !isRscJunk(overview)
        attempts.push({
          method: 'scraperapi',
          ok,
          overview: overview.slice(0, 100),
          error: ok ? undefined : 'No real overview found in rendered HTML (only RSC shell)',
        })

        if (ok) {
          return NextResponse.json({
            id: parseInt(id, 10),
            name,
            year,
            poster: extractedPoster || poster,
            type,
            source,
            overview,
            telegramLink: actualTelegramLink || telegramLink,
            streamUrls: [],
            fetchedAt: new Date().toISOString(),
            sourceUrl: searchUrl,
            error: null,
            method: 'scraperapi',
            attempts,
            htmlLength: html.length,
          })
        }
        // Otherwise fall through to fallback
      } else {
        attempts.push({
          method: 'scraperapi',
          ok: false,
          error: `HTTP ${scrapeRes.status} ${scrapeRes.statusText}`,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ScraperAPI failed'
      console.error('[scrape-movie] ScraperAPI failed:', msg)
      attempts.push({ method: 'scraperapi', ok: false, error: msg })
    }
  } else {
    attempts.push({
      method: 'scraperapi',
      ok: false,
      error: 'SCRAPER_API_KEY env var not set',
    })
  }

  // ============================================================
  // Step 4: Fallback — return just the Telegram link
  // ============================================================
  attempts.push({ method: 'fallback', ok: true })

  const lastError = attempts.find((a) => !a.ok)?.error || null

  return NextResponse.json({
    id: parseInt(id, 10),
    name,
    year,
    poster,
    type,
    source,
    overview: '',
    telegramLink,
    streamUrls: [],
    fetchedAt: new Date().toISOString(),
    sourceUrl: searchUrl,
    error: lastError,
    method: 'fallback',
    attempts,
  })
}

/**
 * Extract overview text from a plain-text page body.
 * The overview always contains Myanmar characters (U+1000-U+109F).
 */
function extractOverviewFromText(pageText: string): string {
  if (!pageText) return ''

  // Strategy A: Text between "Movie"/"Series" header and footer keywords
  const headerMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=Watch on Telegram|Show Sources|Back|$)/i)
  if (headerMatch && headerMatch[1].trim().length > 50) {
    return headerMatch[1].trim()
  }

  // Strategy B: Find the longest Myanmar text block
  const myanmarBlocks = pageText.match(/[\u1000-\u109F][\s\S]{50,}?[\u1000-\u109F]/g) || []
  if (myanmarBlocks.length > 0) {
    const longest = myanmarBlocks.sort((a, b) => b.length - a.length)[0]
    return (longest ?? '').trim()
  }

  // Strategy C: Get full body text if it contains Myanmar chars
  if (/[\u1000-\u109F]/.test(pageText) && pageText.length > 200) {
    const lines = pageText.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length > 2) {
      return lines.slice(2).join('\n').trim()
    }
  }

  return ''
}

/**
 * Check if a string looks like RSC wire-format junk (not real overview text).
 * RSC chunks look like: self.__next_f.push([1,"a:{"metadata":...}"])
 *                      f:"$a:metadata"
 *                      0:["$","div",null,{"..."}]
 * These should never be returned as an overview.
 */
function isRscJunk(text: string): boolean {
  if (!text) return true
  const trimmed = text.trim()
  // RSC markers that indicate this is wire format, not real text
  if (trimmed.startsWith('self.__next_f.push')) return true
  if (trimmed.startsWith('$') && trimmed.length < 200) return true
  if (/^\d+:\[/.test(trimmed)) return true // e.g. "0:[\"$\",\"div\",null,{...}]"
  if (/^[0-9a-f]:T[0-9a-f]+,/.test(trimmed)) return true // RSC text chunk
  if (trimmed.startsWith('f:"')) return true
  // If the text is mostly JSON-like (lots of backslashes and quotes), it's junk
  const jsonCharRatio = (trimmed.match(/[\\\[\]{}"]/g)?.length ?? 0) / trimmed.length
  if (jsonCharRatio > 0.15 && !/[\u1000-\u109F]/.test(trimmed)) return true
  return false
}

/**
 * Extract overview text from HTML returned by ScraperAPI.
 *
 * ScraperAPI returns cinemm.com's SPA shell — the HTML contains
 * self.__next_f.push(...) RSC chunks, not real rendered overview text.
 * We need to:
 *   1. Parse all __next_f.push chunks
 *   2. Look for a T-prefixed text chunk that contains Myanmar characters
 *   3. Fall back to longest Myanmar text block in the body
 */
function extractOverviewFromHtml(html: string): string {
  if (!html) return ''

  const candidates: string[] = []

  // Strategy A: Parse self.__next_f.push([1,"..."]) chunks
  // These contain JSON-encoded RSC data. We unescape and look for Myanmar text.
  const nextFPushRegex = /self\.__next_f\.push\(\[\s*1\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g
  let match: RegExpExecArray | null
  while ((match = nextFPushRegex.exec(html)) !== null) {
    try {
      // Unescape the JSON string literal
      const raw = match[1]
      // The raw is a JSON-escaped string — parse it as a JSON string to unescape
      const unescaped = JSON.parse('"' + raw + '"')
      // Look for T-prefixed text chunks in the unescaped data: "2:T<hex>,<text>"
      const tChunkMatches = unescaped.matchAll(/\d+:T[0-9a-f]+,([\s\S]*?)(?=\n\d+:|\n[a-z]:|$)/g)
      for (const tcm of tChunkMatches) {
        const text = tcm[1]
        if (text && text.length > 50 && /[\u1000-\u109F]/.test(text)) {
          candidates.push(text.trim())
        }
      }
      // Also look for plain Myanmar text blocks (not in T chunks)
      const myanmarInChunk = unescaped.match(/[\u1000-\u109F][\s\S]{50,}?[\u1000-\u109F]/g)
      if (myanmarInChunk) {
        candidates.push(...myanmarInChunk.map((s) => s.trim()))
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  // Strategy B: Parse plain text from the body (for fully-rendered pages)
  try {
    const $ = cheerio.load(html)
    $('body *').each((_i, el) => {
      const text = $(el).clone().children().remove().end().text().trim()
      if (text.length > 100 && /[\u1000-\u109F]/.test(text) && !isRscJunk(text)) {
        candidates.push(text)
      }
    })
  } catch {
    // ignore parse errors
  }

  if (candidates.length === 0) return ''

  // Sort by length (longest first), filter out RSC junk
  const valid = candidates.filter((c) => !isRscJunk(c))
  const pool = valid.length > 0 ? valid : candidates
  const longest = pool.sort((a, b) => b.length - a.length)[0]
  return longest ?? ''
}
