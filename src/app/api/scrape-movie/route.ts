import { NextRequest, NextResponse } from 'next/server'
import * as cheerio from 'cheerio'

export const runtime = 'nodejs'
export const maxDuration = 25

/**
 * GET /api/scrape-movie?id=<num>&type=<movie|series>&source=<CM>&name=<...>
 *
 * Uses Playwright (headless browser) to render cinemm.com's detail page
 * and extract the overview text + Telegram link.
 *
 * On Railway: Playwright + Chromium are installed via Dockerfile.
 * On Vercel: Falls back to ScraperAPI (render=true) or Telegram link construction.
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

  // Telegram link — always construct from ID (cinemm.com format)
  const telegramLink = `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`

  // Strategy 1: Try Playwright (works on Railway with Docker, local dev)
  let browser = null
  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // Navigate to cinemm.com search page
    const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(2000)

    // Click on the movie/series result matching our name
    const resultEl = page.locator(`text=${name}`).first()
    if (await resultEl.count() > 0) {
      await resultEl.click()
      await page.waitForTimeout(5000)
    }

    // Extract text content from the detail page
    const pageText = await page.evaluate(() => document.body.innerText)

    // Extract overview — text after "Movie" or "Series" badge
    let overview = ''
    const movieMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=(?:Watch on Telegram|Show Sources|Back|$))/)
    if (movieMatch) {
      overview = movieMatch[1].trim()
    }
    if (!overview || overview.length < 50) {
      const fallbackMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)$/)
      if (fallbackMatch) overview = fallbackMatch[1].trim()
    }

    // Also try Cheerio on the rendered HTML
    if (!overview || overview.length < 50) {
      const html = await page.content()
      const $ = cheerio.load(html)
      const allText: string[] = []
      $('body *').each((_i, el) => {
        const text = $(el).clone().children().remove().end().text().trim()
        if (text.length > 100 && /[\u1000-\u109F]/.test(text)) {
          allText.push(text)
        }
      })
      if (allText.length > 0) {
        overview = allText.sort((a, b) => b.length - a.length)[0]
      }
    }

    // Look for actual Telegram link in the rendered page
    const actualTelegramLink = await page.locator('a[href*="t.me"]').first().getAttribute('href').catch(() => null)

    await browser.close()
    browser = null

    return NextResponse.json({
      id: parseInt(id, 10),
      name, year, poster, type, source,
      overview,
      telegramLink: actualTelegramLink || telegramLink,
      streamUrls: [],
      fetchedAt: new Date().toISOString(),
      sourceUrl: searchUrl,
      error: null,
      method: 'playwright',
    })
  } catch (playwrightError) {
    console.error('Playwright failed:', playwrightError instanceof Error ? playwrightError.message : 'unknown')
    if (browser) await browser.close().catch(() => {})
  }

  // Strategy 2: ScraperAPI fallback (works on Vercel)
  const apiKey = process.env.SCRAPER_API_KEY
  if (apiKey) {
    try {
      const movieUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`
      const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(movieUrl)}&render=true&country_code=us`

      const scrapeRes = await fetch(scraperUrl, { headers: { 'Accept': 'text/html' } })
      if (scrapeRes.ok) {
        const html = await scrapeRes.text()
        const $ = cheerio.load(html)

        let overview = ''
        // Look for Myanmar text blocks
        const allText: string[] = []
        $('body *').each((_i, el) => {
          const text = $(el).clone().children().remove().end().text().trim()
          if (text.length > 100 && /[\u1000-\u109F]/.test(text)) {
            allText.push(text)
          }
        })
        if (allText.length > 0) {
          overview = allText.sort((a, b) => b.length - a.length)[0]
        }

        return NextResponse.json({
          id: parseInt(id, 10),
          name, year, poster, type, source,
          overview,
          telegramLink,
          streamUrls: [],
          fetchedAt: new Date().toISOString(),
          sourceUrl: movieUrl,
          error: null,
          method: 'scraperapi',
        })
      }
    } catch (e) {
      console.log('ScraperAPI failed:', e instanceof Error ? e.message : 'unknown')
    }
  }

  // Strategy 3: Fallback — just return Telegram link
  return NextResponse.json({
    id: parseInt(id, 10),
    name, year, poster, type, source,
    overview: '',
    telegramLink,
    streamUrls: [],
    fetchedAt: new Date().toISOString(),
    sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
    error: null,
    method: 'fallback',
  })
}
