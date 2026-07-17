'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Search, Film, Tv, Download, Loader2, AlertTriangle, ExternalLink, Database, Copy, Check, X, Image as ImageIcon, ChevronRight, ArrowLeft, KeyRound, Settings, Plus, Zap, ChevronLeft, Send, Upload, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'

// ---------------------------------------------------------------------------
// Types (mirror of /src/lib/cinemm.ts)
// ---------------------------------------------------------------------------
type MediaType = 'movie' | 'series'

interface SearchItem {
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

interface Server {
  name: string
  size: string
  url: string
}

interface MovieDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'movie'
  source: string
  overview: string
  servers: Server[]
  // New: stream URLs fetched from @cinemmbot Telegram bot
  telegramStreamUrls?: string[]
  telegramError?: string | null
  telegramCached?: boolean
  // New: stream URLs manually submitted by Bro via /api/manual-link
  manualStreamUrls?: ManualStreamUrlEntry[]
  manualStreamUrlsCount?: number
  remaining: number
  error?: string | null
  fetchedAt: string
  sourceUrl: string
}

interface SeriesDetails {
  id: number
  name: string
  year: string
  poster: string
  type: 'series'
  source: string
  overview: string
  seasons: Season[]
  // New: stream URLs fetched from @cinemmbot Telegram bot
  telegramStreamUrls?: string[]
  telegramError?: string | null
  telegramCached?: boolean
  // New: stream URLs manually submitted by Bro via /api/manual-link
  manualStreamUrls?: ManualStreamUrlEntry[]
  manualStreamUrlsCount?: number
  remaining: number
  error?: string | null
  fetchedAt: string
  sourceUrl: string
}

interface Episode {
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
}

interface Season {
  id: number
  name: string
  is_end: number
  episodes: Episode[]
}

interface EpisodeServers {
  episodeId: number
  servers: Server[]
  remaining: number
  error: string | null
  fetchedAt: string
  // New: manually-submitted stream URLs for this episode
  manualStreamUrls?: ManualStreamUrlEntry[]
  manualStreamUrlsCount?: number
}

type Details = MovieDetails | SeriesDetails

// Manually-submitted stream URL entry (from ManualStreamUrl DB table)
interface ManualStreamUrlEntry {
  shortlink: string
  streamUrl: string
  quality: string
  format: string
  host: string
  fileName: string
  fileSize: string
  createdAt: string
  expiresAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

/**
 * Wrap cinemm.com image URLs with our /api/img proxy.
 * cinemm.com sets `cross-origin-resource-policy: same-origin`, which blocks
 * browsers from loading images on other domains. Our proxy fetches the image
 * server-side and returns it with permissive CORS headers.
 *
 * For non-cinemm URLs (e.g. storage01.orangeplay.org), we also proxy them
 * since they may have similar protections.
 *
 * Empty/null URLs are returned as-is (the UI handles empty posters separately).
 */
function proxyImage(url: string | undefined | null): string {
  if (!url) return ''
  // Already a relative/proxied URL? Return as-is.
  if (url.startsWith('/api/')) return url
  // Only proxy cinemm.com and known CDN hosts
  if (url.includes('cinemm.com') || url.includes('orangeplay.org')) {
    return `/api/img?url=${encodeURIComponent(url)}`
  }
  return url
}

// ---------------------------------------------------------------------------
// JSON payload builders — match the user's desired format:
//   { movies: [{ title, year, poster, overview, type, tmdbId, categories,
//                resolution, fileSize, format, downloadLinks, watchLinks, seasons }] }
//
// Movies: servers split into downloadLinks / watchLinks (by "- Download" / "- Stream" in name)
// Series: each episode has its own downloadLinks / watchLinks
// ---------------------------------------------------------------------------

interface ParsedDownloadLink {
  serverName: string
  url: string
  size: string
  quality: string
  fileName: string
}

interface ParsedWatchLink {
  serverName: string
  url: string
  size: string
  quality: string
}

/** Extract quality token (4K, 1080p, 720p, 2160p, 480p) from a server name like "Tube 1, (4K) - Stream" */
function parseQuality(serverName: string): string {
  const m = serverName.match(/\((4K|1080p|720p|2160p|480p|8K)\)/i)
  return m ? m[1] : 'Unknown'
}

/** Extract the file name (last path segment) from a URL, URL-decoded. */
function parseFileName(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    return last ? decodeURIComponent(last) : ''
  } catch {
    return ''
  }
}

/** Split cinemm.com servers into download links and watch links. */
function splitServers(servers: Server[]): {
  downloadLinks: ParsedDownloadLink[]
  watchLinks: ParsedWatchLink[]
} {
  // Extract the server source from the name.
  // Name format: "Tube 1, (1080p) - Stream" or "Server 1 (4K) - Download"
  // We want to extract "Tube 1", "Server 1", "Cloud 1" as the source.
  function extractSource(name: string): string {
    const m = name.match(/^(.+?)\s*[,（(]?\s*(?:4K|1080p|720p|2160p|480p|8K)/i)
    if (m) return m[1].trim()
    return name.replace(/\s*[（(].*$/, '').trim()
  }

  // First pass: deduplicate by URL (cinemm.com returns Stream + Download
  // entries for the same URL).
  const byUrl = new Map<
    string,
    { server: Server; quality: string; fileName: string; source: string; isStream: boolean; isDownload: boolean }
  >()
  for (const s of servers) {
    const quality = parseQuality(s.name)
    const fileName = parseFileName(s.url)
    const source = extractSource(s.name)
    const nameLower = s.name.toLowerCase()
    const isDownload = nameLower.includes('download')
    const isStream = nameLower.includes('stream')
    const existing = byUrl.get(s.url)
    if (existing) {
      existing.isStream = existing.isStream || isStream
      existing.isDownload = existing.isDownload || isDownload
    } else {
      byUrl.set(s.url, { server: s, quality, fileName, source, isStream, isDownload })
    }
  }

  // Second pass: group by source, preserving order of first appearance.
  // This lets us assign "Server 1", "Server 2", "Server 3" to each unique
  // source (e.g., Tube 1 → Server 1, Server 1 → Server 2, Cloud 1 → Server 3).
  const sourceOrder: string[] = []
  const bySource = new Map<
    string,
    { server: Server; quality: string; fileName: string; isStream: boolean; isDownload: boolean }[]
  >()
  for (const { server, quality, fileName, source, isStream, isDownload } of byUrl.values()) {
    if (!bySource.has(source)) {
      bySource.set(source, [])
      sourceOrder.push(source)
    }
    bySource.get(source)!.push({ server, quality, fileName, isStream, isDownload })
  }

  // Build the output: for each source, list all its qualities.
  const downloadLinks: ParsedDownloadLink[] = []
  const watchLinks: ParsedWatchLink[] = []
  let serverIndex = 0
  for (const source of sourceOrder) {
    serverIndex++
    const simpleName = `Server ${serverIndex}`
    const entries = bySource.get(source)!
    for (const { server, quality, fileName } of entries) {
      downloadLinks.push({
        serverName: simpleName,
        url: server.url,
        size: server.size,
        quality,
        fileName,
      })
      watchLinks.push({
        serverName: simpleName,
        url: server.url,
        size: server.size,
        quality,
      })
    }
  }
  return { downloadLinks, watchLinks }
}

/**
 * Convert manually-submitted stream URLs (from ManualStreamUrl DB table) into
 * ParsedDownloadLink / ParsedWatchLink format, so they can be merged into the
 * JSON payload's downloadLinks[] and watchLinks[] arrays.
 *
 * We use the REAL STREAM URL (not the shortlink) per Bro's request — they want
 * the underlying file URL, not cinemm.com's redirect wrapper. This works in:
 *   - Download managers (IDM/aria2/Free Download Manager) — they fetch directly
 *   - Scripts/tools that don't need browser referrer
 *
 * Note: The real stream URL returns 403 in browsers due to cinemm.com's
 * anti-hotlinking (referrer-policy: no-referrer). If Bro needs to play in
 * browser, they can still use the shortlink from the "Stream Links (Community)"
 * section above the JSON download buttons.
 *
 * Each entry appears in BOTH downloadLinks and watchLinks so the user can
 * use whichever they prefer. serverName indicates the source + quality.
 */
function manualStreamUrlsToLinks(
  urls: ManualStreamUrlEntry[],
): { downloadLinks: ParsedDownloadLink[]; watchLinks: ParsedWatchLink[] } {
  const downloadLinks: ParsedDownloadLink[] = []
  const watchLinks: ParsedWatchLink[] = []

  // Group URLs by host so each host gets sequential Server N numbering.
  // e.g. cmreel URLs → Server 1 (all cmreel)
  //      bioscopeapp URLs → Server 2 (all bioscopeapp)
  //      cmdrive URLs → Server 3 (all cmdrive)
  // Same host = same Server N (regardless of quality).
  const hostOrder: string[] = []
  for (const entry of urls) {
    if (!hostOrder.includes(entry.host)) {
      hostOrder.push(entry.host)
    }
  }

  for (const entry of urls) {
    const serverNumber = hostOrder.indexOf(entry.host) + 1

    downloadLinks.push({
      serverName: `Server ${serverNumber}`,
      url: entry.streamUrl, // ← real stream URL (not shortlink)
      size: entry.fileSize || 'N/A',
      quality: entry.quality,
      fileName: entry.fileName,
    })
    watchLinks.push({
      serverName: `Server ${serverNumber}`,
      url: entry.streamUrl, // ← real stream URL (not shortlink)
      size: entry.fileSize || 'N/A',
      quality: entry.quality,
    })
  }
  return { downloadLinks, watchLinks }
}

/** Parse overview text to extract categories, resolution, fileSize, format. */
function parseOverviewMetadata(overview: string): {
  categories: string[]
  resolution: string
  fileSize: string
  format: string
} {
  const categories: string[] = []
  let resolution = ''
  let fileSize = ''
  let format = ''

  // Genre ..... Crime/ Drama
  const genreMatch = overview.match(/Genre\s*[.…]+\s*(.+)/i)
  if (genreMatch) {
    const genres = genreMatch[1]
      .split(/[\/,]/)
      .map((g) => g.trim())
      .filter(Boolean)
    categories.push(...genres)
  }

  // Quality….BluRay 4K HEVC/ 1080p HEVC/ 720p  →  "4K / 1080p / 720p"
  const qualityMatch = overview.match(/Quality\s*[.…]+\s*(.+)/i)
  if (qualityMatch) {
    const resolutions = qualityMatch[1].match(/\d+K|\d+p/gi)
    if (resolutions) resolution = [...new Set(resolutions)].join(' / ')
  }

  // File size…(9 GB)/ (2.6 GB ) / (1.6 GB)  →  "9 GB / 2.6 GB / 1.6 GB"
  const fileSizeMatch = overview.match(/File\s*size\s*[.…]+\s*(.+)/i)
  if (fileSizeMatch) {
    const sizes = fileSizeMatch[1].match(/(\d+(?:\.\d+)?\s*(?:GB|MB|TB))/gi)
    if (sizes) fileSize = sizes.join(' / ')
  }

  // Format…mkv/mp4  →  "mkv / mp4"
  const formatMatch = overview.match(/Format\s*[.…]+\s*(.+)/i)
  if (formatMatch) {
    const formats = formatMatch[1].match(/mkv|mp4|avi|mov|flv|webm|hevc|x264|x265/gi)
    if (formats) format = [...new Set(formats)].join(' / ')
  }

  return { categories, resolution, fileSize, format }
}

function buildJsonPayload(
  item: SearchItem,
  details: Details | null,
  episodeServers?: Map<number, Server[]>,
  manualDownloadLinks: ParsedDownloadLink[] = [],
  manualWatchLinks: ParsedWatchLink[] = [],
  resolvedTmdbId: number | null = null,
  episodeManualUrls?: Map<number, ManualStreamUrlEntry[]>,
) {
  const overview = details?.overview ?? ''
  const metadata = parseOverviewMetadata(overview)
  // Prefer the TMDB ID resolved via the TMDB API lookup; fall back to whatever
  // cinemm.com gave us (usually null for movies/series top-level).
  const tmdbId = resolvedTmdbId ?? (item.tmdbId ? Number(item.tmdbId) : null)

  let movieEntry: Record<string, unknown>

  if (details?.type === 'movie') {
    const { downloadLinks, watchLinks } = splitServers(details.servers)
    // Merge auto-fetched links with user-supplied manual links (manual first).
    movieEntry = {
      title: item.name,
      year: item.year,
      poster: item.poster,
      overview,
      type: 'movie',
      tmdbId,
      categories: metadata.categories,
      resolution: metadata.resolution,
      fileSize: metadata.fileSize,
      format: metadata.format,
      downloadLinks: [...manualDownloadLinks, ...downloadLinks],
      watchLinks: [...manualWatchLinks, ...watchLinks],
      seasons: [],
    }
  } else if (details?.type === 'series') {
    const seasons = details.seasons.map((s) => ({
      name: s.name,
      episodes: s.episodes.map((e) => {
        const epServers = episodeServers?.get(e.id) ?? []
        const { downloadLinks, watchLinks } = splitServers(epServers)
        // Merge in manually-submitted stream URLs for THIS episode (if any)
        const epManualUrls = episodeManualUrls?.get(e.id) ?? []
        const epManualLinks = manualStreamUrlsToLinks(epManualUrls)
        const mergedDownloadLinks = [...epManualLinks.downloadLinks, ...downloadLinks]
        const mergedWatchLinks = [...epManualLinks.watchLinks, ...watchLinks]
        return {
          name: e.name || `Episode ${e.episode_number}`,
          videoUrl: mergedWatchLinks[0]?.url ?? mergedDownloadLinks[0]?.url ?? '',
          downloadLinks: mergedDownloadLinks,
          watchLinks: mergedWatchLinks,
        }
      }),
    }))
    // For series, manual links apply at the top level (not per-episode).
    movieEntry = {
      title: item.name,
      year: item.year,
      poster: item.poster,
      overview,
      type: 'series',
      tmdbId,
      categories: metadata.categories,
      resolution: metadata.resolution,
      fileSize: metadata.fileSize,
      format: metadata.format,
      downloadLinks: [...manualDownloadLinks],
      watchLinks: [...manualWatchLinks],
      seasons,
    }
  } else {
    // No details loaded (quota exceeded / not fetched yet) — still allow manual links.
    movieEntry = {
      title: item.name,
      year: item.year,
      poster: item.poster,
      overview: '',
      type: item.type,
      tmdbId,
      categories: [],
      resolution: '',
      fileSize: '',
      format: '',
      downloadLinks: [...manualDownloadLinks],
      watchLinks: [...manualWatchLinks],
      seasons: [],
    }
  }

  return { movies: [movieEntry] }
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Home() {
  // Initialize query + mediaType from URL on first render (if present).
  // This lets users bookmark/share search URLs and have them restore on reload.
  const [query, setQuery] = useState(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('search') ?? ''
  })
  const [mediaType, setMediaType] = useState<MediaType>(() => {
    if (typeof window === 'undefined') return 'movie'
    const t = new URLSearchParams(window.location.search).get('type')
    return t === 'series' ? 'series' : 'movie'
  })
  const [results, setResults] = useState<SearchItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cachedSearch, setCachedSearch] = useState(false)

  // Detail dialog state
  const [selected, setSelected] = useState<SearchItem | null>(null)
  const [details, setDetails] = useState<Details | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Series-only: per-episode server state
  const [episodeServers, setEpisodeServers] = useState<Map<number, Server[]>>(new Map())
  const [episodeServersLoading, setEpisodeServersLoading] = useState<Set<number>>(new Set())
  const [episodeServersError, setEpisodeServersError] = useState<Set<number>>(new Set())
  // Manually-submitted stream URLs per episode (keyed by episode ID)
  const [episodeManualUrls, setEpisodeManualUrls] = useState<Map<number, ManualStreamUrlEntry[]>>(new Map())
  // Ref mirror of episodeServers so async loops (like Auto Open All) can read
  // the latest value without stale-closure issues. Updated in an effect.
  const episodeServersRef = useRef(episodeServers)
  useEffect(() => { episodeServersRef.current = episodeServers }, [episodeServers])
  const episodeManualUrlsRef = useRef(episodeManualUrls)
  useEffect(() => { episodeManualUrlsRef.current = episodeManualUrls }, [episodeManualUrls])
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set())
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null)

  // User-supplied manual download + watch links. These get merged with the
  // auto-fetched links in the JSON output. Survive page navigation within
  // the same session (cleared when a new post is opened).
  const [manualDownloadLinks, setManualDownloadLinks] = useState<ParsedDownloadLink[]>([])
  const [manualWatchLinks, setManualWatchLinks] = useState<ParsedWatchLink[]>([])

  // User-supplied TMDB API key (from localStorage). Used to look up the
  // real TMDB movie/series ID by name + year. Cached in SQLite.
  const [tmdbApiKey, setTmdbApiKey] = useState<string | null>(null)
  const [tmdbKeyInput, setTmdbKeyInput] = useState('')

  // Auto-fetched TMDB ID for the currently-open post (if any).
  const [tmdbId, setTmdbId] = useState<number | null>(null)
  const [tmdbIdLoading, setTmdbIdLoading] = useState(false)
  const [tmdbIdError, setTmdbIdError] = useState<string | null>(null)

  // Telegram Bot URL (from localStorage). When set, a "Get Links via Telegram"
  // button appears on the detail page that opens the bot with the movie/series
  // name pre-filled as a query.
  const [tgBotUrl, setTgBotUrl] = useState<string | null>(null)
  const [tgBotInput, setTgBotInput] = useState('')

  // Batch selection — user can select multiple search results and download
  // them as a single combined JSON file.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  // User-supplied cinemm.com visitor UUIDs (from localStorage). When present,
  // requests use the active UUID directly via the user_uuid cookie — bypassing
  // the auto-refresh path and its IP rate-limiting side effects.
  //
  // Multiple UUIDs can be stored. When the active UUID's quota is exhausted,
  // we auto-rotate to the next UUID with remaining quota.
  const [visitorUuids, setVisitorUuids] = useState<string[]>([])
  const [activeUuidIndex, setActiveUuidIndex] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [uuidInput, setUuidInput] = useState('')

  // Remaining quota on cinemm.com (from the last detail/episode fetch).
  // Persisted per-UUID in localStorage so it survives page reloads.
  const [remainingQuota, setRemainingQuota] = useState<number | null>(null)

  // The active UUID — derived from visitorUuids + activeUuidIndex
  const visitorUuid = visitorUuids[activeUuidIndex] ?? null

  // Load UUIDs + remaining quota from localStorage on mount
  useEffect(() => {
    const stored = window.localStorage.getItem('cinemm_visitor_uuids')
    if (stored) {
      try {
        const arr = JSON.parse(stored) as string[]
        if (Array.isArray(arr) && arr.length > 0) {
          setVisitorUuids(arr)
        }
      } catch {
        // Old single-UUID format — migrate
        setVisitorUuids([stored])
      }
    } else {
      // Migrate old single-UUID format if present
      const oldSingle = window.localStorage.getItem('cinemm_visitor_uuid')
      if (oldSingle) {
        setVisitorUuids([oldSingle])
        window.localStorage.setItem('cinemm_visitor_uuids', JSON.stringify([oldSingle]))
      }
    }
    const storedQuota = window.localStorage.getItem('cinemm_remaining_quota')
    if (storedQuota) {
      const n = parseInt(storedQuota, 10)
      if (Number.isFinite(n)) setRemainingQuota(n)
    }
    const storedTmdbKey = window.localStorage.getItem('cinemm_tmdb_api_key')
    if (storedTmdbKey) {
      setTmdbApiKey(storedTmdbKey)
      setTmdbKeyInput(storedTmdbKey)
    }
    const storedTgBot = window.localStorage.getItem('cinemm_tg_bot_url')
    if (storedTgBot) {
      setTgBotUrl(storedTgBot)
      setTgBotInput(storedTgBot)
    }
  }, [])

  // Persist UUIDs to localStorage whenever they change
  useEffect(() => {
    if (visitorUuids.length > 0) {
      window.localStorage.setItem('cinemm_visitor_uuids', JSON.stringify(visitorUuids))
    } else {
      window.localStorage.removeItem('cinemm_visitor_uuids')
    }
  }, [visitorUuids])

  // Ensure activeUuidIndex is in bounds
  useEffect(() => {
    if (activeUuidIndex >= visitorUuids.length) {
      setActiveUuidIndex(Math.max(0, visitorUuids.length - 1))
    }
  }, [activeUuidIndex, visitorUuids.length])

  // On initial page load, check if the URL has view=details params.
  // If so, auto-open the detail page — this lets users share/bookmark
  // detail URLs and have them work on a fresh page load.
  // Also, if URL has ?search=...&type=... (no view=details), auto-run search.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('view') === 'details') {
      const item: SearchItem = {
        id: parseInt(params.get('id') ?? '0', 10),
        name: params.get('name') ?? '',
        year: params.get('year') ?? '',
        poster: params.get('poster') ?? '',
        type: (params.get('type') as MediaType) ?? 'movie',
        source: params.get('source') ?? 'CM',
      }
      if (item.id > 0 && item.name) {
        // Trigger openDetails without pushState (URL is already correct)
        setSelected(item)
        setDetails(null)
        setDetailsError(null)
        setDetailsLoading(true)
        setCopied(false)
        setEpisodeServers(new Map())
    setEpisodeManualUrls(new Map())
        setEpisodeServersLoading(new Set())
        setEpisodeServersError(new Set())
        setExpandedSeasons(new Set())
        setSelectedEpisode(null)
        setManualDownloadLinks([])
        setManualWatchLinks([])
        setTmdbId(null)
        setTmdbIdError(null)
        window.scrollTo(0, 0)
        // Fetch details
        ;(async () => {
          try {
            const url = new URL('/api/details', window.location.origin)
            url.searchParams.set('id', String(item.id))
            url.searchParams.set('type', item.type)
            url.searchParams.set('source', item.source)
            url.searchParams.set('name', item.name)
            url.searchParams.set('year', item.year)
            url.searchParams.set('poster', item.poster)
            const res = await fetch(url.toString())
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
            const fetched = data as Details
            setDetails(fetched)
            if (fetched.type === 'series' && (fetched as SeriesDetails).seasons.length > 0) {
              setExpandedSeasons(new Set([(fetched as SeriesDetails).seasons[0].id]))
            }
            // TMDB lookup — NON-BLOCKING (fire and forget).
            // Previously this used `await`, which blocked the details from showing
            // until TMDB responded (or timed out after ~10s). Now we start the
            // TMDB lookup in the background and update the UI when it completes.
            // The details page is shown immediately — TMDB ID appears a moment later.
            const storedTmdbKey = window.localStorage.getItem('cinemm_tmdb_api_key')
            if (storedTmdbKey && item.name) {
              setTmdbIdLoading(true)
              // Fire-and-forget: don't await this
              ;(async () => {
                try {
                  const tmdbUrl = new URL('/api/tmdb-id', window.location.origin)
                  tmdbUrl.searchParams.set('name', item.name)
                  tmdbUrl.searchParams.set('year', item.year)
                  tmdbUrl.searchParams.set('type', item.type)
                  tmdbUrl.searchParams.set('apiKey', storedTmdbKey)
                  const tmdbRes = await fetch(tmdbUrl.toString())
                  const tmdbData = (await tmdbRes.json()) as { tmdbId?: number | null; error?: string }
                  if (tmdbRes.ok) setTmdbId(tmdbData.tmdbId ?? null)
                  else setTmdbIdError(tmdbData.error || `Failed (${tmdbRes.status})`)
                } catch (err) {
                  setTmdbIdError(err instanceof Error ? err.message : 'Failed to look up TMDB ID')
                } finally {
                  setTmdbIdLoading(false)
                }
              })()
            }
          } catch (err) {
            setDetailsError(err instanceof Error ? err.message : 'Failed to load details')
          } finally {
            setDetailsLoading(false)
          }
        })()
      }
    } else {
      // No view=details — if URL has ?search=..., auto-run the search
      // so the user sees their previous results on reload/back-forward.
      const searchQuery = params.get('search')
      const searchType = params.get('type') as MediaType | null
      if (searchQuery) {
        // Type is already initialized from URL via useState initializer,
        // so we just need to trigger the search.
        // Use a slight delay to ensure state is settled.
        setTimeout(() => onSubmit(), 0)
      }
      void searchType
    }
  }, [])

  // When view=details is in the URL on initial load, we also need to
  // re-run the search so the prev/next navigation buttons work (they
  // depend on `results` being populated). We do this AFTER opening
  // the detail view, so the detail content shows immediately.
  // The search runs in the background and populates `results`.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('view') === 'details' && params.get('search')) {
      // Don't change the URL (we're already on the detail view) — just fetch
      // results in the background so prev/next buttons appear.
      const q = params.get('search') ?? ''
      const t = (params.get('type') as MediaType) ?? 'movie'
      ;(async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${t}`)
          const data = await res.json()
          if (res.ok && Array.isArray(data.items)) {
            setResults(data.items)
            setCachedSearch(!!data.cached)
          }
        } catch {
          // Background fetch failed — prev/next just won't show, that's OK
        }
      })()
    }
  }, [])

  const addVisitorUuid = useCallback(() => {
    const trimmed = uuidInput.trim()
    if (!trimmed) return
    if (visitorUuids.includes(trimmed)) {
      toast.error('This UUID is already in the list')
      return
    }
    setVisitorUuids((prev) => [...prev, trimmed])
    setUuidInput('')
    toast.success(`UUID added (${visitorUuids.length + 1} total)`)
  }, [uuidInput, visitorUuids])

  const removeVisitorUuid = useCallback(
    (index: number) => {
      setVisitorUuids((prev) => prev.filter((_, i) => i !== index))
      if (index === activeUuidIndex) {
        setActiveUuidIndex(0)
        setRemainingQuota(null)
        window.localStorage.removeItem('cinemm_remaining_quota')
      }
      toast.info(`UUID removed (${Math.max(0, visitorUuids.length - 1)} remaining)`)
    },
    [activeUuidIndex, visitorUuids.length],
  )

  const setActiveUuid = useCallback(
    (index: number) => {
      setActiveUuidIndex(index)
      setRemainingQuota(null)
      window.localStorage.removeItem('cinemm_remaining_quota')
      toast.info(`Switched to UUID #${index + 1}`)
    },
    [],
  )

  const clearAllUuids = useCallback(() => {
    setVisitorUuids([])
    setActiveUuidIndex(0)
    setRemainingQuota(null)
    window.localStorage.removeItem('cinemm_visitor_uuids')
    window.localStorage.removeItem('cinemm_remaining_quota')
    toast.info('All UUIDs cleared — using auto-refresh mode')
  }, [])

  const saveTmdbApiKey = useCallback(() => {
    const trimmed = tmdbKeyInput.trim()
    if (trimmed) {
      window.localStorage.setItem('cinemm_tmdb_api_key', trimmed)
      setTmdbApiKey(trimmed)
      toast.success('TMDB API key saved — TMDB ID lookup enabled')
    } else {
      window.localStorage.removeItem('cinemm_tmdb_api_key')
      setTmdbApiKey(null)
      toast.info('TMDB API key cleared — TMDB ID lookup disabled')
    }
  }, [tmdbKeyInput])

  const clearTmdbApiKey = useCallback(() => {
    window.localStorage.removeItem('cinemm_tmdb_api_key')
    setTmdbApiKey(null)
    setTmdbKeyInput('')
    setTmdbId(null)
    setTmdbIdError(null)
    toast.info('TMDB API key cleared — TMDB ID lookup disabled')
  }, [])

  const saveTgBotUrl = useCallback(() => {
    const trimmed = tgBotInput.trim()
    if (trimmed) {
      window.localStorage.setItem('cinemm_tg_bot_url', trimmed)
      setTgBotUrl(trimmed)
      toast.success('Telegram Bot URL saved')
    } else {
      window.localStorage.removeItem('cinemm_tg_bot_url')
      setTgBotUrl(null)
      toast.info('Telegram Bot URL cleared')
    }
  }, [tgBotInput])

  const clearTgBotUrl = useCallback(() => {
    window.localStorage.removeItem('cinemm_tg_bot_url')
    setTgBotUrl(null)
    setTgBotInput('')
    toast.info('Telegram Bot URL cleared')
  }, [])

  const onSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      const q = query.trim()
      if (!q) return
      // Update URL with search params (so reload/back-forward preserves state)
      const searchUrl = new URL(window.location.href)
      searchUrl.searchParams.set('search', q)
      searchUrl.searchParams.set('type', mediaType)
      searchUrl.searchParams.delete('view') // clear detail view if present
      window.history.pushState({ view: 'search', query: q, type: mediaType }, '', searchUrl.toString())
      setLoading(true)
      setError(null)
      setResults(null)
      try {
        // Server-side fetch via API route (Vercel IP, no CORS issues).
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${mediaType}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`)
        setResults(data.items)
        setCachedSearch(!!data.cached)
        if (data.items.length === 0) {
          toast.info('No results found. Try a different search term.')
        } else {
          toast.success(`Found ${data.items.length} ${data.cached ? 'cached ' : ''}result${data.items.length === 1 ? '' : 's'}`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed')
        toast.error('Search failed')
      } finally {
        setLoading(false)
      }
    },
    [query, mediaType],
  )

  const openDetails = useCallback(async (item: SearchItem) => {
    setSelected(item)
    setDetails(null)
    setDetailsError(null)
    setDetailsLoading(true)
    setCopied(false)
    setEpisodeServers(new Map())
    setEpisodeManualUrls(new Map())
    setEpisodeServersLoading(new Set())
    setEpisodeServersError(new Set())
    setExpandedSeasons(new Set())
    setSelectedEpisode(null)
    setManualDownloadLinks([])
    setManualWatchLinks([])
    setTmdbId(null)
    setTmdbIdError(null)
    // Push URL state so the browser back button returns to search results.
    // Also keep ?search=...&type=... so refresh/back-forward can restore
    // the search results (needed for prev/next navigation buttons).
    const detailUrl = new URL(window.location.href)
    detailUrl.searchParams.set('view', 'details')
    detailUrl.searchParams.set('id', String(item.id))
    detailUrl.searchParams.set('type', item.type)
    detailUrl.searchParams.set('source', item.source)
    detailUrl.searchParams.set('name', item.name)
    detailUrl.searchParams.set('year', item.year)
    detailUrl.searchParams.set('poster', item.poster)
    // Preserve the search query so we can re-run the search on reload
    // (this enables prev/next buttons to work after refresh).
    if (query) {
      detailUrl.searchParams.set('search', query)
    }
    window.history.pushState({ view: 'details', itemId: item.id }, '', detailUrl.toString())
    window.scrollTo(0, 0)
    try {
      // Server-side fetch via API route (Vercel IP, no CORS issues).
      const url = new URL('/api/details', window.location.origin)
      url.searchParams.set('id', String(item.id))
      url.searchParams.set('type', item.type)
      url.searchParams.set('source', item.source)
      url.searchParams.set('name', item.name)
      url.searchParams.set('year', item.year)
      url.searchParams.set('poster', item.poster)
      const res = await fetch(url.toString())
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      const fetched = data as Details

      setDetails(fetched)
      // Update remaining quota in header + localStorage
      if (typeof fetched.remaining === 'number') {
        setRemainingQuota(fetched.remaining)
        window.localStorage.setItem('cinemm_remaining_quota', String(fetched.remaining))
      }
      // Auto-expand first season for series
      if (fetched.type === 'series' && (fetched as SeriesDetails).seasons.length > 0) {
        setExpandedSeasons(new Set([(fetched as SeriesDetails).seasons[0].id]))
      }
      // Kick off TMDB ID lookup (non-blocking). Uses user-supplied API key.
      // Inlined here (rather than calling a separate useCallback) to avoid
      // "Cannot access X before initialization" — the helper is defined below.
      if (tmdbApiKey && item.name) {
        setTmdbIdLoading(true)
        setTmdbIdError(null)
        try {
          const tmdbUrl = new URL('/api/tmdb-id', window.location.origin)
          tmdbUrl.searchParams.set('name', item.name)
          tmdbUrl.searchParams.set('year', item.year)
          tmdbUrl.searchParams.set('type', item.type)
          tmdbUrl.searchParams.set('apiKey', tmdbApiKey)
          const tmdbRes = await fetch(tmdbUrl.toString())
          const tmdbData = (await tmdbRes.json()) as { tmdbId?: number | null; error?: string }
          if (tmdbRes.ok) {
            setTmdbId(tmdbData.tmdbId ?? null)
          } else {
            setTmdbIdError(tmdbData.error || `Failed (${tmdbRes.status})`)
          }
        } catch (err) {
          setTmdbIdError(err instanceof Error ? err.message : 'Failed to look up TMDB ID')
        } finally {
          setTmdbIdLoading(false)
        }
      }
      if (fetched.error === 'IP_RATE_LIMITED') {
        toast.error('cinemm.com IP rate-limited. Try a VPN, switch network, or wait ~1 hour.', { duration: 8000 })
      } else if (fetched.error === 'RATE_LIMITED') {
        toast.warning('cinemm.com rate-limited — too many requests. Please wait a moment and try again.', { duration: 6000 })
      } else if (fetched.error === 'QUOTA_EXCEEDED') {
        toast.warning('cinemm.com quota exceeded — showing partial data. JSON download still works.')
      } else if (fetched.error) {
        toast.warning(`Could not fetch full details: ${fetched.error}`)
      }
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : 'Failed to load details')
      toast.error('Failed to load details')
    } finally {
      setDetailsLoading(false)
    }
  }, [tmdbApiKey, query])

  const closeDetails = useCallback(() => {
    // Clear all detail-related state immediately so one click on "Back to
    // search" returns to the search results page. We replace the current
    // history entry (rather than pushing a new one) so the browser back
    // button doesn't bounce through an intermediate state.
    const cleanUrl = new URL(window.location.href)
    // Strip all detail-related params, keep only search query/type
    cleanUrl.searchParams.delete('view')
    cleanUrl.searchParams.delete('id')
    cleanUrl.searchParams.delete('type')
    cleanUrl.searchParams.delete('source')
    cleanUrl.searchParams.delete('name')
    cleanUrl.searchParams.delete('year')
    cleanUrl.searchParams.delete('poster')
    window.history.replaceState({ view: 'search' }, '', cleanUrl.toString())
    setSelected(null)
    setDetails(null)
    setDetailsError(null)
    setCopied(false)
    setEpisodeServers(new Map())
    setEpisodeManualUrls(new Map())
    setEpisodeServersLoading(new Set())
    setEpisodeServersError(new Set())
    setExpandedSeasons(new Set())
    setSelectedEpisode(null)
    setManualDownloadLinks([])
    setManualWatchLinks([])
    setTmdbId(null)
    setTmdbIdError(null)
    window.scrollTo(0, 0)
  }, [])

  // Listen for browser back/forward — when the URL no longer has
  // view=details, clear the detail state so we return to the search page.
  // Also restore search query/type from URL on back/forward navigation.
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      if (params.get('view') !== 'details') {
        setSelected(null)
        setDetails(null)
        setDetailsError(null)
        setCopied(false)
        setEpisodeServers(new Map())
    setEpisodeManualUrls(new Map())
        setEpisodeServersLoading(new Set())
        setEpisodeServersError(new Set())
        setExpandedSeasons(new Set())
        setSelectedEpisode(null)
        setManualDownloadLinks([])
        setManualWatchLinks([])
    setTmdbId(null)
    setTmdbIdError(null)
        // Restore search query/type from URL (if present)
        const sq = params.get('search') ?? ''
        const st = params.get('type') as MediaType | null
        if (sq !== query) setQuery(sq)
        if (st && (st === 'movie' || st === 'series') && st !== mediaType) setMediaType(st)
        // If there's a search query, re-run the search to show results
        if (sq) {
          setTimeout(() => onSubmit(), 0)
        } else {
          setResults(null)
        }
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [query, mediaType, onSubmit])

  // Toggle a season's expanded/collapsed state
  const toggleSeason = useCallback((seasonId: number) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev)
      if (next.has(seasonId)) next.delete(seasonId)
      else next.add(seasonId)
      return next
    })
  }, [])

  // Expand all seasons at once (used by the "Auto Open All" button).
  const expandAllSeasons = useCallback(() => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev)
      if (details?.type === 'series') {
        for (const s of (details as SeriesDetails).seasons) {
          next.add(s.id)
        }
      }
      return next
    })
  }, [details])

  // Look up the real TMDB ID for the currently-open post. (Inlined in
  // openDetails above; this space kept intentionally blank.)

  // Fetch servers for a single episode. Idempotent — if already loaded or
  // currently loading, returns immediately.
  const fetchEpisodeServers = useCallback(
    async (episodeId: number, source: string) => {
      if (episodeServers.has(episodeId) || episodeServersLoading.has(episodeId)) return
      setEpisodeServersLoading((prev) => new Set(prev).add(episodeId))
      setEpisodeServersError((prev) => {
        const next = new Set(prev)
        next.delete(episodeId)
        return next
      })
      try {
        // Server-side fetch via API route.
        // Pass mediaId + mediaType so the backend can also return manualStreamUrls.
        const params = new URLSearchParams({
          episodeId: String(episodeId),
          source,
          mediaId: String(selected?.id ?? ''),
          mediaType: selected?.type ?? 'series',
        })
        const res = await fetch(`/api/episode-servers?${params.toString()}`)
        const data: EpisodeServers = await res.json()
        if (!res.ok) throw new Error((data as { error?: string }).error || `Failed (${res.status})`)
        if (data.error === 'RATE_LIMITED') {
          setEpisodeServersError((prev) => new Set(prev).add(episodeId))
          toast.warning('cinemm.com rate-limited — try again in a moment', { id: `ep-${episodeId}`, duration: 6000 })
        } else {
          setEpisodeServers((prev) => new Map(prev).set(episodeId, data.servers))
        }
        // Save manual stream URLs (if any) — even if cinemm.com rate-limited
        if (data.manualStreamUrls && data.manualStreamUrls.length > 0) {
          setEpisodeManualUrls((prev) => new Map(prev).set(episodeId, data.manualStreamUrls!))
        } else {
          // Clear if empty (e.g. previously had URLs but now expired)
          setEpisodeManualUrls((prev) => {
            if (!prev.has(episodeId)) return prev
            const next = new Map(prev)
            next.delete(episodeId)
            return next
          })
        }
      } catch {
        setEpisodeServersError((prev) => new Set(prev).add(episodeId))
        toast.error('Failed to load episode servers')
      } finally {
        setEpisodeServersLoading((prev) => {
          const next = new Set(prev)
          next.delete(episodeId)
          return next
        })
      }
    },
    [episodeServers, episodeServersLoading, selected],
  )


  // Batch download — fetch details for all selected items and combine into
  // a single JSON file.
  const handleBatchDownload = useCallback(async () => {
    if (!results || selectedIds.size === 0) return
    setBatchDownloading(true)
    const selectedItems = results.filter((r) => selectedIds.has(r.id))
    setBatchProgress({ done: 0, total: selectedItems.length })
    const movies: unknown[] = []
    let done = 0
    // Read TMDB API key from localStorage for batch lookup
    const storedTmdbKey = window.localStorage.getItem('cinemm_tmdb_api_key')
    for (const item of selectedItems) {
      try {
        // Fetch details for this item
        const url = new URL('/api/details', window.location.origin)
        url.searchParams.set('id', String(item.id))
        url.searchParams.set('type', item.type)
        url.searchParams.set('source', item.source)
        url.searchParams.set('name', item.name)
        url.searchParams.set('year', item.year)
        url.searchParams.set('poster', item.poster)
        const res = await fetch(url.toString())
        const data = await res.json()
        const details = data as Details
        // TMDB ID lookup (if API key is set)
        let resolvedTmdbId: number | null = null
        if (storedTmdbKey && item.name) {
          try {
            const tmdbUrl = new URL('/api/tmdb-id', window.location.origin)
            tmdbUrl.searchParams.set('name', item.name)
            tmdbUrl.searchParams.set('year', item.year)
            tmdbUrl.searchParams.set('type', item.type)
            tmdbUrl.searchParams.set('apiKey', storedTmdbKey)
            const tmdbRes = await fetch(tmdbUrl.toString())
            const tmdbData = (await tmdbRes.json()) as { tmdbId?: number | null }
            if (tmdbRes.ok) resolvedTmdbId = tmdbData.tmdbId ?? null
          } catch {
            // TMDB lookup failed — continue without it
          }
        }
        // Build movie entry with TMDB ID + manually-submitted stream URLs
        // (from the ManualStreamUrl DB table — fetched via /api/details)
        const storedLinks = (details as any)?.manualStreamUrls
          ? manualStreamUrlsToLinks((details as any).manualStreamUrls)
          : { downloadLinks: [], watchLinks: [] }
        const payload = buildJsonPayload(
          item,
          details,
          undefined,
          storedLinks.downloadLinks,
          storedLinks.watchLinks,
          resolvedTmdbId,
        )
        if (Array.isArray(payload.movies)) {
          movies.push(payload.movies[0])
        }
        // Small delay to avoid rate-limit
        await new Promise((r) => setTimeout(r, 500))
      } catch {
        // Skip failed items
      }
      done++
      setBatchProgress({ done, total: selectedItems.length })
    }
    // Download combined JSON
    const combined = { movies, batchDate: new Date().toISOString(), count: movies.length }
    const name = `batch_${selectedItems.length}_items_${Date.now()}`
    downloadJson(name + '.json', combined)
    toast.success(`Downloaded ${movies.length} items as JSON`)
    setBatchDownloading(false)
    setBatchProgress(null)
  }, [results, selectedIds])

  const handleDownloadJson = useCallback(() => {
    if (!selected) return
    // Use the ref to get the latest episode servers (avoids stale closure
    // when called right after Auto Open All finishes).
    // Also merge in any manually-submitted stream URLs (from ManualStreamUrl DB table)
    // so they appear in the JSON's downloadLinks[] and watchLinks[] arrays.
    const storedLinks = details?.manualStreamUrls
      ? manualStreamUrlsToLinks(details.manualStreamUrls)
      : { downloadLinks: [], watchLinks: [] }
    const payload = buildJsonPayload(
      selected,
      details,
      episodeServersRef.current,
      [...manualDownloadLinks, ...storedLinks.downloadLinks],
      [...manualWatchLinks, ...storedLinks.watchLinks],
      tmdbId,
      episodeManualUrlsRef.current, // ← per-episode manual URLs
    )
    const name = sanitizeFilename(selected.name || `id-${selected.id}`)
    const year = selected.year || 'unknown'
    downloadJson(`${name}_${year}_${selected.type}_${selected.id}.json`, payload)
    toast.success('JSON downloaded')
  }, [selected, details, manualDownloadLinks, manualWatchLinks, tmdbId])

  const handleCopyJson = useCallback(async () => {
    if (!selected) return
    const storedLinks = details?.manualStreamUrls
      ? manualStreamUrlsToLinks(details.manualStreamUrls)
      : { downloadLinks: [], watchLinks: [] }
    const payload = buildJsonPayload(
      selected,
      details,
      episodeServersRef.current,
      [...manualDownloadLinks, ...storedLinks.downloadLinks],
      [...manualWatchLinks, ...storedLinks.watchLinks],
      tmdbId,
      episodeManualUrlsRef.current, // ← per-episode manual URLs
    )
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed')
    }
  }, [selected, details, manualDownloadLinks, manualWatchLinks, tmdbId])

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <Toaster richColors theme="dark" position="top-right" />

      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
              <Film className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-none">CineMM Scraper</h1>
              <p className="text-xs text-zinc-400 mt-1">Search movies & series, download as JSON</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {visitorUuid && (
              <Badge variant="outline" className="border-green-900/50 text-green-400 text-xs">
                <KeyRound className="w-3 h-3 mr-1" />
                UUID #{activeUuidIndex + 1}
                {visitorUuids.length > 1 && <span className="text-zinc-500 ml-1">/ {visitorUuids.length}</span>}
              </Badge>
            )}
            {remainingQuota !== null && (
              <Badge
                variant="outline"
                className={`text-xs ${
                  remainingQuota > 3
                    ? 'border-green-900/50 text-green-400'
                    : remainingQuota > 0
                      ? 'border-amber-900/50 text-amber-400'
                      : 'border-red-900/50 text-red-400'
                }`}
                title="Remaining cinemm.com quota for the active UUID"
              >
                Quota: {remainingQuota}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen((v) => !v)}
              className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
            >
              <Settings className="w-4 h-4" />
              <span className="ml-2 hidden sm:inline">Settings</span>
            </Button>
            <a
              href="https://cinemm.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
            >
              cinemm.com <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Settings panel (collapsible) */}
        {settingsOpen && (
          <div className="border-t border-zinc-800 bg-zinc-900/80 px-4 py-4">
            <div className="container mx-auto max-w-3xl space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-purple-400" />
                  <h3 className="text-sm font-semibold text-zinc-100">cinemm.com Visitor UUIDs</h3>
                  {visitorUuids.length > 0 && (
                    <Badge variant="outline" className="border-zinc-700 text-zinc-300 text-xs">
                      {visitorUuids.length} saved
                    </Badge>
                  )}
                </div>
                {visitorUuids.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearAllUuids}
                    className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs"
                  >
                    Clear all
                  </Button>
                )}
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Add multiple cinemm.com visitor UUIDs. When the active UUID&apos;s quota is exhausted,
                the app auto-rotates to the next UUID. Visit{' '}
                <a href="https://cinemm.com" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">
                  cinemm.com
                </a>{' '}
                → DevTools (F12) → Application → Cookies → copy{' '}
                <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-200">user_uuid</code>.
              </p>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Paste a UUID, e.g. a9e6035a-33e9-4b72-bd66-0a3493533018"
                  value={uuidInput}
                  onChange={(e) => setUuidInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addVisitorUuid() } }}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-purple-500 font-mono text-sm"
                />
                <Button
                  size="sm"
                  onClick={addVisitorUuid}
                  disabled={!uuidInput.trim()}
                  className="bg-purple-600 hover:bg-purple-700 text-white"
                >
                  Add
                </Button>
              </div>
              {visitorUuids.length > 0 && (
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {visitorUuids.map((uuid, i) => (
                    <div
                      key={`${uuid}-${i}`}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
                        i === activeUuidIndex
                          ? 'border-purple-600 bg-purple-950/30'
                          : 'border-zinc-800 bg-zinc-950/60'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {i === activeUuidIndex ? (
                          <span className="w-2 h-2 rounded-full bg-purple-400 shrink-0" />
                        ) : (
                          <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />
                        )}
                        <span className="text-xs font-mono text-zinc-200 truncate">
                          {uuid.length > 36 ? uuid.substring(0, 36) + '...' : uuid}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-zinc-500 mr-1">#{i + 1}</span>
                        {i !== activeUuidIndex && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setActiveUuid(i)}
                            className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-100"
                          >
                            Use
                          </Button>
                        )}
                        {i === activeUuidIndex && (
                          <Badge variant="outline" className="border-purple-900/50 text-purple-400 text-[10px] px-1 py-0">
                            active
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeVisitorUuid(i)}
                          className="h-6 px-2 text-xs text-red-400 hover:text-red-300"
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-zinc-500">
                Status: {visitorUuid ? (
                  <span className="text-green-400">
                    UUID #{activeUuidIndex + 1} active — direct mode (auto-rotate on quota exceeded)
                  </span>
                ) : (
                  <span className="text-zinc-400">No UUID — auto-refresh mode (IP rate-limited)</span>
                )}
              </p>

              {/* TMDB API key section */}
              <div className="pt-3 border-t border-zinc-800 mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-purple-400" />
                    <h4 className="text-sm font-semibold text-zinc-100">TMDB API Key</h4>
                    {tmdbApiKey && (
                      <Badge variant="outline" className="border-green-900/50 text-green-400 text-xs">
                        active
                      </Badge>
                    )}
                  </div>
                  {tmdbApiKey && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearTmdbApiKey}
                      className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Provide a TMDB API key to auto-look up the real TMDB movie/series ID by name + year.
                  The ID is fetched once and cached in SQLite. Get a free key at{' '}
                  <a
                    href="https://www.themoviedb.org/settings/api"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 underline"
                  >
                    themoviedb.org
                  </a>
                  .
                </p>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder="Paste your TMDB API key (v3 auth)"
                    value={tmdbKeyInput}
                    onChange={(e) => setTmdbKeyInput(e.target.value)}
                    className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-purple-500 font-mono text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={saveTmdbApiKey}
                    className="bg-purple-600 hover:bg-purple-700 text-white"
                  >
                    Save
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">
                  Status: {tmdbApiKey ? (
                    <span className="text-green-400">TMDB ID lookup enabled</span>
                  ) : (
                    <span className="text-zinc-400">No API key — TMDB ID lookup disabled</span>
                  )}
                </p>
              </div>

              {/* Telegram Bot URL section */}
              <div className="pt-3 border-t border-zinc-800 mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <ExternalLink className="w-4 h-4 text-purple-400" />
                    <h4 className="text-sm font-semibold text-zinc-100">Telegram Bot URL</h4>
                    {tgBotUrl && (
                      <Badge variant="outline" className="border-green-900/50 text-green-400 text-xs">
                        active
                      </Badge>
                    )}
                  </div>
                  {tgBotUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearTgBotUrl}
                      className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Paste your Telegram Bot URL (e.g. <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-200">https://t.me/CineMMBot</code>).
                  When set, a &ldquo;Get Links via Telegram&rdquo; button will appear on each post detail page.
                </p>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder="https://t.me/YourBotName"
                    value={tgBotInput}
                    onChange={(e) => setTgBotInput(e.target.value)}
                    className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-purple-500 font-mono text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={saveTgBotUrl}
                    className="bg-purple-600 hover:bg-purple-700 text-white"
                  >
                    Save
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">
                  Status: {tgBotUrl ? (
                    <span className="text-green-400">Telegram Bot link enabled</span>
                  ) : (
                    <span className="text-zinc-400">No URL — Telegram button hidden</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Search (hidden when viewing a detail page) */}
      {!selected && (
      <section className="border-b border-zinc-800 bg-zinc-900/30">
        <div className="container mx-auto px-4 py-6">
          <form onSubmit={onSubmit} className="max-w-3xl mx-auto space-y-3">
            <div className="flex items-center justify-center gap-2 text-sm">
              <Tabs value={mediaType} onValueChange={(v) => setMediaType(v as MediaType)}>
                <TabsList className="bg-zinc-800/60">
                  <TabsTrigger value="movie" className="data-[state=active]:bg-purple-600 data-[state=active]:text-white">
                    <Film className="w-4 h-4 mr-2" /> Movies
                  </TabsTrigger>
                  <TabsTrigger value="series" className="data-[state=active]:bg-purple-600 data-[state=active]:text-white">
                    <Tv className="w-4 h-4 mr-2" /> Series
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <Input
                  type="text"
                  placeholder={`Search ${mediaType === 'movie' ? 'movies' : 'series'}... (e.g. Avengers, Breaking Bad)`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-10 bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-purple-500"
                />
              </div>
              <Button type="submit" disabled={loading || !query.trim()} className="bg-purple-600 hover:bg-purple-700 text-white">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                <span className="ml-2 hidden sm:inline">Search</span>
              </Button>
            </div>

            {/* Status row */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
              <div className="flex items-center gap-3">
                {cachedSearch && results && results.length > 0 && (
                  <Badge variant="outline" className="bg-zinc-800/50 border-zinc-700 text-zinc-300">
                    <Database className="w-3 h-3 mr-1" /> Cached result
                  </Badge>
                )}
                <span className="text-zinc-500">
                  Search is unlimited. Detailed post fetches are quota-limited per IP and cached locally.
                </span>
              </div>
            </div>
          </form>
        </div>
      </section>
      )}

      {/* Results (hidden when viewing a detail page) */}
      {!selected && (
      <main className="flex-1 container mx-auto px-4 py-6">
        {error && (
          <div className="max-w-3xl mx-auto mb-6 p-4 rounded-lg border border-red-900/50 bg-red-950/30 text-red-200 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Search error</div>
              <div className="text-sm text-red-300/80 mt-1">{error}</div>
            </div>
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2.5 sm:gap-3 md:gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Card key={i} className="bg-zinc-900 border-zinc-800 overflow-hidden p-0">
                <Skeleton className="aspect-[2/3] rounded-none bg-zinc-800" />
                <div className="p-2 sm:p-3 space-y-1.5">
                  <Skeleton className="h-3.5 sm:h-4 w-3/4 bg-zinc-800" />
                  <Skeleton className="h-3 w-1/3 bg-zinc-800" />
                </div>
              </Card>
            ))}
          </div>
        )}

        {!loading && results && results.length === 0 && (
          <div className="max-w-md mx-auto text-center py-20 text-zinc-500">
            <Search className="w-12 h-12 mx-auto mb-4 opacity-40" />
            <p className="text-lg font-medium text-zinc-300">No results found</p>
            <p className="text-sm mt-2">Try a different search term or switch between Movies/Series.</p>
          </div>
        )}

        {!loading && results && results.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
              <div className="text-sm text-zinc-400">
                {results.length} result{results.length === 1 ? '' : 's'} for <span className="text-zinc-200 font-medium">&ldquo;{query}&rdquo;</span>
                {selectedIds.size > 0 && (
                  <span className="ml-2 text-purple-400">({selectedIds.size} selected)</span>
                )}
              </div>
              <div className="flex gap-2">
                {selectedIds.size > 0 && (
                  <Button
                    size="sm"
                    onClick={() => setSelectedIds(new Set())}
                    className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs"
                  >
                    Clear selection
                  </Button>
                )}
                {selectedIds.size > 0 && (
                  <Button
                    size="sm"
                    onClick={handleBatchDownload}
                    disabled={batchDownloading}
                    className="bg-purple-600 hover:bg-purple-700 text-white text-xs"
                  >
                    {batchDownloading ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        {batchProgress ? `${batchProgress.done}/${batchProgress.total}` : 'Loading…'}
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3 mr-1" />
                        Download {selectedIds.size} as JSON
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2.5 sm:gap-3 md:gap-4">
              {results.map((item) => (
                <ResultCard
                  key={`${item.type}-${item.id}`}
                  item={item}
                  onClick={() => openDetails(item)}
                  selected={selectedIds.has(item.id)}
                  onToggleSelect={() => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }}
                />
              ))}
            </div>
          </>
        )}

        {!loading && !results && !error && (
          <>
            <div className="max-w-md mx-auto text-center py-20 text-zinc-500">
              <Film className="w-12 h-12 mx-auto mb-4 opacity-40" />
              <p className="text-lg font-medium text-zinc-300">Search cinemm.com</p>
              <p className="text-sm mt-2">
                Type a movie or series name above and hit Search. Click any result to see full post details and download as JSON.
              </p>
            </div>

            {/* Shortlink Resolver — always available, even without searching */}
            <div className="max-w-3xl mx-auto mt-8">
              <ShortlinkResolver />
            </div>
          </>
        )}
      </main>
      )}

      {/* Footer (hidden when viewing a detail page) */}
      {!selected && (
      <footer className="border-t border-zinc-800 bg-zinc-900/50 mt-auto">
        <div className="container mx-auto px-4 py-4 text-xs text-zinc-500 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>Personal-use scraper for cinemm.com. Data cached locally in SQLite.</div>
          <div className="text-zinc-600">
            Respect the source site&apos;s terms and robots.txt when using this tool.
          </div>
        </div>
      </footer>
      )}

      {/* Detail page (replaces search page when a post is selected) */}
      {selected && (
        <main className="flex-1 container mx-auto px-4 py-6 max-w-5xl">
          {/* Back button + title */}
          <div className="mb-4 flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={closeDetails}
              className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="ml-2">Back to search</span>
            </Button>
            {/* Next / Previous buttons — let user jump between search results
                without going back to the search page. */}
            {results && results.length > 1 && (() => {
              const currentIdx = results.findIndex(r => r.id === selected.id)
              if (currentIdx === -1) return null
              const prevItem = currentIdx > 0 ? results[currentIdx - 1] : null
              const nextItem = currentIdx < results.length - 1 ? results[currentIdx + 1] : null
              return (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!prevItem || detailsLoading}
                    onClick={() => prevItem && openDetails(prevItem)}
                    className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-zinc-500 px-1">
                    {currentIdx + 1} / {results.length}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!nextItem || detailsLoading}
                    onClick={() => nextItem && openDetails(nextItem)}
                    className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )
            })()}
            <h2 className="text-xl font-bold flex items-center gap-2 flex-wrap">
              {selected.name}
              {selected.year && <span className="text-zinc-500 text-base font-normal">({selected.year})</span>}
              <Badge variant="outline" className="ml-1 border-zinc-700 text-zinc-300 capitalize">
                {selected.type}
              </Badge>
              {tmdbIdLoading && (
                <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" /> TMDB…
                </Badge>
              )}
              {!tmdbIdLoading && tmdbId !== null && (
                <a
                  href={`https://www.themoviedb.org/${selected.type}/${tmdbId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center"
                >
                  <Badge variant="outline" className="border-purple-900/50 text-purple-400 text-xs hover:bg-purple-950/30">
                    <Database className="w-3 h-3 mr-1" /> TMDB: {tmdbId}
                  </Badge>
                </a>
              )}
              {!tmdbIdLoading && tmdbId === null && tmdbApiKey && !tmdbIdError && (
                <Badge variant="outline" className="border-zinc-800 text-zinc-600 text-xs">
                  TMDB: not found
                </Badge>
              )}
              {tmdbIdError && (
                <Badge variant="outline" className="border-amber-900/50 text-amber-400 text-xs" title={tmdbIdError}>
                  TMDB: error
                </Badge>
              )}
            </h2>
          </div>

          {/* Detail content */}
          {detailsLoading && (
            <div className="space-y-3">
              <Skeleton className="h-48 w-32 bg-zinc-800" />
              <Skeleton className="h-4 w-3/4 bg-zinc-800" />
              <Skeleton className="h-32 w-full bg-zinc-800" />
            </div>
          )}

          {detailsError && (
            <div className="p-4 rounded-lg border border-red-900/50 bg-red-950/30 text-red-200 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Failed to load details</div>
                <div className="text-sm text-red-300/80 mt-1">{detailsError}</div>
              </div>
            </div>
          )}

          {!detailsLoading && !detailsError && details && (
            <DetailsView
              item={selected}
              details={details}
              episodeServers={episodeServers}
              episodeServersLoading={episodeServersLoading}
              episodeServersError={episodeServersError}
              episodeManualUrls={episodeManualUrls}
              expandedSeasons={expandedSeasons}
              selectedEpisode={selectedEpisode}
              onToggleSeason={toggleSeason}
              onFetchEpisodeServers={fetchEpisodeServers}
              onSelectEpisode={setSelectedEpisode}
              onExpandAllSeasons={expandAllSeasons}
              tgBotUrl={tgBotUrl}
            />
          )}

          {/* Manual links editor — user can add their own download/stream links */}
          <ManualLinksEditor
            manualDownloadLinks={manualDownloadLinks}
            manualWatchLinks={manualWatchLinks}
            onAddDownloadLink={(link) => setManualDownloadLinks((prev) => [...prev, link])}
            onRemoveDownloadLink={(i) => setManualDownloadLinks((prev) => prev.filter((_, idx) => idx !== i))}
            onAddWatchLink={(link) => setManualWatchLinks((prev) => [...prev, link])}
            onRemoveWatchLink={(i) => setManualWatchLinks((prev) => prev.filter((_, idx) => idx !== i))}
            onImportDownloadLinks={(links) => setManualDownloadLinks((prev) => [...prev, ...links])}
            onImportWatchLinks={(links) => setManualWatchLinks((prev) => [...prev, ...links])}
          />

          {/* Footer actions (sticky at bottom of detail page) */}
          <div className="mt-6 pt-4 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-zinc-500 flex items-center gap-2">
              {details && (
                <span>
                  Fetched: {new Date(details.fetchedAt).toLocaleString()}
                  {details.error && (
                    <span className="text-amber-400 ml-2">• {details.error}</span>
                  )}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyJson}
                disabled={!selected}
                className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span className="ml-2">Copy JSON</span>
              </Button>
              <Button
                size="sm"
                onClick={handleDownloadJson}
                disabled={!selected}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                <Download className="w-4 h-4" />
                <span className="ml-2">Download JSON</span>
              </Button>
            </div>
          </div>
        </main>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

function ResultCard({
  item,
  onClick,
  selected = false,
  onToggleSelect,
}: {
  item: SearchItem
  onClick: () => void
  selected?: boolean
  onToggleSelect?: () => void
}) {
  return (
    <div
      className={`group relative rounded-md sm:rounded-lg overflow-hidden border bg-zinc-900 focus-within:ring-2 focus-within:ring-purple-600 ${
        selected ? 'border-purple-600 ring-2 ring-purple-600/30' : 'border-zinc-800 hover:border-purple-600'
      }`}
    >
      {/* Selection checkbox — top-left corner */}
      {onToggleSelect && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect() }}
          className={`absolute top-1 left-1 z-10 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
            selected ? 'bg-purple-600 text-white' : 'bg-black/70 text-zinc-400 hover:text-white'
          }`}
          aria-label={selected ? 'Deselect' : 'Select'}
        >
          {selected ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </button>
      )}
      {/* Click area — opens detail page */}
      <button
        onClick={onClick}
        className="w-full text-left"
      >
        <div className="aspect-[2/3] bg-zinc-800 relative overflow-hidden">
          {item.poster ? (
            <img
              src={proxyImage(item.poster)}
              alt={item.name}
              loading="lazy"
              className="w-full h-full object-cover"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-600">
              <Film className="w-6 h-6 sm:w-8 sm:h-8" />
            </div>
          )}
          {/* Type badge: small icon-only on mobile, with text on sm+ */}
          <div className="absolute top-1 right-1 sm:top-2 sm:right-2">
            <Badge variant="outline" className="bg-black/70 border-zinc-700 text-zinc-200 backdrop-blur-sm p-1 sm:p-0">
              {item.type === 'movie' ? <Film className="w-2.5 h-2.5 sm:w-3 sm:h-3 sm:mr-1" /> : <Tv className="w-2.5 h-2.5 sm:w-3 sm:h-3 sm:mr-1" />}
              <span className="hidden sm:inline">{item.type}</span>
            </Badge>
          </div>
        </div>
        <div className="p-2 sm:p-3">
          <h3 className="font-medium text-xs sm:text-sm leading-tight line-clamp-2 text-zinc-100">{item.name}</h3>
          {item.year && <p className="text-[11px] sm:text-xs text-zinc-500 mt-1">{item.year}</p>}
        </div>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Details view (shown inside dialog body)
// ---------------------------------------------------------------------------

interface DetailsViewProps {
  item: SearchItem
  details: Details
  episodeServers: Map<number, Server[]>
  episodeServersLoading: Set<number>
  episodeServersError: Set<number>
  episodeManualUrls: Map<number, ManualStreamUrlEntry[]>
  expandedSeasons: Set<number>
  selectedEpisode: number | null
  onToggleSeason: (seasonId: number) => void
  onFetchEpisodeServers: (episodeId: number, source: string) => void
  onSelectEpisode: (episodeId: number | null) => void
  onExpandAllSeasons: () => void
  tgBotUrl: string | null
}

function DetailsView({
  item,
  details,
  episodeServers,
  episodeServersLoading,
  episodeServersError,
  episodeManualUrls,
  expandedSeasons,
  selectedEpisode,
  onToggleSeason,
  onFetchEpisodeServers,
  onSelectEpisode,
  onExpandAllSeasons,
  tgBotUrl,
}: DetailsViewProps) {
  const hasServers = details.type === 'movie' && details.servers.length > 0
  const hasSeasons = details.type === 'series' && details.seasons.length > 0
  const hasTelegramUrls = !!details.telegramStreamUrls && details.telegramStreamUrls.length > 0
  const hasManualUrls = !!details.manualStreamUrls && details.manualStreamUrls.length > 0
  const hasOverview = !!details.overview
  const isQuotaExceeded = details.error === 'QUOTA_EXCEEDED'

  // Auto-fetch all episodes state. When user clicks "Auto Open All", we
  // expand all seasons and fetch servers for every episode sequentially.
  // `useState` is fine here because DetailsView is re-mounted per post.
  const [autoFetching, setAutoFetching] = useState(false)
  const [autoFetchProgress, setAutoFetchProgress] = useState<{ done: number; total: number } | null>(null)

  const allEpisodes =
    hasSeasons
      ? (details as SeriesDetails).seasons.flatMap((s) => s.episodes)
      : []

  const handleAutoOpenAll = async () => {
    if (autoFetching || allEpisodes.length === 0) return
    setAutoFetching(true)
    // Expand all seasons so episodes are visible
    onExpandAllSeasons()
    const total = allEpisodes.length
    setAutoFetchProgress({ done: 0, total })
    let done = 0
    for (const ep of allEpisodes) {
      // Skip episodes that are already loaded or currently loading
      if (!episodeServers.has(ep.id) && !episodeServersLoading.has(ep.id)) {
        onFetchEpisodeServers(ep.id, item.source)
        // Small delay to avoid overwhelming the server
        await new Promise((r) => setTimeout(r, 300))
      }
      done++
      setAutoFetchProgress({ done, total })
    }
    setAutoFetching(false)
    setAutoFetchProgress(null)
  }
  const hasPartialInfo = !hasServers && !hasSeasons && !hasOverview
  const isIpRateLimited = details.error === 'IP_RATE_LIMITED'
  const isRateLimited = details.error === 'RATE_LIMITED'

  return (
    <div className="space-y-5">
      {/* Header row: poster + meta */}
      <div className="flex gap-4">
        <div className="w-24 sm:w-32 shrink-0">
          <div className="aspect-[2/3] rounded-md overflow-hidden bg-zinc-800 border border-zinc-800">
            {item.poster ? (
              <img src={proxyImage(item.poster)} alt={item.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-zinc-600">
                <Film className="w-6 h-6" />
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <h2 className="text-lg font-bold leading-tight">{item.name}</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {item.year && <Badge variant="outline" className="border-zinc-700 text-zinc-300">{item.year}</Badge>}
            <Badge variant="outline" className="border-zinc-700 text-zinc-300 capitalize">{item.type}</Badge>
            <Badge variant="outline" className="border-zinc-700 text-zinc-300">Source: {item.source}</Badge>
            {item.tmdbId && <Badge variant="outline" className="border-zinc-700 text-zinc-300">TMDB: {item.tmdbId}</Badge>}
            {hasSeasons && (
              <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                {(details as SeriesDetails).seasons.length} season{(details as SeriesDetails).seasons.length === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
          {isQuotaExceeded && (
            <div className="mt-2 p-2 rounded border border-amber-900/50 bg-amber-950/30 text-amber-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">cinemm.com quota exceeded</div>
                <div className="text-amber-300/80 mt-0.5">
                  The source site limits detail fetches per IP. The basic info below is still available, and you can
                  download the partial JSON. Try again later or use a different network.
                </div>
              </div>
            </div>
          )}
          {isIpRateLimited && (
            <div className="mt-2 p-2 rounded border border-red-900/50 bg-red-950/30 text-red-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">cinemm.com IP rate-limited</div>
                <div className="text-red-300/80 mt-0.5">
                  Too many quota refreshes from your IP. The auto-refresh can&apos;t mint a new visitor right now.
                  You can still download the basic info as JSON, or try one of these:
                  <ul className="list-disc ml-4 mt-1 space-y-0.5">
                    <li>Use a VPN to get a fresh IP</li>
                    <li>Switch networks (e.g. mobile data instead of WiFi)</li>
                    <li>Wait ~1 hour for the rate-limit to reset</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
          {isRateLimited && (
            <div className="mt-2 p-2 rounded border border-amber-900/50 bg-amber-950/30 text-amber-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">cinemm.com rate-limited</div>
                <div className="text-amber-300/80 mt-0.5">
                  Too many requests. Please wait a moment and try again — the content will load normally.
                </div>
              </div>
            </div>
          )}
          {details.error && details.error !== 'QUOTA_EXCEEDED' && details.error !== 'IP_RATE_LIMITED' && details.error !== 'RATE_LIMITED' && (
            <div className="mt-2 p-2 rounded border border-amber-900/50 bg-amber-950/30 text-amber-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Could not load full details</div>
                <div className="text-amber-300/80 mt-0.5">Error: {details.error}</div>
              </div>
            </div>
          )}
          {!details.error && (
            <div className="text-xs text-zinc-500">
              Remaining quota on source: <span className="text-zinc-300 font-medium">{details.remaining}</span>
            </div>
          )}
          <a
            href={details.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 mt-1"
          >
            View on cinemm.com <ExternalLink className="w-3 h-3" />
          </a>
          {/* Telegram Bot link — uses cinemm.com's format: t.me/cinemmbot?start=w_m_<id> */}
          {tgBotUrl && (
            <a
              href={`${tgBotUrl}?start=w_${item.type === 'movie' ? 'm' : 's'}_${item.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium mt-2"
            >
              <Send className="w-3.5 h-3.5" />
              Get Links via Telegram
            </a>
          )}
        </div>
      </div>

      {/* Servers (movies) */}
      {hasServers && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2 flex items-center gap-2">
            <Download className="w-4 h-4" /> Streaming &amp; Download Servers
            <Badge variant="outline" className="border-zinc-700 text-zinc-400 ml-1">
              {(details as MovieDetails).servers.length}
            </Badge>
          </h3>
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {(details as MovieDetails).servers.map((s, i) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/60 hover:border-purple-600/50 group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Download className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="text-sm truncate">{s.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.size && s.size !== 'N/A' && <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">{s.size}</Badge>}
                  <ExternalLink className="w-3 h-3 text-zinc-600" />
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Telegram Stream Links (new!) — fetched automatically from @cinemmbot */}
      {hasTelegramUrls && (
        <TelegramStreamLinks
          urls={details.telegramStreamUrls!}
          cached={!!details.telegramCached}
        />
      )}
      {details.telegramError && !hasTelegramUrls && !hasManualUrls && (
        <section className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-amber-200">Telegram bot fetch failed</div>
              <div className="text-amber-300/70 mt-1">{details.telegramError}</div>
              <div className="text-amber-300/50 mt-1">
                You can still use the &quot;Get Links via Telegram&quot; button above to fetch manually,
                or submit shortlinks via &quot;Add Stream URLs&quot; below.
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Manually-submitted Stream URLs — stored in DB, shared across all users */}
      {hasManualUrls && (
        <ManualStreamLinks
          urls={details.manualStreamUrls!}
          mediaId={String(item.id)}
          mediaType={item.type}
          onDeleted={() => {
            // Trigger a re-fetch of details to update the list
            // (caller passes a callback if needed; for now we just rely on next page visit)
          }}
        />
      )}

      {/* Add Stream URLs button — Bro submits shortlinks, they get resolved + stored.
          For movies, this is the top-level button.
          For series, we DON'T show this here — the per-episode button inside
          each EpisodeRow is the correct place (series-level URLs don't make sense
          when each episode has different stream URLs). */}
      {item.type === 'movie' && (
        <AddStreamUrlsButton
          mediaId={String(item.id)}
          mediaType={item.type}
          mediaName={item.name}
        />
      )}

      {/* Seasons/episodes tree (series) */}
      {hasSeasons && (
        <section>
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <Tv className="w-4 h-4" /> Seasons &amp; Episodes
              <Badge variant="outline" className="border-zinc-700 text-zinc-400 ml-1">
                {(details as SeriesDetails).seasons.reduce((acc, s) => acc + s.episodes.length, 0)} episodes
              </Badge>
            </h3>
            <Button
              size="sm"
              onClick={handleAutoOpenAll}
              disabled={autoFetching || allEpisodes.length === 0}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
            >
              {autoFetching ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  {autoFetchProgress ? `${autoFetchProgress.done}/${autoFetchProgress.total}` : 'Loading…'}
                </>
              ) : (
                <>
                  <Zap className="w-3 h-3 mr-1" />
                  Auto Open All
                </>
              )}
            </Button>
          </div>
          {autoFetching && autoFetchProgress && (
            <div className="mb-2">
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-600 transition-all"
                  style={{ width: `${(autoFetchProgress.done / autoFetchProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                Fetching servers for episode {autoFetchProgress.done} of {autoFetchProgress.total}…
              </p>
            </div>
          )}
          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
            {(details as SeriesDetails).seasons.map((season) => {
              const isExpanded = expandedSeasons.has(season.id)
              return (
                <div key={season.id} className="rounded-md border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                  <button
                    onClick={() => onToggleSeason(season.id)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-zinc-800/60 text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ChevronRight
                        className={`w-4 h-4 text-zinc-400 shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                      />
                      <span className="font-medium text-sm text-zinc-100">{season.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">
                        {season.episodes.length} ep{season.episodes.length === 1 ? '' : 's'}
                      </Badge>
                      {season.is_end === 1 && (
                        <Badge variant="outline" className="border-green-900/50 text-green-400 text-xs">Ended</Badge>
                      )}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-zinc-800 divide-y divide-zinc-800/60">
                      {season.episodes.map((ep) => (
                        <EpisodeRow
                          key={ep.id}
                          episode={ep}
                          source={item.source}
                          seriesId={String(item.id)}
                          isSelected={selectedEpisode === ep.id}
                          servers={episodeServers.get(ep.id)}
                          isLoading={episodeServersLoading.has(ep.id)}
                          hasError={episodeServersError.has(ep.id)}
                          manualUrls={episodeManualUrls.get(ep.id)}
                          onClick={() => {
                            if (selectedEpisode === ep.id) {
                              onSelectEpisode(null)
                            } else {
                              onSelectEpisode(ep.id)
                              onFetchEpisodeServers(ep.id, item.source)
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Click an episode to fetch its streaming/download servers. Servers are cached after the first fetch.
          </p>
        </section>
      )}

      {/* Overview */}
      {hasOverview && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2">Overview (Original Post)</h3>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-zinc-300 font-sans leading-relaxed max-h-96 overflow-y-auto">
              {details.overview}
            </pre>
          </div>
        </section>
      )}

      {/* Partial info fallback */}
      {hasPartialInfo && !isQuotaExceeded && !isIpRateLimited && !isRateLimited && !details.error && (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No detailed content available for this item. You can still download the basic info as JSON.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Episode row (inside season)
// ---------------------------------------------------------------------------

interface EpisodeRowProps {
  episode: Episode
  source: string
  seriesId: string // parent series bigint ID (for storing per-episode URLs)
  isSelected: boolean
  servers?: Server[]
  isLoading: boolean
  hasError: boolean
  manualUrls?: ManualStreamUrlEntry[]
  onClick: () => void
}

function EpisodeRow({ episode, isSelected, servers, isLoading, hasError, manualUrls, seriesId, onClick }: EpisodeRowProps) {
  return (
    <div>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-3 py-2 hover:bg-zinc-800/60 text-left ${
          isSelected ? 'bg-purple-950/30' : ''
        }`}
      >
        <div className="w-16 h-10 rounded overflow-hidden bg-zinc-800 shrink-0">
          {episode.poster ? (
            <img
              src={proxyImage(episode.poster)}
              alt={`Episode ${episode.episode_number}`}
              loading="lazy"
              className="w-full h-full object-cover"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-600">
              <Tv className="w-3 h-3" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-500 shrink-0">E{String(episode.episode_number).padStart(2, '0')}</span>
            <span className="text-sm font-medium text-zinc-100 truncate">{episode.name || `Episode ${episode.episode_number}`}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
            {episode.air_date && <span>{episode.air_date}</span>}
            {episode.runtime && <span>· {episode.runtime}</span>}
            {episode.is_exclusive === 1 && <Badge variant="outline" className="border-amber-900/50 text-amber-400 text-[10px] px-1 py-0">Exclusive</Badge>}
          </div>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
          ) : hasError ? (
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          ) : servers && servers.length > 0 ? (
            <Badge variant="outline" className="border-purple-900/50 text-purple-400 text-xs">
              {servers.length}
            </Badge>
          ) : (
            <ChevronRight className={`w-4 h-4 text-zinc-500 ${isSelected ? 'rotate-90' : ''}`} />
          )}
        </div>
      </button>
      {isSelected && (
        <div className="px-3 pb-3 pt-1 bg-zinc-950/40">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading servers from cinemm.com...
            </div>
          ) : hasError ? (
            <div className="text-xs text-amber-400 py-2 flex items-center gap-2">
              <AlertTriangle className="w-3 h-3" /> Failed to load (quota may be exceeded). Try again later.
            </div>
          ) : servers && servers.length > 0 ? (
            <div className="space-y-1">
              {servers.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/60 hover:border-purple-600/50 group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Download className="w-3 h-3 text-zinc-500 shrink-0" />
                    <span className="text-xs truncate">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {s.size && s.size !== 'N/A' && <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px] px-1">{s.size}</Badge>}
                    <ExternalLink className="w-2.5 h-2.5 text-zinc-600" />
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <div className="text-xs text-zinc-500 py-2">No servers available for this episode.</div>
          )}

          {/* Manually-submitted stream URLs for this episode (from DB) */}
          {manualUrls && manualUrls.length > 0 && (
            <EpisodeManualUrlsList
              episode={episode}
              urls={manualUrls}
              mediaId={seriesId}
              mediaType="series"
            />
          )}

          {/* Add Stream URLs button — per-episode submission */}
          <EpisodeAddStreamUrlsButton
            episode={episode}
            mediaId={seriesId}
            mediaType="series"
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manual links editor — lets the user add their own download/stream links
// that get merged into the JSON output alongside the auto-fetched links.
// ---------------------------------------------------------------------------

interface ManualLinksEditorProps {
  manualDownloadLinks: ParsedDownloadLink[]
  manualWatchLinks: ParsedWatchLink[]
  onAddDownloadLink: (link: ParsedDownloadLink) => void
  onRemoveDownloadLink: (index: number) => void
  onAddWatchLink: (link: ParsedWatchLink) => void
  onRemoveWatchLink: (index: number) => void
  onImportDownloadLinks: (links: ParsedDownloadLink[]) => void
  onImportWatchLinks: (links: ParsedWatchLink[]) => void
}

function ManualLinksEditor({
  manualDownloadLinks,
  manualWatchLinks,
  onAddDownloadLink,
  onRemoveDownloadLink,
  onAddWatchLink,
  onRemoveWatchLink,
  onImportDownloadLinks,
  onImportWatchLinks,
}: ManualLinksEditorProps) {
  const [expanded, setExpanded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Form state for a new download link
  const [dlServerName, setDlServerName] = useState('')
  const [dlUrl, setDlUrl] = useState('')
  const [dlSize, setDlSize] = useState('')
  const [dlQuality, setDlQuality] = useState('1080p')
  const [dlFileName, setDlFileName] = useState('')

  // Form state for a new watch link
  const [wlServerName, setWlServerName] = useState('')
  const [wlUrl, setWlUrl] = useState('')
  const [wlSize, setWlSize] = useState('')
  const [wlQuality, setWlQuality] = useState('1080p')

  const addDownload = () => {
    if (!dlUrl.trim()) return
    onAddDownloadLink({
      serverName: dlServerName.trim() || 'Manual Link',
      url: dlUrl.trim(),
      size: dlSize.trim() || 'N/A',
      quality: dlQuality.trim() || 'Unknown',
      fileName: dlFileName.trim() || parseFileName(dlUrl.trim()),
    })
    setDlServerName('')
    setDlUrl('')
    setDlSize('')
    setDlFileName('')
  }

  const addWatch = () => {
    if (!wlUrl.trim()) return
    onAddWatchLink({
      serverName: wlServerName.trim() || 'Manual Player',
      url: wlUrl.trim(),
      size: wlSize.trim() || 'N/A',
      quality: wlQuality.trim() || 'Unknown',
    })
    setWlServerName('')
    setWlUrl('')
    setWlSize('')
  }

  // JSON Import — reads a JSON file and extracts downloadLinks/watchLinks.
  // Supports multiple formats:
  //   1. { movies: [{ downloadLinks: [...], watchLinks: [...] }] }  (our format)
  //   2. { downloadLinks: [...], watchLinks: [...] }                (simple)
  //   3. [{ serverName, url, ... }]                                 (array only)
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string)
        let dlLinks: ParsedDownloadLink[] = []
        let wlLinks: ParsedWatchLink[] = []

        // Format 1: { movies: [{ downloadLinks, watchLinks }] }
        if (json.movies && Array.isArray(json.movies)) {
          for (const m of json.movies) {
            if (m.downloadLinks) dlLinks.push(...m.downloadLinks)
            if (m.watchLinks) wlLinks.push(...m.watchLinks)
          }
        }
        // Format 2: { downloadLinks, watchLinks }
        else if (json.downloadLinks || json.watchLinks) {
          if (json.downloadLinks) dlLinks.push(...json.downloadLinks)
          if (json.watchLinks) wlLinks.push(...json.watchLinks)
        }
        // Format 3: plain array
        else if (Array.isArray(json)) {
          dlLinks = json.map((l: Record<string, unknown>) => ({
            serverName: (l.serverName as string) || 'Imported',
            url: (l.url as string) || '',
            size: (l.size as string) || 'N/A',
            quality: (l.quality as string) || 'Unknown',
            fileName: (l.fileName as string) || '',
          })).filter((l: ParsedDownloadLink) => l.url)
          wlLinks = dlLinks.map((l) => ({ serverName: l.serverName, url: l.url, size: l.size, quality: l.quality }))
        }

        if (dlLinks.length > 0) onImportDownloadLinks(dlLinks)
        if (wlLinks.length > 0) onImportWatchLinks(wlLinks)

        const total = dlLinks.length + wlLinks.length
        if (total > 0) {
          toast.success(`Imported ${dlLinks.length} download + ${wlLinks.length} watch links`)
        } else {
          toast.error('No links found in JSON file')
        }
      } catch {
        toast.error('Invalid JSON file')
      }
      // Reset file input so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsText(file)
  }

  return (
    <section className="mt-6">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/60 text-left"
      >
        <div className="flex items-center gap-2">
          <Plus className={`w-4 h-4 text-zinc-400 ${expanded ? 'rotate-45' : ''}`} />
          <span className="font-medium text-sm text-zinc-100">Manual Links</span>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs ml-1">
            {manualDownloadLinks.length + manualWatchLinks.length} added
          </Badge>
        </div>
        <span className="text-xs text-zinc-500">
          {expanded ? 'Click to collapse' : 'Add your own download/stream links'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-4 border border-zinc-800 bg-zinc-900/40 rounded-md p-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-zinc-400">
              Add your own download or stream links here. They will be merged with the auto-fetched links in the JSON
              output (manual links appear first).
            </p>
            {/* JSON Import button */}
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs h-7"
            >
              <Upload className="w-3 h-3 mr-1" />
              Import JSON
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportJson}
              className="hidden"
            />
          </div>

          {/* Download links section */}
          <div>
            <h4 className="text-xs font-semibold text-zinc-200 mb-2 flex items-center gap-2">
              <Download className="w-3.5 h-3.5 text-purple-400" /> Download Links
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <Input
                type="text"
                placeholder="Server name (e.g. Google Drive)"
                value={dlServerName}
                onChange={(e) => setDlServerName(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
              <Input
                type="text"
                placeholder="Quality (e.g. 4K, 1080p)"
                value={dlQuality}
                onChange={(e) => setDlQuality(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
              <Input
                type="url"
                placeholder="URL (https://...)"
                value={dlUrl}
                onChange={(e) => setDlUrl(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8 sm:col-span-2"
              />
              <Input
                type="text"
                placeholder="Size (e.g. 2.5 GB)"
                value={dlSize}
                onChange={(e) => setDlSize(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
              <Input
                type="text"
                placeholder="File name (auto-extracted if empty)"
                value={dlFileName}
                onChange={(e) => setDlFileName(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
            </div>
            <Button
              size="sm"
              onClick={addDownload}
              disabled={!dlUrl.trim()}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-8"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Download Link
            </Button>

            {manualDownloadLinks.length > 0 && (
              <div className="mt-2 space-y-1">
                {manualDownloadLinks.map((link, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800 bg-zinc-950/60">
                    <Download className="w-3 h-3 text-purple-400 shrink-0" />
                    <span className="text-xs text-zinc-200 truncate flex-1">{link.serverName}</span>
                    <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px] px-1">{link.quality}</Badge>
                    <button
                      onClick={() => onRemoveDownloadLink(i)}
                      className="text-red-400 hover:text-red-300 shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Watch/stream links section */}
          <div>
            <h4 className="text-xs font-semibold text-zinc-200 mb-2 flex items-center gap-2">
              <Tv className="w-3.5 h-3.5 text-purple-400" /> Watch / Stream Links
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <Input
                type="text"
                placeholder="Player name (e.g. Player 1)"
                value={wlServerName}
                onChange={(e) => setWlServerName(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
              <Input
                type="text"
                placeholder="Quality (e.g. 1080p)"
                value={wlQuality}
                onChange={(e) => setWlQuality(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
              <Input
                type="url"
                placeholder="URL (https://...)"
                value={wlUrl}
                onChange={(e) => setWlUrl(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8 sm:col-span-2"
              />
              <Input
                type="text"
                placeholder="Size (optional)"
                value={wlSize}
                onChange={(e) => setWlSize(e.target.value)}
                className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs h-8"
              />
            </div>
            <Button
              size="sm"
              onClick={addWatch}
              disabled={!wlUrl.trim()}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-8"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Watch Link
            </Button>

            {manualWatchLinks.length > 0 && (
              <div className="mt-2 space-y-1">
                {manualWatchLinks.map((link, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800 bg-zinc-950/60">
                    <Tv className="w-3 h-3 text-purple-400 shrink-0" />
                    <span className="text-xs text-zinc-200 truncate flex-1">{link.serverName}</span>
                    <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px] px-1">{link.quality}</Badge>
                    <button
                      onClick={() => onRemoveWatchLink(i)}
                      className="text-red-400 hover:text-red-300 shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// TelegramStreamLinks — displays stream URLs fetched automatically from
// @cinemmbot. Each URL gets a copy button + open button + quality badge.
// ---------------------------------------------------------------------------
function TelegramStreamLinks({ urls, cached }: { urls: string[]; cached: boolean }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  // Parse quality + format from URL — e.g. ...Inception.2010.UHD.BluRay.2160p.4K...mkv
  function parseQuality(url: string): string {
    const m = url.match(/(8K|4K|2160p|1080p|720p|480p)/i)
    return m ? m[1].toUpperCase() : 'STD'
  }
  function parseFormat(url: string): string {
    const m = url.match(/\.(mkv|mp4|avi|mov|webm)(?:\?|$)/i)
    return m ? m[1].toUpperCase() : ''
  }
  function parseSource(url: string): string {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^www\./, '').split('.')[0]
      return host.charAt(0).toUpperCase() + host.slice(1)
    } catch {
      return 'Unknown'
    }
  }
  function parseFileName(url: string): string {
    try {
      const u = new URL(url)
      const parts = u.pathname.split('/').filter(Boolean)
      const last = parts[parts.length - 1]
      return last ? decodeURIComponent(last) : ''
    } catch {
      return ''
    }
  }

  async function copyToClipboard(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      toast.success('URL copied to clipboard')
      setTimeout(() => setCopiedIdx(null), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <section className="rounded-lg border border-violet-800/40 bg-gradient-to-br from-violet-950/30 via-zinc-950/40 to-fuchsia-950/20 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-violet-100 flex items-center gap-2">
          <Send className="w-4 h-4 text-violet-400" />
          Stream Links
          <Badge variant="outline" className="border-violet-700/50 text-violet-300 ml-1">
            {urls.length}
          </Badge>
        </h3>
        <div className="flex items-center gap-2 text-xs">
          {cached ? (
            <Badge variant="outline" className="border-emerald-700/50 text-emerald-300 bg-emerald-950/30">
              <Check className="w-3 h-3 mr-1" /> Cached
            </Badge>
          ) : (
            <Badge variant="outline" className="border-violet-700/50 text-violet-300 bg-violet-950/30">
              <Send className="w-3 h-3 mr-1" /> From @cinemmbot
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {urls.map((url, i) => {
          const quality = parseQuality(url)
          const format = parseFormat(url)
          const source = parseSource(url)
          const fileName = parseFileName(url)
          const isCopied = copiedIdx === i

          // Color code by quality
          const qualityColor =
            quality === '4K' || quality === '8K'
              ? 'border-fuchsia-600/50 bg-fuchsia-950/30 text-fuchsia-300'
              : quality === '2160p'
              ? 'border-purple-600/50 bg-purple-950/30 text-purple-300'
              : quality === '1080p'
              ? 'border-blue-600/50 bg-blue-950/30 text-blue-300'
              : quality === '720p'
              ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
              : 'border-zinc-700 bg-zinc-900/40 text-zinc-300'

          return (
            <div
              key={i}
              className="rounded-md border border-zinc-800 bg-zinc-950/60 hover:border-violet-700/50 transition-colors overflow-hidden"
            >
              {/* Top row: quality badges + source */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/40">
                <Badge variant="outline" className={`text-xs ${qualityColor}`}>
                  {quality === '4K' || quality === '8K' ? `🎬 ${quality}` : quality}
                </Badge>
                {format && (
                  <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">
                    {format}
                  </Badge>
                )}
                <Badge variant="outline" className="border-zinc-700 text-zinc-500 text-xs">
                  {source}
                </Badge>
                <div className="ml-auto text-xs text-zinc-500 truncate">{fileName || url}</div>
              </div>

              {/* Bottom row: action buttons */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => copyToClipboard(url, i)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
                >
                  {isCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy URL
                    </>
                  )}
                </button>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Stream
                </a>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 text-[11px] text-zinc-500 flex items-center gap-1.5">
        <Send className="w-3 h-3" />
        Auto-fetched via @cinemmbot — URLs are valid for ~7 days. Click &quot;Open Stream&quot; to play in browser or &quot;Copy URL&quot; to paste in a downloader.
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// ShortlinkResolver — Bro pastes cinemm.com shortlinks, we resolve them
// to real stream URLs via /api/resolve-shortlinks-batch.
// ---------------------------------------------------------------------------
interface ResolvedShortlink {
  shortlink: string
  streamUrl: string | null
  cached: boolean
  error: string | null
  httpStatus?: number
}

function ShortlinkResolver() {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<ResolvedShortlink[]>([])
  const [loading, setLoading] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  // Parse textarea input → array of URLs (one per line, or space/comma separated)
  function parseUrls(text: string): string[] {
    return text
      .split(/[\n,\s]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
  }

  async function handleResolve() {
    const urls = parseUrls(input)
    if (urls.length === 0) {
      toast.error('No URLs found. Paste cinemm.com shortlinks.')
      return
    }
    setLoading(true)
    setResults([])
    try {
      const res = await fetch('/api/resolve-shortlinks-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `Failed (${res.status})`)
      }
      setResults(data.results || [])
      const success = data.success || 0
      const failed = data.failed || 0
      if (success > 0 && failed === 0) {
        toast.success(`Resolved ${success} shortlink${success === 1 ? '' : 's'}`)
      } else if (success > 0 && failed > 0) {
        toast.info(`Resolved ${success}, failed ${failed}`)
      } else {
        toast.error(`All ${failed} shortlinks failed`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resolve')
    } finally {
      setLoading(false)
    }
  }

  async function copyToClipboard(text: string, idx: number, type: 'shortlink' | 'streamUrl') {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx * 10 + (type === 'shortlink' ? 0 : 1))
      toast.success(`${type === 'shortlink' ? 'Shortlink' : 'Stream URL'} copied`)
      setTimeout(() => setCopiedIdx(null), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  function parseQuality(url: string): string {
    const m = url.match(/(8K|4K|2160p|1080p|720p|480p)/i)
    return m ? m[1].toUpperCase() : 'STD'
  }
  function parseFormat(url: string): string {
    const m = url.match(/\.(mkv|mp4|avi|mov|webm)(?:\?|$)/i)
    return m ? m[1].toUpperCase() : ''
  }
  function parseFileName(url: string): string {
    try {
      const u = new URL(url)
      const parts = u.pathname.split('/').filter(Boolean)
      const last = parts[parts.length - 1]
      return last ? decodeURIComponent(last) : ''
    } catch {
      return ''
    }
  }
  function parseHost(url: string): string {
    try {
      const u = new URL(url)
      return u.hostname.replace(/^www\./, '')
    } catch {
      return 'unknown'
    }
  }

  const urlCount = parseUrls(input).length

  return (
    <section className="rounded-lg border border-cyan-800/40 bg-gradient-to-br from-cyan-950/20 via-zinc-950/40 to-blue-950/20 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-cyan-100 flex items-center gap-2">
          <Zap className="w-4 h-4 text-cyan-400" />
          Shortlink Resolver
          {results.length > 0 && (
            <Badge variant="outline" className="border-cyan-700/50 text-cyan-300 ml-1">
              {results.filter((r) => r.streamUrl).length}/{results.length}
            </Badge>
          )}
        </h3>
        <div className="text-[11px] text-zinc-500">
          Paste cinemm.com/p/... shortlinks → get real stream URLs
        </div>
      </div>

      {/* Input area */}
      <div className="space-y-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste shortlinks here (one per line, or space/comma separated)...&#10;https://cinemm.com/p/R1W_eSSX2hE-qUAl...&#10;https://cinemm.com/p/Oa77DLE_kRMWlGfX..."
          rows={4}
          className="w-full rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-600/50 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 font-mono"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-zinc-500">
            {urlCount > 0 ? `${urlCount} URL${urlCount === 1 ? '' : 's'} ready` : 'No URLs yet'}
          </div>
          <Button
            onClick={handleResolve}
            disabled={loading || urlCount === 0}
            size="sm"
            className="bg-cyan-600 hover:bg-cyan-500 text-white text-xs h-8"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                Resolving...
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 mr-1" />
                Resolve {urlCount > 0 ? `(${urlCount})` : ''}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map((r, i) => {
            const hasStreamUrl = !!r.streamUrl
            const quality = hasStreamUrl ? parseQuality(r.streamUrl!) : ''
            const format = hasStreamUrl ? parseFormat(r.streamUrl!) : ''
            const fileName = hasStreamUrl ? parseFileName(r.streamUrl!) : ''
            const host = hasStreamUrl ? parseHost(r.streamUrl!) : ''

            const qualityColor =
              quality === '4K' || quality === '8K'
                ? 'border-fuchsia-600/50 bg-fuchsia-950/30 text-fuchsia-300'
                : quality === '2160p'
                ? 'border-purple-600/50 bg-purple-950/30 text-purple-300'
                : quality === '1080p'
                ? 'border-blue-600/50 bg-blue-950/30 text-blue-300'
                : quality === '720p'
                ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900/40 text-zinc-300'

            return (
              <div
                key={i}
                className={`rounded-md border overflow-hidden ${
                  hasStreamUrl
                    ? 'border-zinc-800 bg-zinc-950/60'
                    : 'border-red-900/50 bg-red-950/20'
                }`}
              >
                {/* Top row: badges */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/40 flex-wrap">
                  {hasStreamUrl ? (
                    <>
                      {quality && (
                        <Badge variant="outline" className={`text-xs ${qualityColor}`}>
                          {quality === '4K' || quality === '8K' ? `🎬 ${quality}` : quality}
                        </Badge>
                      )}
                      {format && (
                        <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">
                          {format}
                        </Badge>
                      )}
                      <Badge variant="outline" className="border-zinc-700 text-zinc-500 text-xs">
                        {host}
                      </Badge>
                      {r.cached && (
                        <Badge variant="outline" className="border-emerald-700/50 text-emerald-300 bg-emerald-950/30 text-xs">
                          <Check className="w-3 h-3 mr-1" /> Cached
                        </Badge>
                      )}
                      <div className="ml-auto text-xs text-zinc-500 truncate max-w-full">
                        {fileName}
                      </div>
                    </>
                  ) : (
                    <>
                      <Badge variant="outline" className="border-red-700/50 text-red-300 bg-red-950/30 text-xs">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Failed
                      </Badge>
                      <div className="ml-auto text-xs text-red-300/70 truncate">
                        {r.error}
                      </div>
                    </>
                  )}
                </div>

                {/* Middle row: shortlink (the working URL) */}
                {hasStreamUrl && (
                  <div className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-950/40">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                      🔗 Shortlink (works in browser)
                    </div>
                    <div className="text-xs text-cyan-300 font-mono truncate">{r.shortlink}</div>
                  </div>
                )}

                {/* Bottom row: action buttons */}
                {hasStreamUrl && (
                  <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
                    <button
                      onClick={() => copyToClipboard(r.shortlink!, i, 'shortlink')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
                    >
                      {copiedIdx === i * 10 ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy Shortlink
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => copyToClipboard(r.streamUrl!, i, 'streamUrl')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
                    >
                      {copiedIdx === i * 10 + 1 ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy Stream URL
                        </>
                      )}
                    </button>
                    <a
                      href={r.shortlink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open Stream
                    </a>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Help text */}
      <div className="mt-3 text-[11px] text-zinc-500 flex items-start gap-1.5">
        <Zap className="w-3 h-3 mt-0.5 shrink-0" />
        <div>
          Paste cinemm.com shortlinks (e.g. https://cinemm.com/p/R1W_...) from a movie post.
          We resolve them to real stream URLs via Cloudflare redirect. Use &quot;Open Stream&quot; to play in browser (shortlink redirects properly).
          Stream URLs are cached for 24h.
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// AddStreamUrlsButton — opens a modal where Bro pastes cinemm.com shortlinks.
// On submit, calls /api/manual-link which resolves + stores them in DB.
// After successful submit, shows a success message and prompts user to refresh.
// ---------------------------------------------------------------------------
function AddStreamUrlsButton({
  mediaId,
  mediaType,
  mediaName,
}: {
  mediaId: string
  mediaType: MediaType
  mediaName: string
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    stored: number
    failed: number
    results: Array<{ shortlink: string; streamUrl?: string; stored: boolean; error?: string }>
  } | null>(null)

  function parseUrls(text: string): string[] {
    return text
      .split(/[\n,\s]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
  }

  async function handleSubmit() {
    const urls = parseUrls(input)
    if (urls.length === 0) {
      toast.error('No URLs found. Paste cinemm.com shortlinks.')
      return
    }
    setSubmitting(true)
    setResult(null)
    try {
      const res = await fetch('/api/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId,
          mediaType,
          shortlinks: urls,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `Failed (${res.status})`)
      }
      setResult(data)
      if (data.stored > 0) {
        toast.success(`Stored ${data.stored} stream URL${data.stored === 1 ? '' : 's'} for ${mediaName}`)
      } else {
        toast.error('No URLs could be stored')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    setOpen(false)
    setInput('')
    setResult(null)
    // If we stored any URLs, reload the page so the new URLs show up
    if (result && result.stored > 0) {
      window.location.reload()
    }
  }

  const urlCount = parseUrls(input).length

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-3 px-3 py-2 rounded-md border border-cyan-800/40 bg-cyan-950/20 hover:bg-cyan-900/30 text-cyan-200 text-xs font-medium transition-colors flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add Stream URLs (Manual)
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={handleClose}
        >
          <div
            className="bg-zinc-950 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4 sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-4">
              <div>
                <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-cyan-400" />
                  Add Stream URLs
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  For: <span className="text-zinc-300 font-medium">{mediaName}</span> ({mediaType})
                </p>
              </div>
              <button
                onClick={handleClose}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {!result ? (
              <>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-zinc-400 mb-1 block">
                      Paste cinemm.com shortlinks here
                    </label>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="https://cinemm.com/p/R1W_eSSX2hE-qUAl...&#10;https://cinemm.com/p/Oa77DLE_kRMWlGfX...&#10;(one per line, or space/comma separated)"
                      rows={6}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-600/50 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 font-mono"
                      disabled={submitting}
                    />
                    <div className="text-xs text-zinc-500 mt-1">
                      {urlCount > 0 ? `${urlCount} URL${urlCount === 1 ? '' : 's'} ready` : 'No URLs yet'}
                    </div>
                  </div>

                  <div className="text-xs text-zinc-400 bg-zinc-900/60 rounded-md p-3 border border-zinc-800">
                    <div className="font-medium text-zinc-300 mb-1">How to get shortlinks:</div>
                    <ol className="list-decimal ml-4 space-y-0.5">
                      <li>Open cinemm.com and find this movie/series post</li>
                      <li>Click &quot;Show Sources&quot; button on the post</li>
                      <li>Copy the shortlinks that appear (e.g. https://cinemm.com/p/...)</li>
                      <li>Paste them above and click Submit</li>
                    </ol>
                    <div className="mt-2 text-zinc-500">
                      URLs are resolved and stored for 7 days. Anyone viewing this post will see them.
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={handleClose}
                      className="px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 text-sm"
                      disabled={submitting}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || urlCount === 0}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Resolving + Storing...
                        </>
                      ) : (
                        <>
                          <Zap className="w-3.5 h-3.5" />
                          Submit ({urlCount})
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className={`rounded-md p-3 border ${result.stored > 0 ? 'border-emerald-800/50 bg-emerald-950/30' : 'border-red-800/50 bg-red-950/30'}`}>
                  <div className="flex items-center gap-2">
                    {result.stored > 0 ? (
                      <Check className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-5 h-5 text-red-400" />
                    )}
                    <div>
                      <div className={`font-semibold ${result.stored > 0 ? 'text-emerald-200' : 'text-red-200'}`}>
                        {result.stored > 0 ? 'Success!' : 'Failed'}
                      </div>
                      <div className={`text-xs ${result.stored > 0 ? 'text-emerald-300/80' : 'text-red-300/80'}`}>
                        Stored: {result.stored} | Failed: {result.failed}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {result.results.map((r, i) => (
                    <div
                      key={i}
                      className={`rounded-md border p-2 text-xs ${
                        r.stored ? 'border-zinc-800 bg-zinc-900/60' : 'border-red-900/50 bg-red-950/20'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {r.stored ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <X className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-zinc-300 font-mono truncate">{r.shortlink}</div>
                          {r.streamUrl && (
                            <div className="text-emerald-300/70 font-mono truncate mt-0.5">→ {r.streamUrl}</div>
                          )}
                          {r.error && (
                            <div className="text-red-300/70 mt-0.5">{r.error}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={handleClose}
                    className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium"
                  >
                    {result.stored > 0 ? 'Done (refresh page)' : 'Close'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// ManualStreamLinks — displays stream URLs that were manually submitted
// (via /api/manual-link) and stored in the ManualStreamUrl DB table.
// Each URL shows quality/format/host badges + copy/open buttons + delete option.
// ---------------------------------------------------------------------------
function ManualStreamLinks({
  urls,
  mediaId,
  mediaType,
  onDeleted,
}: {
  urls: ManualStreamUrlEntry[]
  mediaId: string
  mediaType: MediaType
  onDeleted?: () => void
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  async function copyToClipboard(text: string, idx: number, type: 'shortlink' | 'streamUrl') {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx * 10 + (type === 'shortlink' ? 0 : 1))
      toast.success(`${type === 'shortlink' ? 'Shortlink' : 'Stream URL'} copied`)
      setTimeout(() => setCopiedIdx(null), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  async function handleDelete(shortlink: string, idx: number) {
    if (!confirm('Delete this stream URL?')) return
    setDeleting(idx)
    try {
      const url = `/api/manual-link?mediaId=${encodeURIComponent(mediaId)}&mediaType=${mediaType}&shortlink=${encodeURIComponent(shortlink)}`
      const res = await fetch(url, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      toast.success('Stream URL deleted')
      // Trigger parent re-fetch
      onDeleted?.()
      // Also reload to refresh the list
      setTimeout(() => window.location.reload(), 500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(null)
    }
  }

  function qualityColor(quality: string): string {
    if (quality === '4K' || quality === '8K') return 'border-fuchsia-600/50 bg-fuchsia-950/30 text-fuchsia-300'
    if (quality === '2160p') return 'border-purple-600/50 bg-purple-950/30 text-purple-300'
    if (quality === '1080p') return 'border-blue-600/50 bg-blue-950/30 text-blue-300'
    if (quality === '720p') return 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
    return 'border-zinc-700 bg-zinc-900/40 text-zinc-300'
  }

  return (
    <section className="rounded-lg border border-emerald-800/40 bg-gradient-to-br from-emerald-950/20 via-zinc-950/40 to-teal-950/20 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-emerald-100 flex items-center gap-2">
          <Database className="w-4 h-4 text-emerald-400" />
          Stream Links (Community)
          <Badge variant="outline" className="border-emerald-700/50 text-emerald-300 ml-1">
            {urls.length}
          </Badge>
        </h3>
        <Badge variant="outline" className="border-emerald-700/50 text-emerald-300 bg-emerald-950/30 text-xs">
          <Check className="w-3 h-3 mr-1" /> Stored · 7-day TTL
        </Badge>
      </div>

      <div className="space-y-2">
        {urls.map((entry, i) => {
          const isCopiedShort = copiedIdx === i * 10
          const isCopiedStream = copiedIdx === i * 10 + 1
          const isDeleting = deleting === i

          return (
            <div
              key={i}
              className="rounded-md border border-zinc-800 bg-zinc-950/60 hover:border-emerald-700/40 transition-colors overflow-hidden"
            >
              {/* Top row: badges */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/40 flex-wrap">
                <Badge variant="outline" className={`text-xs ${qualityColor(entry.quality)}`}>
                  {entry.quality === '4K' || entry.quality === '8K' ? `🎬 ${entry.quality}` : entry.quality}
                </Badge>
                {entry.format && (
                  <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">
                    {entry.format}
                  </Badge>
                )}
                <Badge variant="outline" className="border-zinc-700 text-zinc-500 text-xs">
                  {entry.host}
                </Badge>
                {entry.fileSize && entry.fileSize !== 'N/A' && (
                  <Badge variant="outline" className="border-amber-800/40 bg-amber-950/20 text-amber-300 text-xs">
                    {entry.fileSize}
                  </Badge>
                )}
                <div className="ml-auto text-xs text-zinc-500 truncate max-w-full">
                  {entry.fileName}
                </div>
              </div>

              {/* Middle row: shortlink */}
              <div className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-950/40">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                  🔗 Shortlink (works in browser)
                </div>
                <div className="text-xs text-emerald-300 font-mono truncate">{entry.shortlink}</div>
              </div>

              {/* Bottom row: action buttons */}
              <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
                <button
                  onClick={() => copyToClipboard(entry.shortlink, i, 'shortlink')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
                >
                  {isCopiedShort ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Shortlink
                    </>
                  )}
                </button>
                <button
                  onClick={() => copyToClipboard(entry.streamUrl, i, 'streamUrl')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
                >
                  {isCopiedStream ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Stream URL
                    </>
                  )}
                </button>
                <a
                  href={entry.shortlink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Stream
                </a>
                <button
                  onClick={() => handleDelete(entry.shortlink, i)}
                  disabled={isDeleting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-900/40 hover:bg-red-800/50 text-red-300 text-xs font-medium transition-colors ml-auto disabled:opacity-50"
                  title="Delete this stream URL"
                >
                  {isDeleting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 text-[11px] text-zinc-500 flex items-start gap-1.5">
        <Database className="w-3 h-3 mt-0.5 shrink-0" />
        <div>
          These stream URLs were submitted by a user and stored in the database. They are shared
          across all viewers and cached for 7 days. Use &quot;Open Stream&quot; to play in browser
          (shortlink redirects properly via Cloudflare).
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// EpisodeAddStreamUrlsButton — per-episode "Add Stream URLs" button.
// Opens a modal where Bro pastes shortlinks. On submit, calls /api/manual-link
// with episodeId so URLs are stored specifically for this episode.
// ---------------------------------------------------------------------------
function EpisodeAddStreamUrlsButton({
  episode,
  mediaId,
  mediaType,
}: {
  episode: Episode
  mediaId: string
  mediaType: MediaType
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    stored: number
    failed: number
  } | null>(null)

  function parseUrls(text: string): string[] {
    return text.split(/[\n,\s]+/).map((u) => u.trim()).filter((u) => u.length > 0)
  }

  async function handleSubmit() {
    const urls = parseUrls(input)
    if (urls.length === 0) {
      toast.error('No URLs found')
      return
    }
    setSubmitting(true)
    setResult(null)
    try {
      const res = await fetch('/api/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId,
          mediaType,
          episodeId: String(episode.id), // ← per-episode storage
          shortlinks: urls,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setResult({ stored: data.stored || 0, failed: data.failed || 0 })
      if (data.stored > 0) {
        toast.success(`Stored ${data.stored} URL(s) for Episode ${episode.episode_number}`)
      } else {
        toast.error('No URLs could be stored')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    setOpen(false)
    setInput('')
    setResult(null)
    if (result && result.stored > 0) {
      // Reload to refresh the episode's URL list
      window.location.reload()
    }
  }

  const urlCount = parseUrls(input).length
  const epLabel = `E${String(episode.episode_number).padStart(2, '0')}`

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-2 px-2.5 py-1.5 rounded border border-cyan-800/40 bg-cyan-950/20 hover:bg-cyan-900/30 text-cyan-200 text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5"
      >
        <Plus className="w-3 h-3" />
        Add Stream URLs for {epLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={handleClose}
        >
          <div
            className="bg-zinc-950 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4 sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-4">
              <div>
                <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-cyan-400" />
                  Add Stream URLs — Episode {episode.episode_number}
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  {episode.name || `Episode ${episode.episode_number}`} · Episode ID: {episode.id}
                </p>
              </div>
              <button onClick={handleClose} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {!result ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">
                    Paste cinemm.com shortlinks here
                  </label>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="https://cinemm.com/p/R1W_eSSX2hE-qUAl...&#10;https://cinemm.com/p/Oa77DLE_kRMWlGfX..."
                    rows={5}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-600/50 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 font-mono"
                    disabled={submitting}
                  />
                  <div className="text-xs text-zinc-500 mt-1">
                    {urlCount > 0 ? `${urlCount} URL${urlCount === 1 ? '' : 's'} ready` : 'No URLs yet'}
                  </div>
                </div>

                <div className="text-xs text-zinc-400 bg-zinc-900/60 rounded-md p-3 border border-zinc-800">
                  <div className="font-medium text-zinc-300 mb-1">How to get shortlinks:</div>
                  <ol className="list-decimal ml-4 space-y-0.5">
                    <li>Open cinemm.com and find this series</li>
                    <li>Click the episode → &quot;Show Sources&quot;</li>
                    <li>Copy the shortlinks that appear</li>
                    <li>Paste them above and click Submit</li>
                  </ol>
                  <div className="mt-2 text-zinc-500">
                    URLs are stored specifically for this episode. Cached for 7 days.
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={handleClose}
                    className="px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 text-sm"
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || urlCount === 0}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Storing...
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        Submit ({urlCount})
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className={`rounded-md p-3 border ${result.stored > 0 ? 'border-emerald-800/50 bg-emerald-950/30' : 'border-red-800/50 bg-red-950/30'}`}>
                  <div className="flex items-center gap-2">
                    {result.stored > 0 ? (
                      <Check className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-5 h-5 text-red-400" />
                    )}
                    <div>
                      <div className={`font-semibold ${result.stored > 0 ? 'text-emerald-200' : 'text-red-200'}`}>
                        {result.stored > 0 ? 'Success!' : 'Failed'}
                      </div>
                      <div className={`text-xs ${result.stored > 0 ? 'text-emerald-300/80' : 'text-red-300/80'}`}>
                        Stored: {result.stored} | Failed: {result.failed}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={handleClose}
                    className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium"
                  >
                    {result.stored > 0 ? 'Done (refresh)' : 'Close'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// EpisodeManualUrlsList — displays stream URLs stored for a specific episode.
// Compact version of ManualStreamLinks, sized to fit inside episode card.
// Includes a delete button (trash icon) for each URL.
// ---------------------------------------------------------------------------
function EpisodeManualUrlsList({
  episode,
  urls,
  mediaId,
  mediaType,
}: {
  episode: Episode
  urls: ManualStreamUrlEntry[]
  mediaId: string
  mediaType: MediaType
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null)

  async function copyToClipboard(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      toast.success('URL copied')
      setTimeout(() => setCopiedIdx(null), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  async function handleDelete(shortlink: string, idx: number) {
    if (!confirm('Delete this stream URL?')) return
    setDeletingIdx(idx)
    try {
      const url = `/api/manual-link?mediaId=${encodeURIComponent(mediaId)}&mediaType=${mediaType}&episodeId=${encodeURIComponent(String(episode.id))}&shortlink=${encodeURIComponent(shortlink)}`
      const res = await fetch(url, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      toast.success('Stream URL deleted')
      // Reload to refresh the episode's URL list
      setTimeout(() => window.location.reload(), 500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeletingIdx(null)
    }
  }

  function qualityColor(quality: string): string {
    if (quality === '4K' || quality === '8K') return 'border-fuchsia-600/50 bg-fuchsia-950/30 text-fuchsia-300'
    if (quality === '2160p') return 'border-purple-600/50 bg-purple-950/30 text-purple-300'
    if (quality === '1080p') return 'border-blue-600/50 bg-blue-950/30 text-blue-300'
    if (quality === '720p') return 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
    return 'border-zinc-700 bg-zinc-900/40 text-zinc-300'
  }

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/60">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Database className="w-3 h-3 text-emerald-400" />
        <span className="text-[10px] uppercase tracking-wider text-emerald-300/80 font-semibold">
          Stream Links (Episode)
        </span>
        <Badge variant="outline" className="border-emerald-700/50 text-emerald-300 text-[10px] px-1 py-0">
          {urls.length}
        </Badge>
      </div>
      <div className="space-y-1">
        {urls.map((entry, i) => {
          const isCopied = copiedIdx === i
          const isDeleting = deletingIdx === i
          return (
            <div
              key={i}
              className="rounded border border-zinc-800 bg-zinc-950/60 hover:border-emerald-700/40 transition-colors overflow-hidden"
            >
              <div className="flex items-center gap-1.5 px-2 py-1 border-b border-zinc-800/60 bg-zinc-900/40 flex-wrap">
                <Badge variant="outline" className={`text-[10px] px-1 py-0 ${qualityColor(entry.quality)}`}>
                  {entry.quality === '4K' || entry.quality === '8K' ? `🎬 ${entry.quality}` : entry.quality}
                </Badge>
                {entry.format && (
                  <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px] px-1 py-0">
                    {entry.format}
                  </Badge>
                )}
                <Badge variant="outline" className="border-zinc-700 text-zinc-500 text-[10px] px-1 py-0">
                  {entry.host.split('.')[0]}
                </Badge>
                {entry.fileSize && entry.fileSize !== 'N/A' && (
                  <Badge variant="outline" className="border-amber-800/40 bg-amber-950/20 text-amber-300 text-[10px] px-1 py-0">
                    {entry.fileSize}
                  </Badge>
                )}
                <div className="ml-auto text-[10px] text-zinc-500 truncate max-w-[60%]">
                  {entry.fileName}
                </div>
              </div>
              <div className="flex items-center gap-1 px-2 py-1">
                <button
                  onClick={() => copyToClipboard(entry.streamUrl, i)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] font-medium transition-colors"
                >
                  {isCopied ? (
                    <>
                      <Check className="w-2.5 h-2.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-2.5 h-2.5" />
                      Copy URL
                    </>
                  )}
                </button>
                <a
                  href={entry.shortlink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium transition-colors"
                >
                  <ExternalLink className="w-2.5 h-2.5" />
                  Open
                </a>
                <button
                  onClick={() => handleDelete(entry.shortlink, i)}
                  disabled={isDeleting}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-900/40 hover:bg-red-800/50 text-red-300 text-[10px] font-medium transition-colors ml-auto disabled:opacity-50"
                  title="Delete this stream URL"
                >
                  {isDeleting ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-2.5 h-2.5" />
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
