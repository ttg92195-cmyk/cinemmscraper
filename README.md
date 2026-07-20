# cinemmscraper

A Next.js web app that lets users search movies/series on cinemm.com and
view stream URLs (4K / 1080p / 720p) submitted by other users.

## 🎯 What It Does

- **Search** movies and series by name
- **View** stream URLs for each movie/episode (multiple qualities + hosts)
- **Submit** new stream URLs (Bro submits via phone crawler, users see them)
- **Persistent** storage — URLs stay forever (no TTL)

Live at: https://cinemmscraper-production.up.railway.app

## 🏗️ Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   Bro's Phone       │         │  Railway Server      │
│   (Termux,          │         │  (Next.js + SQLite)  │
│    Myanmar IP)      │         │                      │
│                     │  POST   │                      │
│  crawl-from-phone   ├────────►│  /api/manual-link    │
│  batch-crawl        │  URLs   │  stores in SQLite    │
│                     │         │  (Railway Volume)    │
└────────┬────────────┘         └──────────┬───────────┘
         │                                 │
         │  1. POST cinemm.com/            │  3. GET /api/details
         │     Next-Action header          │     returns URLs
         │                                 │
         ▼                                 ▼
   ┌──────────────────┐         ┌──────────────────────┐
   │   cinemm.com     │         │   User's Browser     │
   │   (Myanmar IP    │         │                      │
   │    gets direct   │         │   Search + view      │
   │    stream URLs)  │         │   stream URLs        │
   └──────────────────┘         └──────────────────────┘
```

**Why a phone crawler?**

cinemm.com only returns real stream URLs when the request comes from a
Myanmar IP. Railway's server is in a foreign datacenter, so it always gets
`access:"telegram"` with no URLs. Bro's phone bridges that gap: the phone
fetches URLs from cinemm.com (Myanmar IP), the server stores them
permanently. Every future visitor sees the URLs without needing a
Myanmar IP.

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui |
| Backend | Next.js API Routes, Prisma ORM |
| Database | SQLite (Railway Volume for persistence) |
| Deployment | Railway (Docker) |
| cinemm.com integration | Direct Next.js Server Actions (HTTP POST, no browser) |
| Phone crawler | Node.js scripts on Termux (Android) |

## 📁 Project Structure

```
cinemmscraper/
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Main UI (search, details, stream URLs)
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── api/
│   │       ├── search/              # cinemm.com search proxy
│   │       ├── details/             # movie/series details + manual URLs merge
│   │       ├── episode-servers/     # series episode sources
│   │       ├── manual-link/         # submit/get/delete stream URLs
│   │       ├── resolve-shortlink/   # cinemm.com/p/... → real stream URL
│   │       ├── resolve-shortlinks-batch/
│   │       ├── scrape-movie/        # multi-strategy fallback scraper
│   │       ├── img/                 # image proxy (CORS bypass)
│   │       ├── cache/               # cache management
│   │       ├── tmdb-id/             # TMDB ID lookup
│   │       ├── proxy-config/        # proxy settings UI backing
│   │       └── route.ts             # API root
│   ├── lib/
│   │   ├── cinemm.ts                # cinemm.com client (Server Actions)
│   │   ├── db.ts                    # Prisma client + schema bootstrap
│   │   ├── cache.ts                 # response caching layer
│   │   ├── stream-url-sort.ts       # sort URLs by host preference
│   │   └── utils.ts                 # misc helpers
│   ├── components/ui/               # shadcn/ui components
│   └── hooks/
├── prisma/
│   └── schema.prisma                # DB schema (CinemmCache + ManualStreamUrl)
├── scripts/                         # Phone crawler scripts (see scripts/README.md)
├── public/
├── Dockerfile                       # Railway deployment
├── railway.toml
├── package.json
└── PROJECT_JOURNEY.md               # Detailed project history
```

## 🚀 Quick Start (Development)

```bash
# Install dependencies
bun install

# Set up database
bun run db:generate
bun run db:push

# Start dev server
bun run dev
```

Open http://localhost:3000

## 📱 Phone Crawler Setup (Bro Only)

The phone crawler discovers all movies/series on cinemm.com and submits
their stream URLs to the Railway server. See [`scripts/README.md`](scripts/README.md)
for full documentation.

```bash
# On Termux (Android)
pkg update && pkg install nodejs git termux-api -y
git clone https://github.com/ttg92195-cmyk/cinemmscraper.git
cd cinemmscraper

# Wake lock (prevents phone sleep)
termux-wake-lock

# Discovery + processing
node scripts/crawl-from-phone.mjs

# Or batch processing
node scripts/batch-crawl.mjs movie
node scripts/batch-crawl.mjs series
```

## 🗃️ Database Schema

```prisma
model CinemmCache {
  id        String   @id @default(cuid())
  cacheKey  String   @unique  // "search:avengers:movie" or "details:movie:4443"
  payload   String             // JSON-stringified result
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model ManualStreamUrl {
  id         String   @id @default(cuid())
  mediaId    String             // cinemm.com bigint ID (as string)
  mediaType  String             // 'movie' | 'series'
  episodeId  String?            // null for movie/series top-level
  shortlink  String             // cinemm.com/p/... URL
  streamUrl  String             // resolved real URL
  quality    String             // '4K' | '1080p' | '720p' | 'STD'
  format     String             // 'MKV' | 'MP4' | 'AVI' | ''
  host       String             // hostname
  fileName   String             // decoded file name
  fileSize   String             // human-readable size
  createdAt  DateTime @default(now())
  expiresAt  DateTime           // year 9999 = never expires

  @@index([mediaId, mediaType, episodeId])
}
```

## 🔌 API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/search?q=<query>&type=<movie\|series>` | Search cinemm.com |
| GET | `/api/details?id=<id>&type=<movie\|series>` | Movie/series details + stored URLs |
| GET | `/api/episode-servers?id=<seriesId>&episodeId=<episodeId>` | Episode sources |
| GET | `/api/manual-link?mediaId=<id>&mediaType=<type>[&episodeId=<id>]` | Get stored URLs |
| POST | `/api/manual-link` | Submit stream URLs |
| DELETE | `/api/manual-link?mediaId=<id>&mediaType=<type>[&shortlink=<url>]` | Delete stored URLs |
| GET | `/api/resolve-shortlink?url=<cinemm.com/p/...>` | Resolve shortlink to real URL |
| POST | `/api/resolve-shortlinks-batch` | Batch resolve shortlinks |
| GET | `/api/img?url=<image-url>` | Image proxy (CORS bypass) |
| GET | `/api/scrape-movie?id=<id>&type=<type>` | Multi-strategy scrape fallback |
| GET | `/api/tmdb-id?name=<name>&year=<year>&type=<type>` | TMDB ID lookup |
| GET | `/api/cache` | Cache stats |
| GET | `/api/proxy-config` | Proxy settings |

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | SQLite path (`file:/app/db/custom.db` on Railway) |
| `SCRAPER_API_KEY` | ❌ | ScraperAPI key for fallback rendering |
| `TELEGRAM_API_ID` | ❌ | (Legacy, unused) |
| `TELEGRAM_API_HASH` | ❌ | (Legacy, unused) |
| `TELEGRAM_SESSION` | ❌ | (Legacy, unused) |

## 📜 Project History

See [`PROJECT_JOURNEY.md`](PROJECT_JOURNEY.md) for the full project journey
including the 5-day cat-and-mouse game with cinemm.com's API changes.

## 📄 License

Private project.
