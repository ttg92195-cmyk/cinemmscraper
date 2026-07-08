'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Search, Film, Tv, Download, Loader2, AlertTriangle, ExternalLink, Database, Copy, Check, X, Image as ImageIcon, ChevronRight, ArrowLeft, KeyRound, Settings } from 'lucide-react'
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
}

type Details = MovieDetails | SeriesDetails

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
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
  const downloadLinks: ParsedDownloadLink[] = []
  const watchLinks: ParsedWatchLink[] = []
  for (const s of servers) {
    const quality = parseQuality(s.name)
    const fileName = parseFileName(s.url)
    const isDownload = s.name.toLowerCase().includes('download')
    if (isDownload) {
      downloadLinks.push({
        serverName: s.name,
        url: s.url,
        size: s.size,
        quality,
        fileName,
      })
    } else {
      watchLinks.push({
        serverName: s.name,
        url: s.url,
        size: s.size,
        quality,
      })
    }
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
) {
  const overview = details?.overview ?? ''
  const metadata = parseOverviewMetadata(overview)
  const tmdbId = item.tmdbId ? Number(item.tmdbId) : null

  let movieEntry: Record<string, unknown>

  if (details?.type === 'movie') {
    const { downloadLinks, watchLinks } = splitServers(details.servers)
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
      downloadLinks,
      watchLinks,
      seasons: [],
    }
  } else if (details?.type === 'series') {
    const seasons = details.seasons.map((s) => ({
      name: s.name,
      episodes: s.episodes.map((e) => {
        const epServers = episodeServers?.get(e.id) ?? []
        const { downloadLinks, watchLinks } = splitServers(epServers)
        return {
          name: e.name || `Episode ${e.episode_number}`,
          videoUrl: watchLinks[0]?.url ?? downloadLinks[0]?.url ?? '',
          downloadLinks,
          watchLinks,
        }
      }),
    }))
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
      downloadLinks: [],
      watchLinks: [],
      seasons,
    }
  } else {
    // No details loaded (quota exceeded / not fetched yet)
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
      downloadLinks: [],
      watchLinks: [],
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
  const [query, setQuery] = useState('')
  const [mediaType, setMediaType] = useState<MediaType>('movie')
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
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set())
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null)

  // User-supplied cinemm.com visitor UUID (from localStorage). When present,
  // requests use this UUID directly via the user_uuid cookie — bypassing the
  // auto-refresh path and its IP rate-limiting side effects.
  const [visitorUuid, setVisitorUuid] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [uuidInput, setUuidInput] = useState('')

  // Load UUID from localStorage on mount
  useEffect(() => {
    const stored = window.localStorage.getItem('cinemm_visitor_uuid')
    if (stored) {
      setVisitorUuid(stored)
      setUuidInput(stored)
    }
  }, [])

  const saveVisitorUuid = useCallback(() => {
    const trimmed = uuidInput.trim()
    if (trimmed) {
      window.localStorage.setItem('cinemm_visitor_uuid', trimmed)
      setVisitorUuid(trimmed)
      toast.success('UUID saved — will be used for all detail fetches')
      setSettingsOpen(false)
    } else {
      // Empty input = clear
      window.localStorage.removeItem('cinemm_visitor_uuid')
      setVisitorUuid(null)
      toast.info('UUID cleared — using auto-refresh mode')
      setSettingsOpen(false)
    }
  }, [uuidInput])

  const clearVisitorUuid = useCallback(() => {
    window.localStorage.removeItem('cinemm_visitor_uuid')
    setVisitorUuid(null)
    setUuidInput('')
    toast.info('UUID cleared — using auto-refresh mode')
  }, [])

  const onSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      const q = query.trim()
      if (!q) return
      setLoading(true)
      setError(null)
      setResults(null)
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}&type=${mediaType}`,
        )
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
    setEpisodeServersLoading(new Set())
    setEpisodeServersError(new Set())
    setExpandedSeasons(new Set())
    setSelectedEpisode(null)
    // Push URL state so the browser back button returns to search results.
    const detailUrl = new URL(window.location.href)
    detailUrl.searchParams.set('view', 'details')
    detailUrl.searchParams.set('id', String(item.id))
    detailUrl.searchParams.set('type', item.type)
    detailUrl.searchParams.set('source', item.source)
    detailUrl.searchParams.set('name', item.name)
    detailUrl.searchParams.set('year', item.year)
    detailUrl.searchParams.set('poster', item.poster)
    window.history.pushState({ view: 'details', itemId: item.id }, '', detailUrl.toString())
    window.scrollTo(0, 0)
    try {
      const url = new URL('/api/details', window.location.origin)
      url.searchParams.set('id', String(item.id))
      url.searchParams.set('type', item.type)
      url.searchParams.set('source', item.source)
      url.searchParams.set('name', item.name)
      url.searchParams.set('year', item.year)
      url.searchParams.set('poster', item.poster)
      if (visitorUuid) url.searchParams.set('uuid', visitorUuid)
      const res = await fetch(url.toString())
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setDetails(data as Details)
      // Auto-expand first season for series
      if ((data as Details).type === 'series' && (data as SeriesDetails).seasons.length > 0) {
        setExpandedSeasons(new Set([(data as SeriesDetails).seasons[0].id]))
      }
      if ((data as Details).error === 'IP_RATE_LIMITED') {
        toast.error('cinemm.com IP rate-limited. Try a VPN, switch network, or wait ~1 hour.', { duration: 8000 })
      } else if ((data as Details).error === 'QUOTA_EXCEEDED') {
        toast.warning('cinemm.com quota exceeded — showing partial data. JSON download still works.')
      } else if ((data as Details).error) {
        toast.warning(`Could not fetch full details: ${(data as Details).error}`)
      }
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : 'Failed to load details')
      toast.error('Failed to load details')
    } finally {
      setDetailsLoading(false)
    }
  }, [visitorUuid])

  const closeDetails = useCallback(() => {
    // Pop the URL state we pushed in openDetails so the browser back button
    // history stays consistent. If there's no pushed state (e.g. user landed
    // directly on a detail URL), just clear the local state.
    if (window.history.state && window.history.state.view === 'details') {
      window.history.back()
    } else {
      setSelected(null)
      setDetails(null)
      setDetailsError(null)
      setCopied(false)
      setEpisodeServers(new Map())
      setEpisodeServersLoading(new Set())
      setEpisodeServersError(new Set())
      setExpandedSeasons(new Set())
      setSelectedEpisode(null)
    }
  }, [])

  // Listen for browser back/forward — when the URL no longer has
  // view=details, clear the detail state so we return to the search page.
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      if (params.get('view') !== 'details') {
        setSelected(null)
        setDetails(null)
        setDetailsError(null)
        setCopied(false)
        setEpisodeServers(new Map())
        setEpisodeServersLoading(new Set())
        setEpisodeServersError(new Set())
        setExpandedSeasons(new Set())
        setSelectedEpisode(null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Toggle a season's expanded/collapsed state
  const toggleSeason = useCallback((seasonId: number) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev)
      if (next.has(seasonId)) next.delete(seasonId)
      else next.add(seasonId)
      return next
    })
  }, [])

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
        const uuidParam = visitorUuid ? `&uuid=${encodeURIComponent(visitorUuid)}` : ''
        const res = await fetch(`/api/episode-servers?episodeId=${episodeId}&source=${source}${uuidParam}`)
        const data: EpisodeServers = await res.json()
        if (!res.ok) throw new Error((data as { error?: string }).error || `Failed (${res.status})`)
        if (data.error === 'IP_RATE_LIMITED') {
          setEpisodeServersError((prev) => new Set(prev).add(episodeId))
          toast.error('cinemm.com IP rate-limited. Try a VPN, switch network, or wait ~1 hour.', { id: `ep-${episodeId}`, duration: 8000 })
        } else if (data.error === 'QUOTA_EXCEEDED') {
          setEpisodeServersError((prev) => new Set(prev).add(episodeId))
          toast.warning('cinemm.com quota exceeded — try again later', { id: `ep-${episodeId}` })
        } else {
          setEpisodeServers((prev) => new Map(prev).set(episodeId, data.servers))
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
    [episodeServers, episodeServersLoading, visitorUuid],
  )

  const handleDownloadJson = useCallback(() => {
    if (!selected) return
    const payload = buildJsonPayload(selected, details, episodeServers)
    const name = sanitizeFilename(selected.name || `id-${selected.id}`)
    const year = selected.year || 'unknown'
    downloadJson(`${name}_${year}_${selected.type}_${selected.id}.json`, payload)
    toast.success('JSON downloaded')
  }, [selected, details, episodeServers])

  const handleCopyJson = useCallback(async () => {
    if (!selected) return
    const payload = buildJsonPayload(selected, details, episodeServers)
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed')
    }
  }, [selected, details])

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
                <KeyRound className="w-3 h-3 mr-1" /> UUID active
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
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-semibold text-zinc-100">cinemm.com Visitor UUID</h3>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Paste your cinemm.com visitor UUID here to use it directly for all detail fetches.
                This bypasses the auto-refresh logic (and its IP rate-limiting side effects).
                Visit{' '}
                <a href="https://cinemm.com" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">
                  cinemm.com
                </a>{' '}
                → open browser DevTools (F12) → Application → Cookies → copy the value of{' '}
                <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-200">user_uuid</code>.
              </p>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="e.g. a9e6035a-33e9-4b72-bd66-0a3493533018"
                  value={uuidInput}
                  onChange={(e) => setUuidInput(e.target.value)}
                  className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-purple-500 font-mono text-sm"
                />
                <Button
                  size="sm"
                  onClick={saveVisitorUuid}
                  className="bg-purple-600 hover:bg-purple-700 text-white"
                >
                  Save
                </Button>
                {visitorUuid && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearVisitorUuid}
                    className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-zinc-100"
                  >
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-xs text-zinc-500">
                Status: {visitorUuid ? (
                  <span className="text-green-400">UUID active — direct mode (no auto-refresh)</span>
                ) : (
                  <span className="text-zinc-400">No UUID — auto-refresh mode (IP rate-limited)</span>
                )}
              </p>
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
                  autoFocus
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
            <div className="text-sm text-zinc-400 mb-4">
              {results.length} result{results.length === 1 ? '' : 's'} for <span className="text-zinc-200 font-medium">&ldquo;{query}&rdquo;</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2.5 sm:gap-3 md:gap-4">
              {results.map((item) => (
                <ResultCard key={`${item.type}-${item.id}`} item={item} onClick={() => openDetails(item)} />
              ))}
            </div>
          </>
        )}

        {!loading && !results && !error && (
          <div className="max-w-md mx-auto text-center py-20 text-zinc-500">
            <Film className="w-12 h-12 mx-auto mb-4 opacity-40" />
            <p className="text-lg font-medium text-zinc-300">Search cinemm.com</p>
            <p className="text-sm mt-2">
              Type a movie or series name above and hit Search. Click any result to see full post details and download as JSON.
            </p>
          </div>
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
            <h2 className="text-xl font-bold flex items-center gap-2 flex-wrap">
              {selected.name}
              {selected.year && <span className="text-zinc-500 text-base font-normal">({selected.year})</span>}
              <Badge variant="outline" className="ml-1 border-zinc-700 text-zinc-300 capitalize">
                {selected.type}
              </Badge>
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
              expandedSeasons={expandedSeasons}
              selectedEpisode={selectedEpisode}
              onToggleSeason={toggleSeason}
              onFetchEpisodeServers={fetchEpisodeServers}
              onSelectEpisode={setSelectedEpisode}
            />
          )}

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

function ResultCard({ item, onClick }: { item: SearchItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-md sm:rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900 hover:border-purple-600 focus:outline-none focus:ring-2 focus:ring-purple-600"
    >
      <div className="aspect-[2/3] bg-zinc-800 relative overflow-hidden">
        {item.poster ? (
          <img
            src={item.poster}
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
  expandedSeasons: Set<number>
  selectedEpisode: number | null
  onToggleSeason: (seasonId: number) => void
  onFetchEpisodeServers: (episodeId: number, source: string) => void
  onSelectEpisode: (episodeId: number | null) => void
}

function DetailsView({
  item,
  details,
  episodeServers,
  episodeServersLoading,
  episodeServersError,
  expandedSeasons,
  selectedEpisode,
  onToggleSeason,
  onFetchEpisodeServers,
  onSelectEpisode,
}: DetailsViewProps) {
  const hasServers = details.type === 'movie' && details.servers.length > 0
  const hasSeasons = details.type === 'series' && details.seasons.length > 0
  const hasOverview = !!details.overview
  const isQuotaExceeded = details.error === 'QUOTA_EXCEEDED'
  const hasPartialInfo = !hasServers && !hasSeasons && !hasOverview
  const isIpRateLimited = details.error === 'IP_RATE_LIMITED'

  return (
    <div className="space-y-5">
      {/* Header row: poster + meta */}
      <div className="flex gap-4">
        <div className="w-24 sm:w-32 shrink-0">
          <div className="aspect-[2/3] rounded-md overflow-hidden bg-zinc-800 border border-zinc-800">
            {item.poster ? (
              <img src={item.poster} alt={item.name} className="w-full h-full object-cover" />
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
          {details.error && details.error !== 'QUOTA_EXCEEDED' && details.error !== 'IP_RATE_LIMITED' && (
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

      {/* Seasons/episodes tree (series) */}
      {hasSeasons && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2 flex items-center gap-2">
            <Tv className="w-4 h-4" /> Seasons &amp; Episodes
            <Badge variant="outline" className="border-zinc-700 text-zinc-400 ml-1">
              {(details as SeriesDetails).seasons.reduce((acc, s) => acc + s.episodes.length, 0)} episodes
            </Badge>
          </h3>
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
                          isSelected={selectedEpisode === ep.id}
                          servers={episodeServers.get(ep.id)}
                          isLoading={episodeServersLoading.has(ep.id)}
                          hasError={episodeServersError.has(ep.id)}
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
      {hasPartialInfo && !isQuotaExceeded && !details.error && (
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
  isSelected: boolean
  servers?: Server[]
  isLoading: boolean
  hasError: boolean
  onClick: () => void
}

function EpisodeRow({ episode, isSelected, servers, isLoading, hasError, onClick }: EpisodeRowProps) {
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
              src={episode.poster}
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
        </div>
      )}
    </div>
  )
}
