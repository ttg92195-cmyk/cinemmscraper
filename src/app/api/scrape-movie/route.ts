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
    const pw = await import('playwright')
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // Navigate to cinemm.com search page
    const searchUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(3000)

    // Click on the movie/series result matching our name
    // Use a more robust selector — look for clickable elements containing the name
    const resultEl = page.locator(`text=${name}`).first()
    const resultCount = await resultEl.count()
    console.log('Found results for', name, ':', resultCount)

    if (resultCount > 0) {
      await resultEl.click()
      await page.waitForTimeout(5000)
    }

    // Extract ALL text content from the page
    const pageText = await page.evaluate(() => document.body.innerText)
    console.log('Page text length:', pageText.length)
    console.log('Page text first 300:', pageText.substring(0, 300))

    // Extract overview — look for Myanmar text (the overview always contains Myanmar chars)
    let overview = ''

    // Strategy A: Text between "Movie"/"Series" and "Watch on Telegram"
    const movieMatch = pageText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=Watch on Telegram|Show Sources|Back|$)/i)
    if (movieMatch && movieMatch[1].trim().length > 50) {
      overview = movieMatch[1].trim()
    }

    // Strategy B: Find the longest Myanmar text block
    if (!overview || overview.length < 50) {
      const myanmarBlocks = pageText.match(/[\u1000-\u109F][\s\S]{50,}?[\u1000-\u109F]/g) || []
      if (myanmarBlocks.length > 0) {
        overview = myanmarBlocks.sort((a, b) => b.length - a.length)[0].trim()
      }
    }

    // Strategy C: Get full body text if it contains Myanmar chars
    if (!overview || overview.length < 50) {
      if (/[\u1000-\u109F]/.test(pageText) && pageText.length > 200) {
        // Take everything after the first line (which is usually "CineMM")
        const lines = pageText.split('\n').filter(l => l.trim().length > 0)
        if (lines.length > 2) {
          overview = lines.slice(2).join('\n').trim()
        }
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
      debug: {
        resultCount,
        pageTextLength: pageText.length,
        pageTextPreview: pageText.substring(0, 200),
        overviewLength: overview.length,
      },
    })
  } catch (playwrightError) {
    console.error('Playwright failed:', playwrightError instanceof Error ? playwrightError.message : 'unknown')
    if (browser) await browser.close().catch(() => {})
    // Include error in response for debugging
    return NextResponse.json({
      id: parseInt(id, 10),
      name, year, poster, type, source,
      overview: '',
      telegramLink,
      streamUrls: [],
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: playwrightError instanceof Error ? playwrightError.message : 'Playwright failed',
      method: 'playwright-error',
    })
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
