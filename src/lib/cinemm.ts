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
  opts: { retries?: number; visitorUuid?: string | null } = {},
): Promise<{ lines: Map<string, string>; raw: string }> {
  const retries = opts.retries ?? 1
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify(args)
      const headers: Record<string, string> = {
        ...COMMON_HEADERS,
        'Next-Action': actionId,
      }
      // When the user supplies their own cinemm.com visitor UUID, send it
      // as a cookie. cinemm.com tracks quota per UUID, so using a known-good
      // UUID (minted via cinemm.com directly) bypasses our auto-refresh logic
      // and its IP rate-limiting side effects.
      if (opts.visitorUuid) {
        headers['Cookie'] = `user_uuid=${opts.visitorUuid}`
      }
      const res = await fetch(CINEMM_ORIGIN + '/', {
        method: 'POST',
        headers,
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
 * IP-based rate limiting: cinemm.com limits how many UUIDs a single IP can
 * mint within a short window. If we mint too many too fast, the IP gets
 * rate-limited and subsequent identifyUserAction calls return a stale UUID
 * instead of a fresh one. To mitigate this:
 *
 *   1. We pre-warm a small pool of UUIDs (3) on first quota-exceeded event.
 *   2. We serve UUIDs from the pool first before minting new ones.
 *   3. We respect a cooldown between mint attempts to avoid rate-limiting.
 *   4. We detect rate-limited responses (stale UUID / zero remaining) and
 *      return a sentinel error so callers can surface a clear message.
 *
 * Note: the site's Set-Cookie response associates the UUID with future
 * requests automatically; we don't need to do anything special with it.
 * Returns the visitor info object.
 */

interface VisitorInfo {
  uuid: string
  pin: string
  usageCount: number
  lastReset: string
  isPremium: boolean
  bonusCredits: number
  remaining: number
}

// In-memory UUID pool. Survives across requests within the same server
// process. Cleared on server restart (which is fine — fresh start).
const uuidPool: VisitorInfo[] = []
const POOL_TARGET_SIZE = 3
const MINT_COOLDOWN_MS = 2000 // 2s between mint attempts
let lastMintAt = 0
// Single-flight guard so concurrent callers don't all mint at once.
let inflightMint: Promise<VisitorInfo | null> | null = null

async function mintFreshUuid(): Promise<VisitorInfo | null> {
  // Generate a random fingerprint-like ID (the site accepts any string)
  const fp = Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('')
  try {
    const { lines } = await callAction(ACTIONS.identifyUser, [fp, undefined])
    const raw = lines.get('1')
    if (!raw) return null
    const info = JSON.parse(raw) as VisitorInfo
    // Detect rate-limited / stale UUID: if remaining is 0 on a fresh mint,
    // the IP is rate-limited and cinemm.com returned an exhausted UUID.
    if (info.remaining <= 0) {
      return null
    }
    return info
  } catch (e) {
    console.error('mintFreshUuid failed:', e)
    return null
  }
}

/**
 * Get a visitor UUID with quota remaining. Tries the pool first, then mints
 * a new one (with cooldown to avoid IP rate-limiting).
 */
async function getUsableUuid(): Promise<VisitorInfo | null> {
  // 1. Try to drain an entry from the pool that still has remaining quota.
  while (uuidPool.length > 0) {
    const candidate = uuidPool.shift()!
    if (candidate.remaining > 0) return candidate
  }

  // 2. Honor cooldown to avoid IP rate-limiting.
  const now = Date.now()
  const elapsed = now - lastMintAt
  if (elapsed < MINT_COOLDOWN_MS) {
    await new Promise((r) => setTimeout(r, MINT_COOLDOWN_MS - elapsed))
  }
  lastMintAt = Date.now()

  // 3. Single-flight: if another caller is already minting, wait for it.
  if (inflightMint) {
    const shared = await inflightMint
    if (shared && shared.remaining > 0) return shared
  }

  // 4. Mint a fresh UUID.
  inflightMint = mintFreshUuid()
  const info = await inflightMint
  inflightMint = null
  return info
}

/**
 * Top-up the UUID pool in the background (best-effort, non-blocking).
 * Called after a successful detail fetch to keep the pool warm.
 */
function topUpPoolInBackground() {
  if (uuidPool.length >= POOL_TARGET_SIZE) return
  // Fire-and-forget; errors are swallowed.
  ;(async () => {
    while (uuidPool.length < POOL_TARGET_SIZE) {
      const now = Date.now()
      const elapsed = now - lastMintAt
      if (elapsed < MINT_COOLDOWN_MS) {
        await new Promise((r) => setTimeout(r, MINT_COOLDOWN_MS - elapsed))
      }
      lastMintAt = Date.now()
      const info = await mintFreshUuid()
      if (!info) break // rate-limited or error — stop trying
      uuidPool.push(info)
    }
  })().catch(() => {})
}

/**
 * Refresh quota when a detail fetch hits QUOTA_EXCEEDED.
 * Returns a fresh visitor with quota, or null if the IP is rate-limited
 * (in which case the caller should surface a "try VPN" message).
 */
async function refreshVisitorQuota(): Promise<VisitorInfo | null> {
  return getUsableUuid()
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
 * Parse the RSC response from getMovieServersAction into a CinemmMovieDetails.
 * Shared between the user-UUID path and the auto-refresh path.
 */
function parseMovieDetailsResponse(
  lines: Map<string, string>,
  ctx: { id: number; source: string; name?: string; year?: string; poster?: string },
): CinemmMovieDetails {
  const raw = lines.get('1')
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
    error = 'NO_RETURN_VALUE'
  }

  return {
    id: ctx.id,
    name: ctx.name ?? '',
    year: ctx.year ?? '',
    poster: ctx.poster ?? '',
    type: 'movie',
    source: ctx.source,
    overview,
    servers,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(ctx.name ?? '')}&type=movie`,
  }
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
  opts: { useCache?: boolean; visitorUuid?: string | null } = {},
): Promise<CinemmMovieDetails> {
  const key = `details:movie:${id}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmMovieDetails>(key)
    if (cached && (cached.servers.length > 0 || cached.overview.length > 0)) {
      return cached
    }
  }

  // If user supplied their own cinemm.com UUID, use it directly (no auto-refresh).
  if (opts.visitorUuid) {
    const { lines } = await callAction(ACTIONS.getMovieServers, [id, source], {
      visitorUuid: opts.visitorUuid,
    })
    const result = parseMovieDetailsResponse(lines, { id, source, name, year, poster })
    if (!result.error && (result.servers.length > 0 || result.overview.length > 0)) {
      await setCached(key, result)
    }
    return result
  }

  // Auto-refresh path: try, on QUOTA_EXCEEDED refresh UUID + retry.
  let { lines } = await callAction(ACTIONS.getMovieServers, [id, source])
  let raw = lines.get('1')
  if (raw && JSON.parse(raw).error === 'QUOTA_EXCEEDED') {
    const refreshed = await refreshVisitorQuota()
    if (refreshed && refreshed.remaining > 0) {
      const retry = await callAction(ACTIONS.getMovieServers, [id, source])
      lines = retry.lines
      raw = retry.lines.get('1')
      topUpPoolInBackground()
    } else {
      return {
        id,
        name: name ?? '',
        year: year ?? '',
        poster: poster ?? '',
        type: 'movie',
        source,
        overview: '',
        servers: [],
        remaining: 0,
        error: 'IP_RATE_LIMITED',
        fetchedAt: new Date().toISOString(),
        sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=movie`,
      }
    }
  }

  const result = parseMovieDetailsResponse(lines, { id, source, name, year, poster })
  if (!result.error && (result.servers.length > 0 || result.overview.length > 0)) {
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
  opts: { useCache?: boolean; visitorUuid?: string | null } = {},
): Promise<CinemmSeriesDetails> {
  const key = `details:series:${id}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmSeriesDetails>(key)
    if (cached && cached.overview.length > 0) return cached
  }

  // If user supplied their own cinemm.com UUID, use it directly (no auto-refresh).
  if (opts.visitorUuid) {
    const { lines } = await callAction(ACTIONS.getSeriesDetails, [id, source], {
      visitorUuid: opts.visitorUuid,
    })
    // Extract overview from line "10:" (text chunk) and seasons from line "1:"
    let overview = lines.get('10') ?? ''
    const tMatch = overview.match(/^T[0-9a-f]+,(.*)$/s)
    if (tMatch) overview = tMatch[1]
    let seasonsJson = lines.get('1') ?? ''
    let seasons: CinemmSeason[] = []
    if (seasonsJson) {
      try {
        const parsed = JSON.parse(seasonsJson) as { seasons?: CinemmSeason[] }
        seasons = parsed.seasons ?? []
      } catch (e) {
        console.error('Failed to parse seasons JSON (UUID path):', e)
      }
    }
    const result = parseSeriesDetailsResponse(lines, { id, source, name, year, poster }, overview, seasons)
    if (result.overview || result.seasons.length > 0) await setCached(key, result)
    return result
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
      topUpPoolInBackground()
    } else {
      // Pool drained AND IP is rate-limited. Surface a clearer error.
      return {
        id,
        name: name ?? '',
        year: year ?? '',
        poster: poster ?? '',
        type: 'series',
        source,
        overview: '',
        seasons: [],
        remaining: 0,
        error: 'IP_RATE_LIMITED',
        fetchedAt: new Date().toISOString(),
        sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(name ?? '')}&type=series`,
      }
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

  const result = parseSeriesDetailsResponse(lines, { id, source, name, year, poster }, overview, seasons)
  if (result.overview || result.seasons.length > 0) await setCached(key, result)
  return result
}

/**
 * Parse the RSC response from getSeriesDetailsAction into a CinemmSeriesDetails.
 * Shared between the user-UUID path and the auto-refresh path.
 */
function parseSeriesDetailsResponse(
  lines: Map<string, string>,
  ctx: { id: number; source: string; name?: string; year?: string; poster?: string },
  overview = '',
  seasons: CinemmSeason[] = [],
): CinemmSeriesDetails {
  // Look for remaining quota info on line "6:" (initialUser payload)
  let remaining = 0
  const userPayload = lines.get('6')
  if (userPayload) {
    const m = userPayload.match(/"remaining"\s*:\s*(\d+)/)
    if (m) remaining = parseInt(m[1], 10)
  }

  const error = overview || seasons.length > 0 ? null : 'NO_OVERVIEW'

  return {
    id: ctx.id,
    name: ctx.name ?? '',
    year: ctx.year ?? '',
    poster: ctx.poster ?? '',
    type: 'series',
    source: ctx.source,
    overview,
    seasons,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${CINEMM_ORIGIN}/?search=${encodeURIComponent(ctx.name ?? '')}&type=series`,
  }
}

/**
 * Fetch streaming/download servers for a single episode.
 * Args: (episodeId, source). Quota-limited — uses caching.
 */
export async function getEpisodeServers(
  episodeId: number,
  source: string,
  opts: { useCache?: boolean; visitorUuid?: string | null } = {},
): Promise<CinemmEpisodeDetails> {
  const key = `episode:${episodeId}:${source}`
  if (opts.useCache !== false) {
    const cached = await getCached<CinemmEpisodeDetails>(key)
    if (cached && cached.servers.length > 0) return cached
  }

  // If user supplied their own cinemm.com UUID, use it directly (no auto-refresh).
  if (opts.visitorUuid) {
    const { lines } = await callAction(ACTIONS.getEpisodeServers, [episodeId, source], {
      visitorUuid: opts.visitorUuid,
    })
    const result = parseEpisodeServersResponse(lines, episodeId)
    if (!result.error && result.servers.length > 0) await setCached(key, result)
    return result
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
      topUpPoolInBackground()
    } else {
      // Pool drained AND IP is rate-limited. Surface a clearer error.
      return {
        episodeId,
        servers: [],
        remaining: 0,
        error: 'IP_RATE_LIMITED',
        fetchedAt: new Date().toISOString(),
      }
    }
  }

  const result = parseEpisodeServersResponse(lines, episodeId)
  if (!result.error && result.servers.length > 0) await setCached(key, result)
  return result
}

/** Parse the RSC response from getEpisodeServersAction into CinemmEpisodeDetails. */
function parseEpisodeServersResponse(
  lines: Map<string, string>,
  episodeId: number,
): CinemmEpisodeDetails {
  const raw = lines.get('1')
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
  return {
    episodeId,
    servers,
    remaining,
    error,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Unified details fetcher that picks the right action based on type.
 */
export async function getDetails(
  item: Pick<CinemmSearchItem, 'id' | 'type' | 'source' | 'name' | 'year' | 'poster'>,
  opts?: { useCache?: boolean; visitorUuid?: string | null },
): Promise<CinemmDetails> {
  if (item.type === 'movie') {
    return getMovieDetails(item.id, item.source, item.name, item.year, item.poster, opts)
  }
  return getSeriesDetails(item.id, item.source, item.name, item.year, item.poster, opts)
}

// ---------------------------------------------------------------------------
// TMDB ID lookup (uses the public TMDB API; cached in SQLite)
// ---------------------------------------------------------------------------

/**
 * Look up the real TMDB movie/series ID by name + year. The result is cached
 * in SQLite so subsequent calls for the same name+year+type are free.
 *
 * Args:
 *   - name: e.g. "Inception", "Breaking Bad"
 *   - year: e.g. "2010", "2008" (extracted from cinemm.com's year field)
 *   - type: 'movie' or 'series'
 *   - apiKey: TMDB v3 API key
 *
 * Returns the TMDB ID as a number, or null if not found / on error.
 */
export async function lookupTmdbId(
  name: string,
  year: string,
  type: MediaType,
  apiKey: string,
  opts: { useCache?: boolean } = {},
): Promise<{ tmdbId: number | null; cached: boolean }> {
  if (!name || !apiKey) return { tmdbId: null, cached: false }
  // Extract first 4-digit year from the year string (handles "2010", "2008-2013", etc.)
  const yearMatch = year.match(/\d{4}/)
  const yearNum = yearMatch ? parseInt(yearMatch[0], 10) : null

  const cacheKey = `tmdb:${type}:${name.toLowerCase()}:${yearNum ?? 'any'}`
  if (opts.useCache !== false) {
    const cached = await getCached<{ tmdbId: number | null }>(cacheKey)
    if (cached) return { tmdbId: cached.tmdbId, cached: true }
  }

  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv'
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('query', name)
  url.searchParams.set('include_adult', 'false')
  if (yearNum) {
    url.searchParams.set(type === 'movie' ? 'year' : 'first_air_date_year', String(yearNum))
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      console.error(`TMDB API returned HTTP ${res.status}`)
      return { tmdbId: null, cached: false }
    }
    const data = (await res.json()) as {
      results?: Array<{ id: number; title?: string; name?: string }>
    }
    const results = data.results ?? []
    if (results.length === 0) {
      // Cache negative result too (avoid re-querying for known-misses)
      await setCached(cacheKey, { tmdbId: null })
      return { tmdbId: null, cached: false }
    }
    // Pick the first result (TMDB's search is already ranked by relevance).
    const tmdbId = results[0].id
    await setCached(cacheKey, { tmdbId })
    return { tmdbId, cached: false }
  } catch (e) {
    console.error('TMDB lookup failed:', e)
    return { tmdbId: null, cached: false }
  }
}
