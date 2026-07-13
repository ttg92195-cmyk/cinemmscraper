// Check if Playwright is available
try {
  const { chromium } = await import('playwright')
  console.log('✅ Playwright is available!')
  
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  
  // Go to cinemm.com and search for Inception
  await page.goto('https://cinemm.com/?search=inception&type=movie', { waitUntil: 'networkidle' })
  console.log('Page loaded')
  
  // Wait a bit for dynamic content
  await page.waitForTimeout(2000)
  
  // Get page content
  const content = await page.content()
  console.log('Page content length:', content.length)
  
  // Look for "Show Sources" button
  const showSourcesButton = await page.locator('button:has-text("Show Sources")').count()
  console.log('Show Sources buttons:', showSourcesButton)
  
  // Look for "Watch on Telegram" button
  const telegramButton = await page.locator('a:has-text("Telegram"), button:has-text("Telegram")').count()
  console.log('Telegram buttons:', telegramButton)
  
  // Look for any t.me links
  const tmeLinks = await page.locator('a[href*="t.me"]').count()
  console.log('t.me links:', tmeLinks)
  
  // Try to find and click the first result
  const firstResult = await page.locator('button:has-text("Inception")').first()
  if (await firstResult.count() > 0) {
    console.log('Found Inception result, clicking...')
    await firstResult.click()
    await page.waitForTimeout(3000)
    
    // Now look for Show Sources button
    const showSources = await page.locator('button:has-text("Show Sources")').count()
    console.log('Show Sources buttons after click:', showSources)
    
    // Look for any stream URLs in the page
    const pageContent = await page.content()
    const streamUrls = pageContent.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com[^\s"'<>]+/g) || []
    console.log('Stream URLs found:', streamUrls.length)
    streamUrls.slice(0, 5).forEach(u => console.log(`  ${u.substring(0, 120)}`))
    
    // Look for any download/stream links
    const allLinks = await page.locator('a[href*="stream"], a[href*="cmdrive"]').count()
    console.log('Download/stream links:', allLinks)
    
    // Try clicking Show Sources
    if (showSources > 0) {
      console.log('Clicking Show Sources...')
      await page.locator('button:has-text("Show Sources")').first().click()
      await page.waitForTimeout(2000)
      
      // Check for stream URLs after clicking
      const contentAfter = await page.content()
      const urlsAfter = contentAfter.match(/https:\/\/stream\.(cmreel|bioscopeapp)\.com[^\s"'<>]+/g) || []
      console.log('Stream URLs after Show Sources:', urlsAfter.length)
      urlsAfter.slice(0, 5).forEach(u => console.log(`  ${u.substring(0, 120)}`))
      
      // Look for t.me links
      const tmeAfter = contentAfter.match(/https:\/\/t\.me\/[^\s"'<>]+/g) || []
      console.log('Telegram links after Show Sources:', tmeAfter.length)
      tmeAfter.forEach(u => console.log(`  ${u}`))
    }
  }
  
  await browser.close()
  console.log('\n✅ Playwright test complete!')
} catch (e) {
  console.log('❌ Playwright not available:', e instanceof Error ? e.message : e)
  console.log('\nInstalling playwright...')
}
