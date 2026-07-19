/**
 * Sort stream URL entries by host preference.
 *
 * Bro's requirement (2026-07-19):
 *   When displaying stream URLs on the website, they should appear in this
 *   order (not the order they were inserted into the DB):
 *     1. stream.cmreel.com         (best — fastest, most reliable)
 *     2. stream.bioscopeapp.com
 *     3. cmappfirst*.cmdrive.xyz   (slower but available)
 *     4. cmappsecond*.cmdrive.xyz
 *     5. everything else (alphabetical, last)
 *
 * Within each host group, entries are sorted by createdAt DESC (newest first).
 *
 * Why this exists:
 *   cinemm.com returns servers as [Tube 1, Server 1, Cloud 1] where each
 *   Tube/Server/Cloud maps to a different host:
 *     Tube 1   → stream.cmreel.com
 *     Server 1 → stream.bioscopeapp.com
 *     Cloud 1  → cmappfirst*.cmdrive.xyz
 *   But we insert them into the DB in the order received, then query with
 *   `orderBy: { createdAt: 'desc' }`. This scrambles the natural order.
 *   This helper restores the preferred display order based on host.
 *
 * Used by:
 *   - src/app/api/manual-link/route.ts (GET handler)
 *   - src/app/api/details/route.ts (movie details — top-level URLs)
 *   - src/app/api/episode-servers/route.ts (episode-level URLs)
 */

interface StreamUrlEntry {
  host: string
  createdAt: Date
}

const HOST_PRIORITY: Array<{ pattern: RegExp; rank: number; label: string }> = [
  { pattern: /^stream\.cmreel\.com$/i, rank: 1, label: 'cmreel' },
  { pattern: /^stream\.bioscopeapp\.com$/i, rank: 2, label: 'bioscopeapp' },
  { pattern: /^cmappfirst\d*\.cmdrive\.xyz$/i, rank: 3, label: 'cmappfirst' },
  { pattern: /^cmappsecond\d*\.cmdrive\.xyz$/i, rank: 4, label: 'cmappsecond' },
  { pattern: /^cmapp.*\.cmdrive\.xyz$/i, rank: 5, label: 'cmapp-other' },
]

function getHostRank(host: string): number {
  for (const { pattern, rank } of HOST_PRIORITY) {
    if (pattern.test(host)) return rank
  }
  return 99 // unknown hosts go last
}

export function sortStreamUrlsByHostPreference<T extends StreamUrlEntry>(
  entries: T[],
): T[] {
  return [...entries].sort((a, b) => {
    const rankA = getHostRank(a.host)
    const rankB = getHostRank(b.host)
    if (rankA !== rankB) return rankA - rankB
    // Same host group — newest first
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
}
