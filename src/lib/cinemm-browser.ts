/**
 * Client-side cinemm.com fetcher.
 *
 * Instead of going through our server API (which uses the server's IP and
 * gets rate-limited), this module fetches directly from cinemm.com using
 * the USER's browser IP. Results are cached via /api/cache.
 *
 * CORS note: cinemm.com's Server Actions respond to POST with
 * Content-Type: text/plain, which is a "simple" content type. The
 * Next-Action header is custom and triggers a CORS preflight. If CORS
 * blocks the request, we fall back to the server-side API route.
 */

// Server Action IDs (same as server-side cinemm.ts)
const ACTIONS = {
  search:            '608174a38f0214642b8855d3d6393e4214494192e7',
  getMovieServers:   '40b6fd00069a831ba6225e836a43f8bdd5987d4a22',
  getSeriesDetails:  '400fb0323d1f84386f54ce8b5ac06f35e7f98a363c',
  getEpisodeServers: '4040aab62cc485838fd326fadebc5d6fd74baf2f08',
} as const

const CINEMM_ORIGIN = 'https://cinemm.com'

// ---------------------------------------------------------------------------
// RSC parser (client-side copy — same logic as server-side parseRsc)
// ---------------------------------------------------------------------------

const LINE_START_RE = /^([0-9a-f]+):(T[0-9a-f]+,)?/

function parseRsc(text: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(LINE_START_RE)
    if (!m) { i++; continue }
    const id = m[1]
    const isText = !!m[2]
    const payloadStart = m[0].length
    let payload = line.substring(payloadStart)
    if (isText) {
      i++
      while (i < lines.length) {
        const next = lines[i]
        if (LINE_START_RE.test(next) && next.length > 0) break
        payload += '\n' + next
        i++
      }
      // Check for glued JSON at the end (1:{...})
      const markerStr = '1:{'
      let searchFrom = payload.length
      while (true) {
        const markerPos = payload.lastIndexOf(markerStr, searchFrom)
        if (markerPos <= 0) break
        const afterMarker = payload.substring(markerPos + markerStr.length)
        const trimmedAfter = afterMarker.trimEnd()
        if (trimmedAfter.endsWith('}')) {
          const candidateJson = '{' + trimmedAfter
          try {
            JSON.parse(candidateJson)
            payload = payload.substring(0, markerPos).trimEnd()
            result.set('1', candidateJson)
            break
          } catch {
            // keep searching
          }
        }
        searchFrom = markerPos - 1
      }
    } else {
      i++
    }
    result.set(id, payload)
  }
  return result
}

// ---------------------------------------------------------------------------
// Low-level action call (browser → cinemm.com directly)
// ---------------------------------------------------------------------------

async function callActionBrowser(
  actionId: string,
  args: unknown[],
): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(CINEMM_ORIGIN + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': actionId,
      },
      body: JSON.stringify(args),
    })
    if (!res.ok) return null
    const text = await res.text()
    return parseRsc(text)
  } catch {
    // CORS or network error
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache helpers (via /api/cache)
// ---------------------------------------------------------------------------

async function getCache<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/cache?key=${encodeURIComponent(key)}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!data.found) return null
    return JSON.parse(data.payload) as T
  } catch {
    return null
  }
}

async function setCache(key: string, value: unknown): Promise<void> {
  try {
    await fetch('/api/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, payload: JSON.stringify(value) }),
    })
  } catch {
    // ignore cache write failures
  }
}

// ---------------------------------------------------------------------------
// Types (mirrors of server-side types)
// ---------------------------------------------------------------------------

export interface BrowserSearchItem {
  id: number
  name: string
  year: string
  poster: string
  type: 'movie' | 'series'
  source: string
  tmdbId?: string | null
  imdbId?: string | null
  overview?: string | null
}

export interface BrowserServer {
  name: string
  size: string
  url: string
}

export interface BrowserMovieDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'movie'
  source: string
  overview: string
  servers: BrowserServer[]
  remaining: number
  error: string | null
  fetchedAt: string
  sourceUrl: string
}

export interface BrowserSeason {
  id: number
  name: string
  is_end: number
  episodes: BrowserEpisode[]
}

export interface BrowserEpisode {
  id: number
  name: string
  poster: string
  episode_number: number
  runtime: string
  air_date: string
  is_exclusive: number
  // ... other fields we don't need on the client
  [key: string]: unknown
}

export interface BrowserSeriesDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'series'
  source: string
  overview: string
  seasons: BrowserSeason[]
  remaining: number
  error: string | null
  fetchedAt: string
  sourceUrl: string
}

export interface BrowserEpisodeDetails {
  episodeId: number
  servers: BrowserServer[]
  remaining: number
  error: string | null
  fetchedAt: string
}

// ---------------------------------------------------------------------------
// Public API — browser-side fetchers with cache + retry
// ---------------------------------------------------------------------------

const RETRY_DELAYS = [3000, 5000]

function isRateLimited(lines: Map<string, string>): boolean {
  const raw = lines.get('1')
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; message?: string }
    return parsed.ok === false && !!parsed.message
  } catch {
    return false
  }
}

/**
 * Search cinemm.com for movies or series.
 */
export async function searchCinemmBrowser(
  query: string,
  type: 'movie' | 'series',
): Promise<{ items: BrowserSearchItem[]; cached: boolean }> {
  const key = `search:${query.toLowerCase()}:${type}`
  const cached = await getCache<BrowserSearchItem[]>(key)
  if (cached && cached.length > 0) return { items: cached, cached: true }

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const lines = await callActionBrowser(ACTIONS.search, [query, type])
    if (!lines) return { items: [], cached: false }

    if (isRateLimited(lines) && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }

    const raw = lines.get('1')
    if (!raw) return { items: [], cached: false }
    try {
      const parsed = JSON.parse(raw) as
        | BrowserSearchItem[]
        | { ok: boolean; results: BrowserSearchItem[] }
      const rawItems = Array.isArray(parsed) ? parsed : (parsed.results ?? [])
      const items = rawItems.map((it) => ({
        ...it,
        tmdbId: it.tmdbId === '$undefined' ? null : it.tmdbId,
        imdbId: it.imdbId === '$undefined' ? null : it.imdbId,
        overview: it.overview === '$undefined' ? null : it.overview,
      }))
      if (items.length > 0) await setCache(key, items)
      return { items, cached: false }
    } catch {
      return { items: [], cached: false }
    }
  }
  return { items: [], cached: false }
}

/**
 * Fetch movie details (servers + overview).
 */
export async function getMovieDetailsBrowser(
  id: number,
  source: string,
  name?: string,
  year?: string,
  poster?: string,
): Promise<BrowserMovieDetails> {
  const key = `details:movie:${id}:${source}`
  const cached = await getCache<BrowserMovieDetails>(key)
  if (cached && (cached.servers.length > 0 || cached.overview.length > 0)) {
    return cached
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const lines = await callActionBrowser(ACTIONS.getMovieServers, [id, source])
    if (!lines) {
      return makeMovieError(id, source, name, year, poster, 'FETCH_FAILED')
    }

    if (isRateLimited(lines) && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }

    const result = parseMovieResponse(lines, { id, source, name, year, poster })
    if (result.servers.length > 0 || result.overview.length > 0) {
      if (!result.error) await setCache(key, result)
      return result
    }
    if (result.error === 'RATE_LIMITED' && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }
    return result
  }
  return makeMovieError(id, source, name, year, poster, 'RATE_LIMITED')
}

function parseMovieResponse(
  lines: Map<string, string>,
  ctx: { id: number; source: string; name?: string; year?: string; poster?: string },
): BrowserMovieDetails {
  const raw = lines.get('1')
  let servers: BrowserServer[] = []
  let remaining = 0
  let error: string | null = null
  let overview = ''

  // Extract overview from line "2:" or "10:"
  for (const lineId of ['2', '10']) {
    const candidate = lines.get(lineId)
    if (!candidate) continue
    let text = candidate
    const tMatch = text.match(/^T[0-9a-f]+,(.*)$/s)
    if (tMatch) text = tMatch[1]
    if (text.length > 50) {
      overview = text
      break
    }
  }

  // Extract glued JSON from overview if line "1:" doesn't exist separately
  if (!raw && overview) {
    const markerPos = overview.lastIndexOf('1:{')
    if (markerPos > 0) {
      const afterMarker = overview.substring(markerPos + 2)
      const trimmed = afterMarker.trimEnd()
      if (trimmed.endsWith('}')) {
        try {
          JSON.parse(trimmed)
          lines.set('1', trimmed)
          overview = overview.substring(0, markerPos).trimEnd()
        } catch { /* ignore */ }
      }
    }
  }

  const actualRaw = lines.get('1')
  if (actualRaw) {
    try {
      const parsed = JSON.parse(actualRaw) as {
        ok?: boolean; message?: string; servers?: BrowserServer[]
        remaining?: number; error?: string; overview?: string
      }
      if (parsed.ok === false && parsed.message) error = 'RATE_LIMITED'
      servers = (parsed.servers ?? []).map((s) => ({ ...s, size: s.size ?? 'N/A' }))
      remaining = parsed.remaining ?? 0
      if (!error) error = parsed.error ?? null
      const overviewRef = parsed.overview
      if (typeof overviewRef === 'string' && overviewRef.startsWith('$')) {
        const refText = lines.get(overviewRef.substring(1)) ?? ''
        const tMatch = refText.match(/^T[0-9a-f]+,(.*)$/s)
        if (tMatch) {
          let cleaned = tMatch[1]
          const gluedMarker = cleaned.lastIndexOf('1:{')
          if (gluedMarker > 0) {
            const afterGlued = cleaned.substring(gluedMarker + 2)
            if (afterGlued.trimEnd().endsWith('}')) {
              try { JSON.parse(afterGlued.trimEnd()); cleaned = cleaned.substring(0, gluedMarker) } catch {}
            }
          }
          overview = cleaned
        } else {
          overview = refText
        }
      } else if (typeof overviewRef === 'string' && overviewRef !== '$undefined') {
        overview = overviewRef
      }
    } catch {
      error = 'PARSE_ERROR'
    }
  } else {
    error = 'NO_RETURN_VALUE'
  }

  return {
    id: ctx.id, name: ctx.name ?? '', year: ctx.year ?? '', poster: ctx.poster ?? '',
    type: 'movie', source: ctx.source, overview, servers, remaining, error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(ctx.name ?? '')}&type=movie`,
  }
}

function makeMovieError(
  id: number, source: string, name?: string, year?: string, poster?: string, error = 'RATE_LIMITED',
): BrowserMovieDetails {
  return {
    id, name: name ?? '', year: year ?? '', poster: poster ?? '',
    type: 'movie', source, overview: '', servers: [], remaining: 0, error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=movie`,
  }
}

/**
 * Fetch series details (overview + seasons + episodes).
 */
export async function getSeriesDetailsBrowser(
  id: number,
  source: string,
  name?: string,
  year?: string,
  poster?: string,
): Promise<BrowserSeriesDetails> {
  const key = `details:series:${id}:${source}`
  const cached = await getCache<BrowserSeriesDetails>(key)
  if (cached && cached.overview.length > 0) return cached

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const lines = await callActionBrowser(ACTIONS.getSeriesDetails, [id, source])
    if (!lines) return makeSeriesError(id, source, name, year, poster, 'FETCH_FAILED')

    if (isRateLimited(lines) && attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }

    // Extract overview
    let overview = lines.get('2') ?? lines.get('10') ?? ''
    const tMatch = overview.match(/^T[0-9a-f]+,(.*)$/s)
    if (tMatch) overview = tMatch[1]

    // Parse seasons
    const seasonsJson = lines.get('1') ?? ''
    let seasons: BrowserSeason[] = []
    if (seasonsJson) {
      try {
        const parsed = JSON.parse(seasonsJson) as { ok?: boolean; seasons?: BrowserSeason[] }
        seasons = parsed.seasons ?? []
      } catch { /* ignore */ }
    }

    const hasContent = overview.length > 0 || seasons.length > 0
    if (hasContent) {
      const result: BrowserSeriesDetails = {
        id, name: name ?? '', year: year ?? '', poster: poster ?? '',
        type: 'series', source, overview, seasons, remaining: 0, error: null,
        fetchedAt: new Date().toISOString(),
        sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=series`,
      }
      await setCache(key, result)
      return result
    }

    if (attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }
    return makeSeriesError(id, source, name, year, poster, 'RATE_LIMITED')
  }
  return makeSeriesError(id, source, name, year, poster, 'RATE_LIMITED')
}

function makeSeriesError(
  id: number, source: string, name?: string, year?: string, poster?: string, error = 'RATE_LIMITED',
): BrowserSeriesDetails {
  return {
    id, name: name ?? '', year: year ?? '', poster: poster ?? '',
    type: 'series', source, overview: '', seasons: [], remaining: 0, error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=series`,
  }
}

/**
 * Fetch episode servers.
 */
export async function getEpisodeServersBrowser(
  episodeId: number,
  source: string,
): Promise<BrowserEpisodeDetails> {
  const key = `episode:${episodeId}:${source}`
  const cached = await getCache<BrowserEpisodeDetails>(key)
  if (cached && cached.servers.length > 0) return cached

  const epRetryDelays = [2000, 4000]
  for (let attempt = 0; attempt <= epRetryDelays.length; attempt++) {
    const lines = await callActionBrowser(ACTIONS.getEpisodeServers, [episodeId, source])
    if (!lines) {
      return { episodeId, servers: [], remaining: 0, error: 'FETCH_FAILED', fetchedAt: new Date().toISOString() }
    }

    if (isRateLimited(lines) && attempt < epRetryDelays.length) {
      await new Promise((r) => setTimeout(r, epRetryDelays[attempt]))
      continue
    }

    const raw = lines.get('1')
    if (!raw) {
      return { episodeId, servers: [], remaining: 0, error: 'NO_RETURN_VALUE', fetchedAt: new Date().toISOString() }
    }
    try {
      const parsed = JSON.parse(raw) as {
        ok?: boolean; message?: string; servers?: BrowserServer[]
        remaining?: number; error?: string
      }
      if (parsed.ok === false && parsed.message) {
        if (attempt < epRetryDelays.length) {
          await new Promise((r) => setTimeout(r, epRetryDelays[attempt]))
          continue
        }
        return { episodeId, servers: [], remaining: 0, error: 'RATE_LIMITED', fetchedAt: new Date().toISOString() }
      }
      const servers = (parsed.servers ?? []).map((s) => ({ ...s, size: s.size ?? 'N/A' }))
      const result: BrowserEpisodeDetails = {
        episodeId, servers, remaining: parsed.remaining ?? 0, error: null,
        fetchedAt: new Date().toISOString(),
      }
      if (servers.length > 0) await setCache(key, result)
      return result
    } catch {
      return { episodeId, servers: [], remaining: 0, error: 'PARSE_ERROR', fetchedAt: new Date().toISOString() }
    }
  }
  return { episodeId, servers: [], remaining: 0, error: 'RATE_LIMITED', fetchedAt: new Date().toISOString() }
}
