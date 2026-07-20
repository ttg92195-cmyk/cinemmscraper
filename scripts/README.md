# cinemmscraper — Scripts

This folder contains all crawler scripts that run on Bro's phone (Termux).

## 📱 Phone Crawler Scripts

### `crawl-from-phone.mjs` — Discovery + Initial Crawl

Runs on Termux using the phone's Myanmar data IP. Discovers all movie/series
IDs on cinemm.com via alphabetical search, then processes each one to fetch
stream URLs and submit them to Railway.

```bash
# One-time setup on Termux
pkg update && pkg install nodejs git termux-api -y
git clone https://github.com/ttg92195-cmyk/cinemmscraper.git
cd cinemmscraper

# Run discovery + processing (full)
node scripts/crawl-from-phone.mjs

# Fast discovery only (~30s, finds ~1000 movies)
CRAWL_QUERY_MODE=single CRAWL_TYPES=movie,series node scripts/crawl-from-phone.mjs

# Full discovery (~25min, finds ~6500 movies)
CRAWL_QUERY_MODE=auto CRAWL_TYPES=movie,series node scripts/crawl-from-phone.mjs
```

### `batch-crawl.mjs` — Process N Items at a Time (Recommended)

After discovery is done, use this to process items in small batches. Already-
processed items are auto-skipped.

```bash
node scripts/batch-crawl.mjs movie       # next 20 movies
node scripts/batch-crawl.mjs series      # next 20 series
node scripts/batch-crawl.mjs movie 50    # next 50 movies
node scripts/batch-crawl.mjs series 1    # only 1 series (quick test)
```

Re-running continues from where you left off. If VPN IP gets blocked mid-batch:
- `Ctrl+C` to stop
- Switch VPN server (or wait 30 min for IP cooldown)
- Re-run same command — picks up where it stopped

### `export-list.mjs` — Export Discovered Items List with Names

Reads `crawl-progress.json` and generates a human-readable list of all
discovered movies/series with their names and season/episode counts.

```bash
node scripts/export-list.mjs             # both movies + series
node scripts/export-list.mjs series      # only series
node scripts/export-list.mjs movie       # only movies
node scripts/export-list.mjs series 50   # only first 50 series
```

Outputs:
- `series-list.txt` / `series-list.json`
- `movie-list.txt` / `movie-list.json`

Names are cached in `crawl-progress.json` so subsequent runs are faster.

### `rebuild-progress.mjs` — Recover Lost Progress from Railway DB

If `crawl-progress.json` is lost or corrupt, this script rebuilds it by
querying Railway DB directly (no calls to cinemm.com for sources).

```bash
node scripts/rebuild-progress.mjs              # both movies + series
node scripts/rebuild-progress.mjs movie        # only movies
node scripts/rebuild-progress.mjs series       # only series
```

This is MUCH faster than re-crawling because:
- No calls to cinemm.com's getMovieSources/getEpisodeSources
- Just queries our own Railway DB
- Marks IDs with stored URLs as 'processed'

## 🔧 Diagnostic Scripts

### `diagnose-ip.mjs` — IP + cinemm.com Diagnostic

Use this when crawl is failing to figure out why.

```bash
node scripts/diagnose-ip.mjs
```

Checks:
- Your public IP + country
- Whether cinemm.com is reachable
- Whether getMovieSourcesAction returns valid response
- Whether your IP gets `access:"direct"` (Myanmar) or `access:"telegram"` (foreign)

### `find-action-ids-v2.mjs` — Find Current cinemm.com Action IDs

cinemm.com periodically regenerates Server Action IDs (every few weeks).
When this happens, all API calls start returning HTTP 500/404. Run this
script to find the new IDs:

```bash
node scripts/find-action-ids-v2.mjs
```

Output: list of all 40+ hex strings found in cinemm.com's JS bundles,
with context so we can identify which ones are action IDs.

After finding new IDs, update them in:
- `src/lib/cinemm.ts` (production code)
- `scripts/batch-crawl.mjs`
- `scripts/crawl-from-phone.mjs`
- `scripts/rebuild-progress.mjs`
- `scripts/export-list.mjs`

## 📁 Files Generated (Local Only, NOT Committed)

- `crawl-progress.json` — main progress file (discovered + processed IDs)
- `crawl-progress.json.bak` — automatic backup (one save ago)
- `crawl-progress.json.tmp` — temporary file during atomic writes
- `crawl-progress.json.corrupt-*` — backup of corrupt file (if parse fails)
- `series-list.txt` / `series-list.json` — output of export-list.mjs
- `movie-list.txt` / `movie-list.json` — output of export-list.mjs

These are all in `.gitignore` — they never get committed to GitHub.

## 🌐 How the Data Flows

```
   Your phone (Termux, Myanmar IP)
            │
            │  1. POST https://cinemm.com/
            │     Next-Action: searchAction
            │     body: ["a", "movie"]
            │
            ↓
   cinemm.com (sees Myanmar IP → returns all results)
            │
            │  2. POST https://cinemm.com/
            │     Next-Action: getMovieSourcesAction
            │     body: ["<movie-id>"]
            │
            ↓
   cinemm.com returns: { access:"direct", servers:[{url:"https://...mp4", ...}] }
            │
            │  3. POST https://cinemmscraper-production.up.railway.app/api/manual-link
            │     body: { mediaId:"...", mediaType:"movie", shortlinks:["https://...mp4"] }
            │
            ↓
   Railway server stores URLs permanently in SQLite (Railway Volume)
            │
            ↓
   Every future visitor to cinemmscraper sees the URLs
```

## ⚙️ Environment Variables (All Optional)

| Variable | Default | Description |
|---|---|---|
| `RAILWAY_URL` | `https://cinemmscraper-production.up.railway.app` | Railway production URL |
| `CRAWL_DELAY_MS` | `800` (crawl-from-phone) / `2000` (batch-crawl) | Delay between cinemm.com requests |
| `CRAWL_PROGRESS` | `./crawl-progress.json` | Progress file path |
| `CRAWL_TYPES` | `movie,series` | Comma-separated; can be just `movie` |
| `CRAWL_QUERY_MODE` | `auto` | `single` (fast, ~1000 movies) / `double` (slow, ~20000) / `auto` |

## 🚨 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` / `ETIMEDOUT` | Phone lost data connection | Wait, then re-run |
| All movies return `access:"telegram"` | Phone IP is not Myanmar | Use Myanmar SIM data, disable Wi-Fi, disable any VPN |
| `429` / `FloodWait` errors | cinemm.com is rate-limiting | `CRAWL_DELAY_MS=2000 node scripts/batch-crawl.mjs movie` |
| All movies return HTTP 500/404 | cinemm.com changed Action IDs | `node scripts/find-action-ids-v2.mjs` and update code |
| Script crashes mid-way | Phone went to sleep | Re-run — progress is auto-saved |
| Progress file corrupt | Termux killed mid-write | `node scripts/rebuild-progress.mjs` to recover from Railway |
| Railway HTTP 502 | Cold start (free tier) | Wait 30s, retry — script auto-retries 3× |
