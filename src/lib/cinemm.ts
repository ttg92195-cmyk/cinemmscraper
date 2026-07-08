/**
 * Cinemm.com Client
 * -----------------
 * Calls cinemm.com's Next.js Server Actions directly to fetch:
 *   - Search results (movies & series)
 *   - Movie details (servers + overview)
 *   - Series details (overview with embedded seasons/episodes info)
 *
 * The site uses Next.js Server Actions, so we POST to "/" with the
 * "Next-Action: <action-id>" header and a JSON-encoded args array as
 * the body. The response is in React Server Component (RSC) wire format:
 *   <id>:<json>            — JSON value
 *   <id>:T<hex-len>,<text> — chunked text
 * where <id> is a hex line key. The action's return value is on line "1:"
 * (when present). Long text values appear on higher-numbered lines as
 * "T" chunks and are referenced from the JSON as "$<id>".
 */

import { db } from '@/lib/db'

const CINEMM_ORIGIN = 'https://cinemm.com'

// Server Action IDs (extracted from cinemm.com's bundled JS)
const ACTIONS = {
  search:              '6018fac11e9b775fd3a7f877cdc4ab1b312b8e978c',
  getMovieServers:     '401dd7f7ed7453fdfdcc55d28458444ecec9e4cc8d',
  getSeriesDetails:    '40fbf1a13bd851f36bdfb8c1d23835fd1fc16b9ca4',
  getEpisodeServers:   '4049901391797f2c009e9c215a59ebc6679aef2e62',
  identifyUser:        '6077a1a88313137459881a82cca9e76114af8993f6',
} as const

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/x-component',
  'Content-Type': 'text/plain;charset=UTF-8',
  'Next-Router-State-Tree':
    '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  Referer: `${CINEMM_ORIGIN}/`,
  Origin: CINEMM_ORIGIN,
} as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaType = 'movie' | 'series'

export interface CinemmSearchItem {
  id: number
  name: string
  year: string
  poster: string
  type: MediaType
  source: string
  tmdbId?: string | null
  imdbId?: string | null
  overview?: string | null
}

export interface CinemmServer {
  name: string
  size: string  // 'N/A' when source returns null
  url: string
}

/** A single episode inside a season (returned by getSeriesDetails). */
export interface CinemmEpisode {
  id: number
  tv_show_id: number
  season_id: number
  season_number: number
  season_name: string
  tmdb_episode_id: number | null
  previous_episode_id: number | null
  next_episode_id: number | null
  name: string
  poster: string
  episode_number: number
  runtime: string
  air_date: string
  is_last_play: number
  only_bioscope: number
  is_exclusive: number
  exclusive_text: string
  mobile_exclusive_text: string
  resume_time: string | null
  tvshow_streaming_links: unknown[]
  tvshow_download_links: unknown[]
}

/** A season inside a series (returned by getSeriesDetails). */
export interface CinemmSeason {
  id: number
  name: string
  is_end: number
  episodes: CinemmEpisode[]
}

/** Episode servers (returned by getEpisodeServers). */
export interface CinemmEpisodeDetails {
  episodeId: number
  servers: CinemmServer[]
  remaining: number
  error: string | null
  fetchedAt: string
}

export interface CinemmMovieDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'movie'
  source: string
  overview: string
  servers: CinemmServer[]
  remaining: number
  error?: string | null
  fetchedAt: string
  sourceUrl: string
}

export interface CinemmSeriesDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'series'
  source: string
  overview: string
  seasons: CinemmSeason[]
  remaining: number
  error?: string | null
  fetchedAt: string
  sourceUrl: string
}

export type CinemmDetails = CinemmMovieDetails | CinemmSeriesDetails

// ---------------------------------------------------------------------------
// RSC response parser
// ---------------------------------------------------------------------------
//
// The RSC wire format is line-oriented. Each line is "<id>:<payload>" where
// <id> is a hex string. Text chunks have a "T<hex>," prefix before the
// payload, e.g. "10:T16cc,text...". Text payloads may contain embedded
// newlines, so we must consume subsequent physical lines until we see a
// new "<id>:" prefix.
//
// IMPORTANT BUG WORKAROUND: cinemm.com's RSC serialization sometimes forgets
// to insert a newline between the end of a text chunk (line "10:") and the
// next RSC line (line "1:"). The result is that the JSON return value
// appears *concatenated* to the end of the text content, e.g.:
//
//   10:T16cc,Some overview text...Translated by Mr.Anderson1:{"servers":[...]}
//
// To handle this, after collecting each text chunk we look for an embedded
// "<hex>:{...}" pattern (JSON return value glued to the end of the text)
// and split it out as a separate line entry.

const LINE_START_RE = /^([0-9a-f]+):(T[0-9a-f]+,)?/

function parseRsc(text: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(LINE_START_RE)
    if (!m) {
      i++
      continue
    }
    const id = m[1]
    const isText = !!m[2]
    const payloadStart = m[0].length
    let payload = line.substring(payloadStart)
    if (isText) {
      // Text chunks may span multiple physical newlines because the content
      // itself contains \n. Append following lines until we see a new id prefix.
      i++
      while (i < lines.length) {
        const next = lines[i]
        if (LINE_START_RE.test(next) && next.length > 0) break
        payload += '\n' + next
        i++
      }
      // Check for a glued JSON return value at the end of the text.
      // The action's return value always lives on RSC line "1:".
      // We look for "1:{" patterns in the payload. To distinguish a real
      // RSC line "1:" from a coincidental "1:" inside text content (like
      // "Drama1:" or "Step1:"), we require that the JSON after "1:{" must
      // be valid (parseable) and span to the end of the payload.
      const markerStr = '1:{'
      let searchFrom = payload.length
      while (true) {
        const markerPos = payload.lastIndexOf(markerStr, searchFrom)
        if (markerPos <= 0) break
        const afterMarker = payload.substring(markerPos + markerStr.length)
        if (afterMarker.endsWith('}')) {
          const candidateJson = '{' + afterMarker
          try {
            JSON.parse(candidateJson)
            // Valid JSON found — this is the glued return value.
            payload = payload.substring(0, markerPos)
            result.set('1', candidateJson)
            break
          } catch {
            // Not valid JSON, keep searching backwards.
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
// Low-level action call (with retry & quota backoff)
// ---------------------------------------------------------------------------

async function callAction(
  actionId: string,
  args: unknown[],
  opts: { retries?: number } = {},
): Promise<{ lines: Map<string, string>; raw: string }> {
  const retries = opts.retries ?? 1
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify(args)
      const res = await fetch(CINEMM_ORIGIN + '/', {
        method: 'POST',
        headers: {
          ...COMMON_HEADERS,
          'Next-Action': actionId,
        },
        body,
      })
      if (!res.ok) {
        throw new Error(`cinemm.com action ${actionId} failed: HTTP ${res.status}`)
      }
      const text = await res.text()
      return { lines: parseRsc(text), raw: text }
    } catch (e) {
      lastError = e
      // Brief backoff before retry
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unknown error calling cinemm.com')
}

/**
 * Call the identifyUserAction to mint a fresh visitor UUID. cinemm.com tracks
 * quota per-visitor-UUID (each visitor gets a few free detail fetches before
 * QUOTA_EXCEEDED). By calling this before a detail fetch, we can request a
 * fresh UUID with full quota.
 *
 * Note: the site's Set-Cookie response associates the UUID with future
 * requests automatically; we don't need to do anything special with it.
 * Returns the visitor info object.
 */
async function refreshVisitorQuota(): Promise<{
  uuid: string
  pin: string
  usageCount: number
  lastReset: string
  isPremium: boolean
  bonusCredits: number
  remaining: number
} | null> {
  try {
    // Generate a random fingerprint-like ID (the site accepts any string)
    const fp = Array.from({ length: 20 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('')
    const { lines } = await callAction(ACTIONS.identifyUser, [fp, undefined])
    const raw = lines.get('1')
    if (!raw) return null
    return JSON.parse(raw)
  } catch (e) {
    console.error('refreshVisitorQuota failed:', e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const row = await db.cinemmCache.findUnique({ where: { cacheKey: key } })
    if (!row) return null
    return JSON.parse(row.payload) as T
  } catch {
    return null
  }
}

async function setCached<T>(key: string, value: T): Promise<void> {
  try {
    await db.cinemmCache.upsert({
      where: { cacheKey: key },
      create: { cacheKey: key, payload: JSON.stringify(value) },
      update: { payload: JSON.stringify(value) },
    })
  } catch (e) {
    console.error('Cache write failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search cinemm.com for movies or series.
 * Not quota-limited — safe to call freely.
 */
export async function searchCinemm(
  query: string,
  type: MediaType,
  opts: { useCache?: boolean } = {},
): Promise<{ items: CinemmSearchItem[]; cached: boolean }> {
  const key = `search:${query.toLowerCase()}:${type}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmSearchItem[]>(key)
    if (cached && cached.length > 0) return { items: cached, cached: true }
  }

  const { lines } = await callAction(ACTIONS.search, [query, type])
  const raw = lines.get('1')
  let items: CinemmSearchItem[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CinemmSearchItem[]
      items = parsed.map((it) => ({
        ...it,
        tmdbId: it.tmdbId === '$undefined' ? null : it.tmdbId,
        imdbId: it.imdbId === '$undefined' ? null : it.imdbId,
        overview: it.overview === '$undefined' ? null : it.overview,
      }))
    } catch {
      items = []
    }
  }
  // Only cache non-empty results to avoid caching transient failures
  if (items.length > 0) await setCached(key, items)
  return { items, cached: false }
}

/**
 * Fetch full details for a movie (servers + overview).
 * Quota-limited — use caching to avoid burning quota.
 *
 * If the source returns QUOTA_EXCEEDED, we surface that to the caller as
 * `error: "QUOTA_EXCEEDED"` and DO NOT cache the empty result, so the next
 * call can retry.
 */
export async function getMovieDetails(
  id: number,
  source: string,
  name?: string,
  year?: string,
  poster?: string,
  opts: { useCache?: boolean } = {},
): Promise<CinemmMovieDetails> {
  const key = `details:movie:${id}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmMovieDetails>(key)
    // Only return cached result if it has actual content (servers or overview)
    if (cached && (cached.servers.length > 0 || cached.overview.length > 0)) {
      return cached
    }
  }

  let { lines } = await callAction(ACTIONS.getMovieServers, [id, source])
  let raw = lines.get('1')
  // If we got QUOTA_EXCEEDED, try refreshing the visitor quota and retrying once.
  if (raw && JSON.parse(raw).error === 'QUOTA_EXCEEDED') {
    const refreshed = await refreshVisitorQuota()
    if (refreshed && refreshed.remaining > 0) {
      const retry = await callAction(ACTIONS.getMovieServers, [id, source])
      lines = retry.lines
      raw = retry.lines.get('1')
    }
  }
  let servers: CinemmServer[] = []
  let remaining = 0
  let error: string | null = null
  let overview = ''

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        servers?: CinemmServer[]
        remaining?: number
        error?: string
        overview?: string
      }
      servers = (parsed.servers ?? []).map((s) => ({
        ...s,
        size: s.size ?? 'N/A',
      }))
      remaining = parsed.remaining ?? 0
      error = parsed.error ?? null
      // Overview is a reference like "$10" pointing to the text chunk on line 10
      const overviewRef = parsed.overview
      if (typeof overviewRef === 'string' && overviewRef.startsWith('$')) {
        overview = lines.get(overviewRef.substring(1)) ?? ''
        // Some text chunks still have the "T<hex>," prefix attached
        const tMatch = overview.match(/^T[0-9a-f]+,(.*)$/s)
        if (tMatch) overview = tMatch[1]
      } else if (typeof overviewRef === 'string' && overviewRef !== '$undefined') {
        overview = overviewRef
      }
    } catch (e) {
      console.error('Failed to parse movie details JSON:', e)
      error = 'PARSE_ERROR'
    }
  } else {
    // No "1:" line at all — treat as an error so we don't cache empty result
    error = 'NO_RETURN_VALUE'
  }

  const result: CinemmMovieDetails = {
    id,
    name: name ?? '',
    year: year ?? '',
    poster: poster ?? '',
    type: 'movie',
    source,
    overview,
    servers,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=movie`,
  }
  // Only cache results that have real content
  if (!error && (servers.length > 0 || overview.length > 0)) {
    await setCached(key, result)
  }
  return result
}

/**
 * Fetch full details for a series (overview with embedded seasons/episodes).
 * Quota-limited — use caching to avoid burning quota.
 */
export async function getSeriesDetails(
  id: number,
  source: string,
  name?: string,
  year?: string,
  poster?: string,
  opts: { useCache?: boolean } = {},
): Promise<CinemmSeriesDetails> {
  const key = `details:series:${id}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmSeriesDetails>(key)
    if (cached && cached.overview.length > 0) return cached
  }

  let { lines } = await callAction(ACTIONS.getSeriesDetails, [id, source])
  let overview = lines.get('10') ?? ''
  // Strip "T<hex>," prefix if still attached
  const tMatch = overview.match(/^T[0-9a-f]+,(.*)$/s)
  if (tMatch) overview = tMatch[1]
  // The seasons JSON return value (line "1:") is glued to the end of the
  // overview text by cinemm.com's buggy RSC serializer. The parser should
  // already have split it into line "1:" — but double-check in case.
  let seasonsJson = lines.get('1') ?? ''

  // If we got an empty overview (likely QUOTA_EXCEEDED), try refreshing quota.
  if (!overview) {
    const refreshed = await refreshVisitorQuota()
    if (refreshed && refreshed.remaining > 0) {
      const retry = await callAction(ACTIONS.getSeriesDetails, [id, source])
      lines = retry.lines
      overview = retry.lines.get('10') ?? ''
      const tRetry = overview.match(/^T[0-9a-f]+,(.*)$/s)
      if (tRetry) overview = tRetry[1]
      seasonsJson = retry.lines.get('1') ?? ''
    }
  }

  // Parse seasons structure from the JSON return value on line "1:".
  // The action returns: { seasons: [...], overview: "$<refId>" }
  let seasons: CinemmSeason[] = []
  if (seasonsJson) {
    try {
      const parsed = JSON.parse(seasonsJson) as { seasons?: CinemmSeason[] }
      seasons = parsed.seasons ?? []
    } catch (e) {
      console.error('Failed to parse seasons JSON:', e)
    }
  }

  // Look for remaining quota info on line "6:" (initialUser payload)
  let remaining = 0
  const userPayload = lines.get('6')
  if (userPayload) {
    const m = userPayload.match(/"remaining"\s*:\s*(\d+)/)
    if (m) remaining = parseInt(m[1], 10)
  }

  const error = overview || seasons.length > 0 ? null : 'NO_OVERVIEW'

  const result: CinemmSeriesDetails = {
    id,
    name: name ?? '',
    year: year ?? '',
    poster: poster ?? '',
    type: 'series',
    source,
    overview,
    seasons,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=series`,
  }
  if (overview || seasons.length > 0) await setCached(key, result)
  return result
}

/**
 * Fetch streaming/download servers for a single episode.
 * Args: (episodeId, source). Quota-limited — uses caching.
 */
export async function getEpisodeServers(
  episodeId: number,
  source: string,
  opts: { useCache?: boolean } = {},
): Promise<CinemmEpisodeDetails> {
  const key = `episode:${episodeId}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmEpisodeDetails>(key)
    if (cached && cached.servers.length > 0) return cached
  }

  let { lines } = await callAction(ACTIONS.getEpisodeServers, [episodeId, source])
  let raw = lines.get('1')
  // If QUOTA_EXCEEDED, refresh visitor and retry once.
  if (raw && JSON.parse(raw).error === 'QUOTA_EXCEEDED') {
    const refreshed = await refreshVisitorQuota()
    if (refreshed && refreshed.remaining > 0) {
      const retry = await callAction(ACTIONS.getEpisodeServers, [episodeId, source])
      lines = retry.lines
      raw = retry.lines.get('1')
    }
  }

  let servers: CinemmServer[] = []
  let remaining = 0
  let error: string | null = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        servers?: CinemmServer[]
        remaining?: number
        error?: string
      }
      servers = (parsed.servers ?? []).map((s) => ({
        ...s,
        // Normalize size: server returns null when unknown
        size: s.size ?? 'N/A',
      }))
      remaining = parsed.remaining ?? 0
      error = parsed.error ?? null
    } catch (e) {
      console.error('Failed to parse episode servers JSON:', e)
      error = 'PARSE_ERROR'
    }
  } else {
    error = 'NO_RETURN_VALUE'
  }

  const result: CinemmEpisodeDetails = {
    episodeId,
    servers,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
  }
  if (!error && servers.length > 0) await setCached(key, result)
  return result
}

/**
 * Unified details fetcher that picks the right action based on type.
 */
export async function getDetails(
  item: Pick<CinemmSearchItem, 'id' | 'type' | 'source' | 'name' | 'year' | 'poster'>,
  opts?: { useCache?: boolean },
): Promise<CinemmDetails> {
  if (item.type === 'movie') {
    return getMovieDetails(item.id, item.source, item.name, item.year, item.poster, opts)
  }
  return getSeriesDetails(item.id, item.source, item.name, item.year, item.poster, opts)
}
