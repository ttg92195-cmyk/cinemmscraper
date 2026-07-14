import { NextRequest, NextResponse } from 'next/server'
import * as cheerio from 'cheerio'

export const runtime = 'nodejs'
export const maxDuration = 25

/**
 * GET /api/scrape-movie?id=<num>&type=<movie|series>&source=<CM>&name=<...>
 *
 * Uses ScraperAPI (with JavaScript rendering) to fetch cinemm.com's fully
 * rendered HTML, then extracts:
 *   - Overview text (Myanmar subtitle description)
 *   - Telegram bot link (https://t.me/cinemmbot?start=w_m_<id>)
 *
 * ScraperAPI handles the browser rendering server-side — no Playwright
 * or browser binaries needed. Works perfectly on Vercel.
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

  const apiKey = process.env.SCRAPER_API_KEY
  if (!apiKey) {
    // No API key — construct Telegram link from ID and return minimal data
    return NextResponse.json({
      id: parseInt(id, 10),
      name, year, poster, type, source,
      overview: '',
      telegramLink: `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`,
      streamUrls: [],
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: 'NO_SCRAPER_API_KEY',
      method: 'no-key',
    })
  }

  try {
    // Build the cinemm.com URL for this movie/series
    const movieUrl = `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`

    // Call ScraperAPI with JavaScript rendering enabled
    const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(movieUrl)}&render=true&country_code=us`

    const scrapeRes = await fetch(scraperUrl, {
      headers: {
        'Accept': 'text/html',
      },
    })

    if (!scrapeRes.ok) {
      throw new Error(`ScraperAPI returned HTTP ${scrapeRes.status}`)
    }

    const html = await scrapeRes.text()

    // Extract overview from the rendered HTML using Cheerio
    const $ = cheerio.load(html)

    let overview = ''

    // Strategy 1: Look for the main content area that contains the overview.
    // cinemm.com renders detail page with the overview as a long text block.
    // We look for the largest text block containing Myanmar characters.
    const allText: string[] = []
    $('body *').each((_i, el) => {
      const text = $(el).clone().children().remove().end().text().trim()
      if (text.length > 100 && /[\u1000-\u109F]/.test(text)) {
        allText.push(text)
      }
    })

    if (allText.length > 0) {
      // Pick the longest text block with Myanmar characters
      overview = allText.sort((a, b) => b.length - a.length)[0]
    }

    // Strategy 2: If Cheerio didn't find it, try regex on the raw HTML
    if (!overview || overview.length < 50) {
      // Remove scripts and styles
      const cleanHtml = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

      // Look for Myanmar text blocks
      const myanmarBlocks = cleanHtml.match(/[\u1000-\u109F][\s\S]{50,}?[\u1000-\u109F]/g) || []
      if (myanmarBlocks.length > 0) {
        let longest = ''
        for (const block of myanmarBlocks) {
          const clean = block.replace(/<[^>]+>/g, '').trim()
          if (clean.length > longest.length) longest = clean
        }
        overview = longest
      }
    }

    // Strategy 3: Extract from body text between "Movie"/"Series" and "Telegram"
    if (!overview || overview.length < 50) {
      const plainText = $('body').text()
      const overviewMatch = plainText.match(/(?:Movie|Series)\s*\n([\s\S]*?)(?=Watch on Telegram|Show Sources|Back|$)/i)
      if (overviewMatch) {
        overview = overviewMatch[1].trim()
      }
    }

    // Extract Telegram link
    // Look for t.me/cinemmbot links in the HTML
    const telegramMatch = html.match(/https:\/\/t\.me\/cinemmbot\?start=w_[a-z]_\d+/)
    const telegramLink = telegramMatch
      ? telegramMatch[0]
      : `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`

    // Extract stream URLs (if any are rendered)
    const streamUrls = html.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com\/file\/[^\s"'<>]+/g) || []
    const cmdriveUrls = html.match(/https:\/\/[a-z0-9]+\.cmdrive\.xyz\/[^\s"'<>]+/g) || []
    const allStreamUrls = [...new Set([...streamUrls, ...cmdriveUrls])]

    return NextResponse.json({
      id: parseInt(id, 10),
      name, year, poster, type, source,
      overview,
      telegramLink,
      streamUrls: allStreamUrls,
      fetchedAt: new Date().toISOString(),
      sourceUrl: movieUrl,
      error: null,
      method: 'scraperapi',
    })
  } catch (e) {
    console.error('[/api/scrape-movie] error:', e)
    // Fallback: construct Telegram link from ID
    return NextResponse.json({
      id: parseInt(id, 10),
      name, year, poster, type, source,
      overview: '',
      telegramLink: `https://t.me/cinemmbot?start=w_${type === 'movie' ? 'm' : 's'}_${id}`,
      streamUrls: [],
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://cinemm.com/?search=${encodeURIComponent(name)}&type=${type}`,
      error: e instanceof Error ? e.message : 'Scrape failed',
      method: 'error',
    })
  }
}
