/**
 * Download a backup of the Railway DB to local disk.
 *
 * Calls /api/backup-db on the Railway server and saves the result as a
 * timestamped JSON file. Bro can run this from Termux before Railway
 * trial expires, or as a regular backup routine.
 *
 * Usage:
 *   node scripts/download-backup.mjs                    # uses BACKUP_TOKEN env
 *   BACKUP_TOKEN=secret123 node scripts/download-backup.mjs
 *
 * Optional env vars:
 *   RAILWAY_URL     — default https://cinemmscraper-production.up.railway.app
 *   BACKUP_TOKEN    — required (set on Railway via env var)
 *   BACKUP_DIR      — default ./backups
 *
 * Output files (in ./backups/):
 *   cinemmscraper-backup-YYYY-MM-DD.json
 *   cinemmscraper-backup-latest.json (symlink/copy of the most recent)
 */

import fs from 'fs'
import path from 'path'

const RAILWAY_URL = (
  process.env.RAILWAY_URL || 'https://cinemmscraper-production.up.railway.app'
).replace(/\/+$/, '')

const TOKEN = process.env.BACKUP_TOKEN
const BACKUP_DIR = process.env.BACKUP_DIR || './backups'

if (!TOKEN) {
  console.error('❌ BACKUP_TOKEN env var is required.')
  console.error('   Set it on Railway dashboard → Variables → BACKUP_TOKEN')
  console.error('   Then run: BACKUP_TOKEN=your_token node scripts/download-backup.mjs')
  process.exit(1)
}

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Download DB Backup from Railway')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(`  Railway URL: ${RAILWAY_URL}`)
  console.log(`  Backup dir:  ${BACKUP_DIR}`)
  console.log(`  Token:       ${'*'.repeat(TOKEN.length - 4)}${TOKEN.slice(-4)}\n`)

  // Create backup dir
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
  }

  const url = `${RAILWAY_URL}/api/backup-db?token=${encodeURIComponent(TOKEN)}`
  console.log(`⬇️  Downloading backup...\n`)

  const start = Date.now()
  const res = await fetch(url, {
    signal: AbortSignal.timeout(120000),
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  if (!res.ok) {
    console.error(`\n❌ Backup failed: HTTP ${res.status} ${res.statusText}`)
    const body = await res.text().catch(() => '')
    if (body) console.error(`   Body: ${body.slice(0, 300)}`)
    if (res.status === 401) {
      console.error('\n   → BACKUP_TOKEN is wrong. Check Railway env vars.')
    } else if (res.status === 503) {
      console.error('\n   → BACKUP_TOKEN not set on Railway. Set it in Variables.')
    }
    process.exit(1)
  }

  const text = await res.text()
  const sizeMB = (Buffer.byteLength(text) / (1024 * 1024)).toFixed(2)

  // Parse to validate + extract stats
  let backup: any
  try {
    backup = JSON.parse(text)
  } catch {
    console.error('❌ Backup response is not valid JSON')
    process.exit(1)
  }

  const stats = backup.stats || {}
  const dateStr = backup.exportedAt
    ? new Date(backup.exportedAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  console.log(`✅ Downloaded in ${elapsed}s (${sizeMB} MB)`)
  console.log(`   Exported at:    ${backup.exportedAt}`)
  console.log(`   Stream URLs:    ${stats.manualStreamUrls || 0}`)
  console.log(`   Cache entries:  ${stats.cacheEntries || 0}`)

  // Save with date-stamped filename
  const datedFile = path.join(BACKUP_DIR, `cinemmscraper-backup-${dateStr}.json`)
  fs.writeFileSync(datedFile, text)
  console.log(`\n💾 Saved to: ${datedFile}`)

  // Also save as "latest" (overwrite any previous latest)
  const latestFile = path.join(BACKUP_DIR, `cinemmscraper-backup-latest.json`)
  fs.writeFileSync(latestFile, text)
  console.log(`💾 Saved to: ${latestFile}`)

  // List all backups in dir
  console.log(`\n📁 All backups in ${BACKUP_DIR}/:`)
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('cinemmscraper-backup-') && f.endsWith('.json'))
    .sort()
  for (const f of files) {
    const stat = fs.statSync(path.join(BACKUP_DIR, f))
    const size = (stat.size / 1024).toFixed(1)
    console.log(`   ${f}  (${size} KB)`)
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  ✅ Backup complete!')
  console.log('═══════════════════════════════════════════════════════')
  console.log('\nTo restore on a new host:')
  console.log('  curl -X POST -H "Content-Type: application/json" \\')
  console.log('    --data-binary @backups/cinemmscraper-backup-latest.json \\')
  console.log('    "https://NEW-HOST/api/restore-db?token=YOUR_TOKEN"')
  console.log('')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
