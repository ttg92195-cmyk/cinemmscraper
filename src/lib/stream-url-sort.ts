/**
 * Sort stream URL entries by host preference + quality preference.
 *
 * Bro's requirement (2026-07-23, refined):
 *   Sort by TWO levels:
 *
 *   1. Host priority (PRIMARY sort):
 *        1. md2.streammedia2.com         (Bro's preferred — fastest mirror)
 *        2. media.bioscopeapplication.com
 *        3. stream.cmreel.com            (cinemm.com's primary host)
 *        4. stream.bioscopeapp.com       (cinemm.com's secondary host)
 *        5. cmappfirst*.cmdrive.xyz      (cmdrive hosts — slower)
 *        6. cmappsecond*.cmdrive.xyz
 *        7. cmapp.*.cmdrive.xyz          (any other cmdrive)
 *        8. everything else (alphabetical, last)
 *
 *   2. Quality priority (SECONDARY sort, within same host):
 *        1. 4K / 2160P                (highest quality)
 *        2. 1080P
 *        3. 720P
 *        4. 480P
 *        5. STD / unknown             (last)
 *
 * Example result for a movie with 4K + 1080P + 720P × 4 hosts:
 *   1. 4K    | md2.streammedia2.com
 *   2. 1080P | md2.streammedia2.com
 *   3. 720P  | md2.streammedia2.com
 *   4. 4K    | media.bioscopeapplication.com
 *   5. 1080P | media.bioscopeapplication.com
 *   6. 720P  | media.bioscopeapplication.com
 *   7. 4K    | stream.cmreel.com
 *   8. 1080P | stream.cmreel.com
 *   9. 720P  | stream.cmreel.com
 *  10. 4K    | stream.bioscopeapp.com
 *  11. 1080P | stream.bioscopeapp.com
 *  12. 720P  | stream.bioscopeapp.com
 *
 * Used by:
 *   - src/app/api/manual-link/route.ts (GET handler)
 *   - src/app/api/details/route.ts (movie details — top-level URLs)
 *   - src/app/api/episode-servers/route.ts (episode-level URLs)
 */

interface StreamUrlEntry {
  host: string
  quality: string
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Host priority — Bro's preferred order (mirror hosts first)
// ---------------------------------------------------------------------------

const HOST_PRIORITY: Array<{ pattern: RegExp; rank: number }> = [
  // Mirror hosts (Bro's discovery — preferred)
  { pattern: /^md2\.streammedia2\.com$/i, rank: 1 },
  { pattern: /^media\.bioscopeapplication\.com$/i, rank: 2 },
  // cinemm.com's original hosts
  { pattern: /^stream\.cmreel\.com$/i, rank: 3 },
  { pattern: /^stream\.bioscopeapp\.com$/i, rank: 4 },
  // cmdrive hosts (slower)
  { pattern: /^cmappfirst\d*\.cmdrive\.xyz$/i, rank: 5 },
  { pattern: /^cmappsecond\d*\.cmdrive\.xyz$/i, rank: 6 },
  { pattern: /^cmapp.*\.cmdrive\.xyz$/i, rank: 7 },
]

function getHostRank(host: string): number {
  for (const { pattern, rank } of HOST_PRIORITY) {
    if (pattern.test(host)) return rank
  }
  return 99 // unknown hosts go last
}

// ---------------------------------------------------------------------------
// Quality priority
// ---------------------------------------------------------------------------

/**
 * Parse quality string into a numeric rank (lower = higher quality).
 *
 * cinemm.com returns quality strings like: "4K", "2160P", "1080P", "720P",
 * "480P", "SD", "" (empty).
 *
 * We normalize:
 *   "4K"     → 1  (highest)
 *   "2160P"  → 1  (same as 4K — 2160p = 4K UHD)
 *   "1080P"  → 2
 *   "720P"   → 3
 *   "480P"   → 4
 *   "SD"     → 5  (standard definition, unknown resolution)
 *   ""       → 5  (empty — treat as SD)
 *   unknown  → 6  (last resort)
 *
 * NOTE: We also accept "STD" (legacy — was used before the SD rename)
 *       for backward compatibility with existing database rows.
 */
function getQualityRank(quality: string): number {
  if (!quality) return 5
  const q = quality.toUpperCase().trim()
  // 4K / 2160P — highest
  if (q === '4K' || q === '2160P' || q === '2160') return 1
  // 1080P
  if (q === '1080P' || q === '1080') return 2
  // 720P
  if (q === '720P' || q === '720') return 3
  // 480P
  if (q === '480P' || q === '480') return 4
  // SD / STD / standard / unknown text
  if (q === 'SD' || q === 'STD' || q === 'STANDARD') return 5
  // Try to parse as number (e.g. "1440P" → between 1080 and 2160)
  const numMatch = q.match(/^(\d{3,4})P?$/)
  if (numMatch) {
    const n = parseInt(numMatch[1], 10)
    if (n >= 2000) return 1 // 2160p / 4K range
    if (n >= 1400) return 1.5 // 1440p / 2K
    if (n >= 1000) return 2 // 1080p range
    if (n >= 600) return 3 // 720p range
    if (n >= 400) return 4 // 480p range
  }
  return 6 // unknown quality — last
}

// ---------------------------------------------------------------------------
// Main sort function
// ---------------------------------------------------------------------------

export function sortStreamUrlsByHostPreference<T extends StreamUrlEntry>(
  entries: T[],
): T[] {
  return [...entries].sort((a, b) => {
    // Primary: host rank (mirror hosts first, cmdrive last)
    const hostRankA = getHostRank(a.host)
    const hostRankB = getHostRank(b.host)
    if (hostRankA !== hostRankB) return hostRankA - hostRankB

    // Secondary: quality rank (4K first, STD last)
    const qualityRankA = getQualityRank(a.quality)
    const qualityRankB = getQualityRank(b.quality)
    if (qualityRankA !== qualityRankB) return qualityRankA - qualityRankB

    // Tertiary: createdAt DESC (newest first) — stable tie-breaker
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
}
