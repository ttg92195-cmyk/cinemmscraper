# cinemmscraper — Scripts

## `crawl-from-phone.mjs` — Auto-crawl cinemm.com from your phone

Runs on **Termux** (Android terminal emulator) using the phone's Myanmar data IP.
Discovers all movies + series on cinemm.com, fetches their stream URLs, and
submits them to the Railway server so every user sees them permanently.

### Why this exists

cinemm.com only shows the "Show Sources" button (and returns real stream URLs)
when the request comes from a Myanmar IP. The Railway server is in a foreign
datacenter, so it always gets `access:"telegram"` with no URLs.

This script bridges that gap: **your phone fetches the URLs, the server stores them.**

After running it once, every visitor to cinemmscraper sees stream links for every
crawled movie — no proxy, no Telegram bot, no Myanmar IP required on the server.

### One-time setup (on Termux)

```bash
pkg update && pkg upgrade -y
pkg install nodejs git -y          # Node 18+ has built-in fetch
git clone https://github.com/ttg92195-cmyk/cinemmscraper
cd cinemmscraper
```

> **No `npm install` needed.** The script uses only Node.js built-ins (`fs`, `fetch`).
> The Railway server does all the database work.

### Run

```bash
node scripts/crawl-from-phone.mjs
```

That's it. The script will:

1. **Discovery phase** — search cinemm.com alphabetically (`a`, `b`, ..., `9`)
   to collect all movie + series IDs. Takes ~30 seconds at default 800ms delay.
2. **Process phase** — for each ID, call `getMovieSourcesAction` (or
   `getEpisodeSourcesAction` for series episodes). If `access:"direct"`,
   submit the stream URLs to `${RAILWAY_URL}/api/manual-link`.
3. **Resume** — saves progress to `./crawl-progress.json` every 10 items.
   If you stop the script (Ctrl+C, phone sleeps, network drops), just re-run
   it — it skips already-processed IDs.

### Tuning

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILAY_URL` | `https://cinemmscraper-production.up.railway.app` | Where to submit URLs |
| `CRAWL_DELAY_MS` | `800` | Delay between cinemm.com requests (be polite) |
| `CRAWL_PROGRESS` | `./crawl-progress.json` | Progress file path |
| `CRAWL_TYPES` | `movie,series` | Comma-separated; can be just `movie` |
| `CRAWL_QUERY_MODE` | `auto` | `single` (36 queries) / `double` (1296 queries) / `auto` |

**`CRAWL_QUERY_MODE`:**
- `single` — search single chars `a`-`z`, `0`-`9`. Fast (~30s) but only finds ~1000 movies.
- `double` — search all 2-char combos `aa`-`99`. Slow (~20min) but finds ~20000 movies.
- `auto` (default) — single first, then double-char only for letters that returned 30 results.

For the full 20000-movie crawl, use `auto` (default) or `double`:

```bash
CRAWL_QUERY_MODE=double node scripts/crawl-from-phone.mjs
```

### Expected runtime

- Discovery: 20–25 minutes (1296 queries × 800ms)
- Movie processing: 20000 movies × ~1.5s each ≈ 8 hours
- Series processing: varies (depends on episode count)

You can run it overnight. The phone screen can be off (Termux keeps running).
Use `termux-wake-lock` to prevent Android from killing Termux:

```bash
pkg install termux-api -y
termux-wake-lock
# ... run the crawler ...
termux-wake-unlock   # when done
```

### Verifying it works

While the script runs, check the Railway server:

```bash
# See how many URLs are stored
curl -s 'https://cinemmscraper-production.up.railway.app/api/manual-link?mediaId=0&mediaType=movie'
```

Or open the Web UI and search for any popular movie — it should now show
stream links without you having to submit them manually.

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED` / `ETIMEDOUT` | Phone lost data connection | Wait, then re-run |
| All movies return `access:"telegram"` | Phone IP is not Myanmar | Use Myanmar SIM data, disable Wi-Fi, disable any VPN |
| `429` / `FloodWait` errors | cinemm.com is rate-limiting | `CRAWL_DELAY_MS=2000 node scripts/crawl-from-phone.mjs` |
| Script crashes mid-way | Phone went to sleep | Re-run — progress is saved |
| `Railway HTTP 500` | Server error (DB issue) | Check Railway logs; usually transient |

### How the data flows

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
   Railway server stores URLs permanently in SQLite
            │
            ↓
   Every future visitor to cinemmscraper sees the URLs
```

### Files written

- `./crawl-progress.json` — progress file (discovered IDs + processed IDs + counts)
  - Safe to delete to start over, but you'll redo all the discovery work
- `./crawl-progress.json.bak` — backup (created on each save, optional)

### Other scripts in this folder

- `telegram-login.mjs` — one-time setup to log into Telegram as @cinemmbot
  (only needed if you want to use the Telegram bot auto-fetch feature)
