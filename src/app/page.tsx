'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Search, Film, Tv, Download, Loader2, AlertTriangle, ExternalLink, Database, Copy, Check, X, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  episodeImageUrls: string[]
  remaining: number
  error?: string | null
  fetchedAt: string
  sourceUrl: string
}

type Details = MovieDetails | SeriesDetails

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

function buildJsonPayload(item: SearchItem, details: Details | null) {
  return {
    source: 'cinemm.com',
    fetchedAt: details?.fetchedAt ?? new Date().toISOString(),
    searchResult: {
      id: item.id,
      name: item.name,
      year: item.year,
      type: item.type,
      source: item.source,
      poster: item.poster,
      tmdbId: item.tmdbId ?? null,
      imdbId: item.imdbId ?? null,
    },
    details: details
      ? {
          overview: details.overview,
          ...(details.type === 'movie'
            ? { servers: details.servers, serverCount: details.servers.length }
            : { episodeImageUrls: details.episodeImageUrls, episodeImageCount: details.episodeImageUrls.length }),
          remaining: details.remaining,
          error: details.error,
          sourceUrl: details.sourceUrl,
        }
      : null,
  }
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
      setDetails(data as Details)
      if ((data as Details).error === 'QUOTA_EXCEEDED') {
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
  }, [])

  const closeDetails = useCallback(() => {
    setSelected(null)
    setDetails(null)
    setDetailsError(null)
    setCopied(false)
  }, [])

  const handleDownloadJson = useCallback(() => {
    if (!selected) return
    const payload = buildJsonPayload(selected, details)
    const name = sanitizeFilename(selected.name || `id-${selected.id}`)
    const year = selected.year || 'unknown'
    downloadJson(`${name}_${year}_${selected.type}_${selected.id}.json`, payload)
    toast.success('JSON downloaded')
  }, [selected, details])

  const handleCopyJson = useCallback(async () => {
    if (!selected) return
    const payload = buildJsonPayload(selected, details)
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
          <a
            href="https://cinemm.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            cinemm.com <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </header>

      {/* Search */}
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

      {/* Results */}
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
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Card key={i} className="bg-zinc-900 border-zinc-800 overflow-hidden p-0">
                <Skeleton className="aspect-[2/3] rounded-none bg-zinc-800" />
                <div className="p-3 space-y-2">
                  <Skeleton className="h-4 w-3/4 bg-zinc-800" />
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
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

      {/* Footer */}
      <footer className="border-t border-zinc-800 bg-zinc-900/50 mt-auto">
        <div className="container mx-auto px-4 py-4 text-xs text-zinc-500 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>Personal-use scraper for cinemm.com. Data cached locally in SQLite.</div>
          <div className="text-zinc-600">
            Respect the source site&apos;s terms and robots.txt when using this tool.
          </div>
        </div>
      </footer>

      {/* Details dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && closeDetails()}>
        <DialogContent className="max-w-4xl max-h-[90vh] bg-zinc-950 border-zinc-800 text-zinc-100 overflow-hidden flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-zinc-800 shrink-0">
            <DialogTitle className="text-xl flex items-center gap-2">
              {selected?.name}
              {selected?.year && <span className="text-zinc-500 text-base font-normal">({selected.year})</span>}
              <Badge variant="outline" className="ml-1 border-zinc-700 text-zinc-300 capitalize">
                {selected?.type}
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Full post data from cinemm.com. Download as JSON or copy to clipboard.
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 px-6 py-4">
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
              <DetailsView item={selected!} details={details} />
            )}
          </ScrollArea>

          {/* Footer actions */}
          <div className="px-6 py-4 border-t border-zinc-800 shrink-0 flex flex-wrap items-center justify-between gap-2 bg-zinc-900/30">
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
        </DialogContent>
      </Dialog>
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
      className="group text-left rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900 hover:border-purple-600 hover:ring-2 hover:ring-purple-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-purple-600"
    >
      <div className="aspect-[2/3] bg-zinc-800 relative overflow-hidden">
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-600">
            <Film className="w-8 h-8" />
          </div>
        )}
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-black/70 border-zinc-700 text-zinc-200 backdrop-blur-sm">
            {item.type === 'movie' ? <Film className="w-3 h-3 mr-1" /> : <Tv className="w-3 h-3 mr-1" />}
            {item.type}
          </Badge>
        </div>
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm leading-snug line-clamp-2 text-zinc-100">{item.name}</h3>
        {item.year && <p className="text-xs text-zinc-500 mt-1">{item.year}</p>}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Details view (shown inside dialog body)
// ---------------------------------------------------------------------------

function DetailsView({ item, details }: { item: SearchItem; details: Details }) {
  const hasServers = details.type === 'movie' && details.servers.length > 0
  const hasEpisodes = details.type === 'series' && details.episodeImageUrls.length > 0
  const hasOverview = !!details.overview
  const isQuotaExceeded = details.error === 'QUOTA_EXCEEDED'
  const hasPartialInfo = !hasServers && !hasEpisodes && !hasOverview

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
          </div>
          {isQuotaExceeded && (
            <div className="mt-2 p-2 rounded border border-amber-900/50 bg-amber-950/30 text-amber-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">cinemm.com quota exceeded</div>
                <div className="text-amber-300/80 mt-0.5">
                  The source site limits detail fetches per IP (typically a few per day). The basic info below is still
                  available, and you can download the partial JSON. Try again later or use a different network.
                </div>
              </div>
            </div>
          )}
          {details.error && details.error !== 'QUOTA_EXCEEDED' && (
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
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/60 hover:border-purple-600/50 transition-colors group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Download className="w-3.5 h-3.5 text-zinc-500 group-hover:text-purple-400 shrink-0" />
                  <span className="text-sm truncate">{s.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.size && <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs">{s.size}</Badge>}
                  <ExternalLink className="w-3 h-3 text-zinc-600 group-hover:text-purple-400" />
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Episode thumbnails (series) */}
      {hasEpisodes && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2 flex items-center gap-2">
            <ImageIcon className="w-4 h-4" /> Episode Images
            <Badge variant="outline" className="border-zinc-700 text-zinc-400 ml-1">
              {(details as SeriesDetails).episodeImageUrls.length}
            </Badge>
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-72 overflow-y-auto p-1">
            {(details as SeriesDetails).episodeImageUrls.slice(0, 30).map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Episode ${i + 1}`}
                loading="lazy"
                className="aspect-video w-full object-cover rounded border border-zinc-800 hover:border-purple-600/50"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ))}
          </div>
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
