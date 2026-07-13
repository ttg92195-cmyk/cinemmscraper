import { NextRequest, NextResponse } from 'next/server'
import { chromium } from 'playwright'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * GET /api/scrape-movie?id=<num>&type=<movie|series>&source=<CM>&name=<...>
 *
 * Uses Playwright (headless browser) to render cinemm.com's page and extract:
 *   - Overview text (Myanmar subtitle description)
 *   - Telegram bot link (https://t.me/cinemmbot?start=w_m_<id>)
 *   - Seasons + episodes (for series)
 *
 * This bypasses cinemm.com's API restrictions by rendering the page exactly
 * as a real browser would, capturing the client-side rendered content.
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

  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // Navigate to cinemm.com with search params
    const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name || id)}&type=${type}`
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForTimeout(2000)

    // Click on the result matching our name
    const resultEl = page.locator(`text=${name}`).first()
    if (await resultEl.count() > 0) {
      await resultEl.click()
      await page.waitForTimeout(5000)
    }

    // Extract text content
    const pageText = await page.evaluate(() => document.body.innerText)

    // Extract overview — text after "Movie" or "Series" badge
    let overview = ''
    const movieMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=(?:Watch on Telegram|Show Sources|Back|$))/)
    if (movieMatch) {
      overview = movieMatch[1].trim()
    }
    if (!overview) {
      const fallbackMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)$/)
      if (fallbackMatch) overview = fallbackMatch[1].trim()
    }

    // Extract Telegram link
    const telegramLink = await page.locator('a[href*="t.me"]').first().getAttribute('href').catch(() => null)

    // Extract all links
    const allLinks = await page.locator('a').evaluateAll(els =>
      els.map(el => ({
        text: el.textContent?.trim() || '',
        href: el.getAttribute('href') || '',
      }))
    )

    // Look for stream/download URLs
    const html = await page.content()
    const streamUrls = html.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com\/file\/[^\s"'<>]+/g) || []
    const cmdriveUrls = html.match(/https:\/\/[a-z0-9]+\.cmdrive\.xyz\/[^\s"'<>]+/g) || []

    // For series: extract seasons/episodes
    let seasons: unknown[] = []
    if (type === 'series') {
      const seasonTexts = await page.locator('text=/Season \\d+/').allTextContents()
      console.log('Seasons found:', seasonTexts.length)
    }

    await browser.close()
    browser = null

    const result = {
      id: parseInt(id, 10),
      name,
      year,
      poster,
      type,
      source,
      overview,
      telegramLink,
      streamUrls: [...new Set(streamUrls)],
      cmdriveUrls: [...new Set(cmdriveUrls)],
      allLinks: allLinks.filter(l => l.href && !l.href.startsWith('#') && !l.href.startsWith('/')),
      seasons,
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: null,
    }

    return NextResponse.json(result)
  } catch (e) {
    console.error('[/api/scrape-movie] error:', e)
    if (browser) await browser.close().catch(() => {})
    return NextResponse.json(
      {
        id: parseInt(id, 10),
        name,
        year,
        poster,
        type,
        source,
        overview: '',
        telegramLink: null,
        streamUrls: [],
        cmdriveUrls: [],
        allLinks: [],
        seasons: [],
        error: e instanceof Error ? e.message : 'Scrape failed',
        fetchedAt: new Date().toISOString(),
        sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      },
      { status: 200 },
    )
  }
}
