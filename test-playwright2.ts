import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// Set realistic user agent
await page.setExtraHTTPHeaders({
  'Accept-Language': 'en-US,en;q=0.9',
})

// Go to cinemm.com
await page.goto('https://cinemm.com/', { waitUntil: 'networkidle' })
console.log('Homepage loaded')

// Type in search box
await page.fill('input[type="text"], input[placeholder*="Search"]', 'inception')
await page.waitForTimeout(500)

// Click search button or press Enter
const searchBtn = await page.locator('button:has-text("Search")').count()
console.log('Search buttons:', searchBtn)
if (searchBtn > 0) {
  await page.locator('button:has-text("Search")').click()
} else {
  await page.keyboard.press('Enter')
}
await page.waitForTimeout(3000)

// Check what we see
const content = await page.content()
console.log('Content length after search:', content.length)

// Look for movie results
const movieButtons = await page.locator('button:has-text("Inception")').count()
console.log('Inception buttons:', movieButtons)

// Click first Inception result
if (movieButtons > 0) {
  await page.locator('button:has-text("Inception")').first().click()
  await page.waitForTimeout(5000)
  
  const detailContent = await page.content()
  console.log('\nDetail page content length:', detailContent.length)
  
  // Look for all buttons
  const buttons = await page.locator('button').allTextContents()
  console.log('\nButtons on page:')
  buttons.forEach(b => { if (b.trim()) console.log(`  "${b.trim()}"`) })
  
  // Look for all links
  const links = await page.locator('a').evaluateAll(els => 
    els.map(el => ({ text: el.textContent?.trim(), href: el.getAttribute('href') }))
  )
  console.log('\nLinks on page:')
  links.forEach(l => { if (l.text || l.href) console.log(`  "${l.text}" → ${l.href}`) })
  
  // Look for Show Sources button
  const showSources = await page.locator('button:has-text("Show Sources"), button:has-text("Sources")').count()
  console.log('\nShow/Sources buttons:', showSources)
  
  if (showSources > 0) {
    console.log('Clicking Show Sources...')
    await page.locator('button:has-text("Show Sources"), button:has-text("Sources")').first().click()
    await page.waitForTimeout(3000)
    
    const afterContent = await page.content()
    console.log('Content after Show Sources:', afterContent.length)
    
    // Look for stream URLs
    const streamUrls = afterContent.match(/https:\/\/stream\.[^\s"'<>]+/g) || []
    console.log('Stream URLs:', streamUrls.length)
    streamUrls.slice(0, 5).forEach(u => console.log(`  ${u.substring(0, 150)}`))
    
    // Look for t.me links
    const tmeLinks = afterContent.match(/https:\/\/t\.me\/[^\s"'<>]+/g) || []
    console.log('Telegram links:', tmeLinks.length)
    tmeLinks.forEach(u => console.log(`  ${u}`))
    
    // Look for all new buttons after click
    const newButtons = await page.locator('button').allTextContents()
    console.log('\nButtons after Show Sources:')
    newButtons.forEach(b => { if (b.trim()) console.log(`  "${b.trim()}"`) })
    
    // Look for all links after click
    const newLinks = await page.locator('a').evaluateAll(els =>
      els.map(el => ({ text: el.textContent?.trim(), href: el.getAttribute('href') }))
    )
    console.log('\nLinks after Show Sources:')
    newLinks.forEach(l => { if (l.text || l.href) console.log(`  "${l.text}" → ${l.href}`))
  }
  
  // Look for Telegram button/link
  const tgBtn = await page.locator('a:has-text("Telegram"), button:has-text("Telegram")').count()
  console.log('\nTelegram buttons/links:', tgBtn)
  if (tgBtn > 0) {
    const tgHref = await page.locator('a:has-text("Telegram")').first().getAttribute('href')
    console.log('Telegram href:', tgHref)
  }
}

await browser.close()
console.log('\n✅ Done!')
