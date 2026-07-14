import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * GET /api/scrape-movie?id=<num>&type=<movie|series>&source=<CM>&name=<...>
 *
 * Uses Playwright (headless browser) to render cinemm.com's page and extract:
 *   - Overview text (Myanmar subtitle description)
 *   - Telegram bot link (https://t.me/cinemmbot?start=w_m_<id>)
 *
 * This bypasses cinemm.com's API restrictions by rendering the page exactly
 * as a real browser would, capturing the client-side rendered content.
 *
 * Note: On Vercel, Playwright browsers may not be available. In that case,
 * we fall back to a simple HTTP fetch + regex extraction from the RSC data
 * embedded in the HTML (self.__next_f.push chunks).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id') ?? ''
  const type = searchParams.get('type') ?? 'movie'
  const name = searchParams.get('name') ?? ''
  const year = searchParams.get('year') ?? ''
  const poster = searchParams.get('poster') ?? ''
  const source = searchParams.get('source') ?? 'CM'

  if (!id) {
    return NextResponse.json({ error: 'Missing "id"' }, { status: 400 })
  }

  // Strategy 1: Try Playwright (works locally, may not work on Vercel)
  let browser = null
  try {
    const { chromium } = await import('playwright-core')
    // Try to find a browser executable
    const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH
      || '/home/z/.cache/ms-playwright'
    browser = await chromium.launch({
      headless: true,
      executablePath: browserPath ? undefined : undefined, // let it auto-detect
    })
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name || id)}&type=${type}`
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForTimeout(2000)

    const resultEl = page.locator(`text=${name}`).first()
    if (await resultEl.count() > 0) {
      await resultEl.click()
      await page.waitForTimeout(5000)
    }

    const pageText = await page.evaluate(() => document.body.innerText)
    let overview = ''
    const movieMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=(?:Watch on Telegram|Show Sources|Back|$))/)
    if (movieMatch) overview = movieMatch[1].trim()
    if (!overview) {
      const fallbackMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)$/)
      if (fallbackMatch) overview = fallbackMatch[1].trim()
    }

    const telegramLink = await page.locator('a[href*="t.me"]').first().getAttribute('href').catch(() => null)
    const html = await page.content()
    const streamUrls = html.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com\/file\/[^\s"'<>]+/g) || []

    await browser.close()
    browser = null

    return NextResponse.json({
      id: parseInt(id, 10), name, year, poster, type, source,
      overview, telegramLink,
      streamUrls: [...new Set(streamUrls)],
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: null,
      method: 'playwright',
    })
  } catch (playwrightError) {
    console.log('Playwright not available, using HTTP fallback:', playwrightError instanceof Error ? playwrightError.message : 'unknown')
    if (browser) await browser.close().catch(() => {})
  }

  // Strategy 2: HTTP fallback — fetch the page HTML and extract data from
  // the RSC chunks (self.__next_f.push). This works without a browser.
  try {
    const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const html = await res.text()

    // Extract RSC data from self.__next_f.push chunks
    const pushMatches = html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)
    let fullData = ''
    for (const match of pushMatches) {
      let chunk = match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\u0026/g, '&')
      fullData += chunk
    }

    // Look for overview text in the RSC data
    // The overview is usually a long text chunk (line "2:" or similar)
    let overview = ''
    // Try to find Myanmar text (common in cinemm.com overviews)
    const myanmarMatch = fullData.match(/T[0-9a-f]+,([\s\S]{100,}?)(?=["\n]|1:\{)/)
    if (myanmarMatch) {
      overview = myanmarMatch[1].trim()
    }

    // Look for Telegram link — construct it from the movie ID
    // cinemm.com's format: https://t.me/cinemmbot?start=w_m_<movieId>
    // For series: w_s_<seriesId>, for episodes: w_e_<episodeId>
    const telegramLink = `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`

    // Look for stream URLs
    const streamUrls = html.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com\/file\/[^\s"'<>]+/g) || []

    return NextResponse.json({
      id: parseInt(id, 10), name, year, poster, type, source,
      overview,
      telegramLink,
      streamUrls: [...new Set(streamUrls)],
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: null,
      method: 'http-fallback',
    })
  } catch (e) {
    console.error('[/api/scrape-movie] error:', e)
    return NextResponse.json(
      {
        id: parseInt(id, 10), name, year, poster, type, source,
        overview: '', telegramLink: null, streamUrls: [],
        error: e instanceof Error ? e.message : 'Scrape failed',
        fetchedAt: new Date().toISOString(),
        sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
        method: 'error',
      },
      { status: 200 },
    )
  }
}
