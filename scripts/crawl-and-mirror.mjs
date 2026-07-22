/**
 * Combined command: crawl movies/series THEN generate mirror URLs.
 *
 * Runs batch-crawl.mjs (crawl new movies) then automatically runs
 * generate-mirrors.mjs (create mirror URLs from the new entries).
 *
 * Usage:
 *   node scripts/crawl-and-mirror.mjs                  # movies, 20 batch
 *   node scripts/crawl-and-mirror.mjs movie 50         # movies, 50 batch
 *   node scripts/crawl-and-mirror.mjs series 20        # series, 20 batch
 *
 * Optional env vars (same as batch-crawl.mjs + generate-mirrors.mjs):
 *   CRAWL_CONCURRENCY=1     — use 1 for VPN stability (recommended)
 *   DATABASE_URL=...        — required for mirror generation
 *   MIRROR_DRY_RUN=true     — skip actual mirror insert (test only)
 */

import { execSync } from 'child_process'
import fs from 'fs'

const type = process.argv[2] || 'movie'
const batchSize = process.argv[3] || '20'

console.log('═══════════════════════════════════════════════════════')
console.log('  Crawl + Mirror Generator (Combined)')
console.log('═══════════════════════════════════════════════════════\n')
console.log(`  Type:        ${type}`)
console.log(`  Batch size:  ${batchSize}`)
console.log(`  Concurrency: ${process.env.CRAWL_CONCURRENCY || '3 (default)'}`)
console.log('')

// ============================================================
// Phase 1: Crawl new movies/series via cinemm.com
// ============================================================
console.log('━━━ Phase 1: Crawl via cinemm.com ━━━\n')

const crawlCmd = `node scripts/batch-crawl.mjs ${type} ${batchSize}`
console.log(`> ${crawlCmd}\n`)

try {
  execSync(crawlCmd, { stdio: 'inherit' })
} catch (e) {
  console.error('\n❌ Crawl phase failed:', e.message)
  process.exit(1)
}

// ============================================================
// Phase 2: Generate mirror URLs from new entries
// ============================================================
console.log('\n━━━ Phase 2: Generate Mirror URLs ━━━\n')

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL env var is required for mirror generation')
  console.error('   Skipping mirror phase. To run separately:')
  console.error('   DATABASE_URL="postgresql://..." node scripts/generate-mirrors.mjs')
  process.exit(0)
}

const mirrorCmd = 'node scripts/generate-mirrors.mjs'
console.log(`> ${mirrorCmd}\n`)

try {
  execSync(mirrorCmd, { stdio: 'inherit' })
} catch (e) {
  console.error('\n❌ Mirror phase failed:', e.message)
  process.exit(1)
}

console.log('\n═══════════════════════════════════════════════════════')
console.log('  ✅ Combined crawl + mirror complete!')
console.log('═══════════════════════════════════════════════════════')
console.log('\n🔍 Verify on the website:')
console.log('   https://cinemmscraper-rr48.vercel.app')
console.log('')
