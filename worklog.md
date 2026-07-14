---
Task ID: poster-investigation
Agent: general-purpose
Task: Investigate cinemm.com poster URL format

Work Log:
- Read existing scraper at `src/app/api/scrape-movie/route.ts` and the main cinemm client at `src/lib/cinemm.ts`. Confirmed the app talks to cinemm.com via Next.js Server Actions (POST to `/` with `Next-Action: <id>` header), NOT by parsing the search-page HTML.
- Mapped the poster data flow: `searchCinemm()` (cinemm.ts:418) calls the search action, parses RSC line `1:` JSON, spreads `it.poster` into each `CinemmSearchItem`. That poster is then passed via query-string `poster=...` through `/api/details` → `getMovieDetails`/`getSeriesDetails` → returned as `ctx.poster ?? ''`. The movie-details Server Action itself returns NO poster field (verified).
- Located two parallel poster-aware code paths: `src/lib/cinemm.ts` (server, used by `/api/search` & `/api/details`) and `src/lib/cinemm-browser.ts` (client-side mirror used by `src/app/page.tsx`). UI renders posters at `page.tsx` lines 1675, 1787, 2063 (`item.poster ? <img src={item.poster}> : <Film icon>`).
- Fetched `https://cinemm.com/?search=Inception&type=movie` as plain HTML. Result: 19 KB SPA shell, zero `<img>` tags, zero `image.tmdb.org`/`cdn.*`/poster URLs. The 7 `self.__next_f.push(...)` chunks contain only RSC layout/metadata — NO search results and NO poster URLs. Confirmed the search page is fully client-rendered; the initial HTML cannot be scraped for posters.
- Reproduced the actual Server Action call that the app makes. POSTed to `https://cinemm.com/` with header `Next-Action: 608f37e00992dd40df0badde8f2f45e5db62a48046` and body `["Inception","movie"]`. Got back valid RSC with the poster URL on line `1:`:
    `1:{"ok":true,"results":[{"id":6611,"name":"Inception","year":"2010","poster":"https://cinemm.com/img/file/bioscope-all-asset-uploads/cm-app/movies/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg","type":"movie","overview":"$undefined"}]}`
- Ran 4 more search probes ("Breaking Bad"/series, "Avatar"/movie, "the"/movie, nonsense query). Every non-empty result item included a populated `poster` string. Empty queries return `{"ok":true,"results":[]}`. Confirmed the per-item fields are exactly: `id, name, year, poster, type, overview` (no tmdbId/imdbId/source in the search payload — those are derived elsewhere).
- Confirmed the movie-details action (`60663b32ebac1369c06f990ebeed80f0ec3101d061`, body `[6611,"CM"]`) returns ONLY `{"ok":true,"overview":"$undefined","sourceAvailability":"available","webSourcesAllowed":false}` — no `poster` key. So details endpoints cannot self-source the poster; it must travel through from the search result via query params (which is exactly what the current code does).
- Verified all 3 observed poster URL variants return HTTP 200 / `image/jpeg` with real bytes (16 KB – 95 KB), so the URLs are hot-linkable as-is — no referer/auth needed.
- Inspected `src/lib/cache.ts`: cache is in-memory `Map`, 24h TTL, per-serverless-instance. A stale entry cached before cinemm.com added the `poster` field would persist up to 24h or until the instance restarts.

Stage Summary:
- EXACT POSTER URL PATTERN: `https://cinemm.com/img/file/bioscope-all-asset-uploads/<bucket>/<category>[/<YYYY-MM-DD>/]<filename>.jpg`
  - Old movies:    `…/cm-app/movies/<file>.jpg`                              (e.g. Inception → oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg)
  - Newer movies:  `…/cm-app-media-two/movies/<YYYY-MM-DD>/<file>.jpg`        (e.g. Avatar 2026 → 2026-04-17/gPiyTLo5GGwtJl0L8TlaJF9r0KE.jpg)
  - Newer series:  `…/cm-app-media-two/tv-shows/<YYYY-MM-DD>/<file>.jpg`      (e.g. Breaking Bad → 2026-01-15/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg)
  - Common prefix for all variants: `https://cinemm.com/img/file/bioscope-all-asset-uploads/`
- WHERE THE POSTER APPEARS: NOT in the initial `?search=` HTML (SPA shell only). It is in the Server Action RSC response, line `1:`, JSON path `results[].poster` (a plain string field, no `$`-reference, no text chunk). Confirmed across 5 search queries — every populated result item carries a non-empty `poster` URL.
- RECOMMENDED EXTRACTION METHOD: NO change to extraction strategy needed — the existing JSON-path approach in `src/lib/cinemm.ts` (`searchCinemm`, line ~440) already reads `it.poster` correctly from the parsed RSC line `1:` JSON. Do NOT add an HTML/CSS-selector or regex path; the search page has no `<img>` tags to select. The poster URL is a first-class JSON field, not embedded markup.
- ROOT-CAUSE HYPOTHESIS FOR `poster: ""`: cinemm.com's live search API returns valid poster URLs right now, so an empty poster in the app output is almost certainly NOT a cinemm.com format change. Two likely culprits for the dev to verify next:
    1. STALE CACHE — `src/lib/cache.ts` holds search results for 24h in-memory. If a search was cached during a window when cinemm.com returned empty/missing posters (or before the `poster` field existed), that cache will keep serving `poster: undefined` until expiry or instance restart. Quick test: hit `/api/search?q=Inception&type=movie&cache=false` and check whether `poster` is populated. If yes → flush the cache.
    2. MISSING `$undefined` GUARD — `searchCinemm`'s mapper sanitizes `tmdbId`, `imdbId`, and `overview` against the literal `"$undefined"` sentinel but does NOT do the same for `poster`. If cinemm.com ever returns `poster:"$undefined"` for an item, the app would leak the literal string `"$undefined"` (not `""`, but still broken in the UI). Defensive fix: add `poster: it.poster === '$undefined' ? '' : (it.poster ?? '')` to the mapper at cinemm.ts ~line 440. (Note: I did NOT observe this case in any of my live probes, but it's a cheap safety net consistent with the existing pattern.)
- SECONDARY FINDING: `src/app/api/scrape-movie/route.ts` (Strategy 2, ScraperAPI fallback, line ~127) tries to extract a poster from rendered HTML with `$('img[src*="image.tmdb.org"], img[src*="cinemm"], img[src*="poster"]')`. Because the search page is a pure SPA with no `<img>` tags in the server-rendered HTML, this selector will essentially never match — it only fires as a last-resort fallback for the overview path and is not the source of truth for posters. No change required, but the dev should know this fallback is effectively dead code for posters.
- ACTION ITEMS FOR NEXT AGENT (do NOT do here — research-only task): (a) add `?cache=false` probe to confirm/deny stale-cache hypothesis, (b) add the `poster: it.poster === '$undefined' ? '' : ...` guard to `searchCinemm` in `cinemm.ts` and the matching mapper in `cinemm-browser.ts`, (c) optionally add a cache-flush helper to `/api/cache` so users can force-refresh without restarting the instance.

---
Task ID: fix-scrape-movie-fallthrough
Agent: main (Super Z)
Task: Fix /api/scrape-movie — Playwright fail ဖြစ်ရင် ScraperAPI fallback ကို ဆက်ခေါ်ပေး + poster ပြဿနာ ဖြေရှင်း

Work Log:
- ဖတ်ခဲ့တဲ့ file တွေ: src/app/api/scrape-movie/route.ts (original 188 lines), src/lib/cinemm.ts, src/lib/cinemm-browser.ts, Dockerfile, next.config.ts, package.json, railway.toml
- တွေ့ရတဲ့ အဓိက bug #1: Playwright fail ဖြစ်ရင် catch block က `return NextResponse.json({...})` လုပ်လိုက်တယ်။ ဒါကြောင့် Strategy 2 (ScraperAPI) နဲ့ Strategy 3 (fallback) က unreachable code ဖြစ်နေတယ်။
- တွေ့ရတဲ့ အဓိက bug #2: `import('playwright')` က ကိုယ်တိုင်က error ပေးတယ် (Railway standalone build မှာ browsers.json မပါလို့)။ ဒါကို catch လုပ်ထားပေမဲ့ fall-through မရဘူး။
- တွေ့ရတဲ့ ပြဿနာ #3: poster field ကို `$undefined` guard မလုပ်ထားဘူး။ cinemm.com က `poster:"$undefined"` ပြန်ရင် literal string အတိုင်း leak ဖြစ်တယ်။
- တွေ့ရတဲ့ ပြဿနာ #4: `/api/scrape-movie` ကို `poster` param မပါဘဲ ခေါ်ရင် (ဥပမာ user က တိုက်ရိုက် test လုပ်တဲ့အခါ) poster empty ပြန်တယ်။

Changes made:
1. **src/app/api/scrape-movie/route.ts** (full rewrite):
   - ပြင်ထားတဲ့ Strategy 0: poster param မပါရင် `searchCinemm()` ကို ခေါ်ပြီး cinemm.com ကနေ poster URL ရှာပေးတယ်။
   - Strategy 1 (Playwright): catch block ကနေ return မလုပ်ဘဲ fall-through လုပ်တယ်။
   - Strategy 2 (ScraperAPI): ရောက်လာတယ်။ poster URL ကိုလည်း HTML ထဲက search လုပ်တယ်။
   - Strategy 3 (Fallback): နောက်ဆုံး fallback အဖြစ် Telegram link ပဲ return လုပ်တယ်။
   - `attempts` array ထည့်ပေးခဲ့တယ် — response ထဲမှာ ဘယ် strategy တွေ စမ်းကြည့်ပြီး ဘာ error တက်ကြောင်း မြင်ရတယ်။
   - `extractOverviewFromText()` နဲ့ `extractOverviewFromHtml()` helper functions တွေကို သီးခြား ထုတ်ထားတယ်။

2. **src/lib/cinemm.ts** (line 445): `poster: it.poster === '$undefined' ? '' : (it.poster ?? '')` guard ထည့်လိုက်တယ်။
3. **src/lib/cinemm-browser.ts** (line 261): အထက်ပါ အတိုင်းပဲ guard ထည့်လိုက်တယ်။

Commit: 07112fb "Fix scrape-movie: fall through to ScraperAPI when Playwright fails"

Stage Summary:
- Critical fall-through bug ပြင်ပြီးပြီ။ အခု Playwright fail ဖြစ်ရင် ScraperAPI ကို ဆက်ခေါ်ပြီး အဲဒါလည်း fail ဖြစ်ရင် fallback ကို ဆက်သွားတယ်။
- Poster URL ကိုလည်း auto-resolve လုပ်ပေးတယ်။ user က poster param မပါဘဲ test လုပ်ရင်တောင် ပြန်ရတယ်။
- GitHub push မလုပ်နိုင်ဘူး — credentials မရနိုင်လို့။ User က local ကနေပဲ push လုပ်ရမယ်။
- Railway ပေါ်မှာ deploy ဖြစ်ပြီးရင် ပြန်စမ်းကြည့်ရမယ်။

---
Task ID: add-getDetails-strategy
Agent: main (Super Z)
Task: /api/scrape-movie route မှာ getDetails() ကို primary strategy အဖြစ် ထည့်ပေး + circular dependency ဖြေရှင်း + ScraperAPI timeout တိုး

Work Log:
- ဖတ်ခဲ့တဲ့ file တွေ: src/lib/cinemm.ts (getMovieDetails, getSeriesDetails, getDetails, callAction, parseMovieDetailsResponse, CinemmServer interface, CinemmMovieDetails/SeriesDetails interfaces)
- တွေ့ရတဲ့ circular dependency: getMovieDetails() (line 666-684) က overview မရရင် /api/scrape-movie ကို fetch လုပ်တယ်။ ဒါပေမဲ့ /api/scrape-movie route ကလည်း getDetails() ကို ခေါ်ရင် infinite loop ဖြစ်မယ်။
- တွေ့ရတဲ့ ပြဿနာ: ScraperAPI က 20s timeout ထားတယ်။ cinemm.com SPA render လုပ်ဖို့ အချိန်ကြာတယ် → timeout ဖြစ်တယ်။

Changes made:
1. **src/lib/cinemm.ts** (line 664-684 removed):
   - getMovieDetails() ထဲက /api/scrape-movie fetch block ကို ဖြုတ်လိုက်တယ်။ comment နဲ့ အကြောင်းပြချက် ထည့်ထားတယ်။
   - အခု getMovieDetails() က overview ဗလာဖြစ်ရင် အဲဒါအတိုင်း return လုပ်တယ်။ UI က /api/scrape-movie ကို သီးခြား ခေါ်ရမယ်။

2. **src/app/api/scrape-movie/route.ts** (rewritten):
   - Strategy chain အသစ်:
     0. poster-resolve (search action)
     1. getDetails() — cinemm.com Server Action direct HTTP call (NEW - primary)
     2. Playwright (local dev only)
     3. ScraperAPI (render=true, timeout 45s)
     4. fallback
   - getDetails() က overview သို့မဟုတ် servers ရရင် အောင်မြင်တယ်။
   - maxDuration ကို 25 ကနေ 60 တိုးတယ် (retries + ScraperAPI အတွက်)။
   - ScraperAPI timeout ကို 20s ကနေ 45s တိုးတယ်။
   - visitorUuid query param ကို getDetails() ဆီ ပို့ပေးတယ် (quota bypass အတွက်)။
   - Response ထဲမှာ servers, streamUrls, remaining ပါပေးတယ်။

Commit: db317dd "Add getDetails as primary strategy in scrape-movie route"
Push: e1375d7..db317dd main -> main (pushed successfully, token removed after)

Stage Summary:
- အခု /api/scrape-movie က Railway ပေါ်မှာ getDetails() strategy ကို အရင်ခေါ်မယ်။ ဒါက cinemm.com Server Action ကို plain HTTP POST နဲ့ ခေါ်တာဖြစ်လို့ Railway ပေါ်မှာ အလုပ်လုပ်မယ်။
- Overview က RSC line "2:" မှာ ပါတယ် (new format)။ parseMovieDetailsResponse က အဲဒါကို extract လုပ်ပေးတယ်။
- ပြီးရင် Railway ပေါ် ပြန် deploy ဖြစ်တဲ့အခါ ဒီ URL နဲ့ စမ်းကြည့်ရမယ်:
  https://cinemmscraper-production.up.railway.app/api/scrape-movie?id=6611&type=movie&source=CM&name=Inception&year=2010
- မျှော်လင့်ရတဲ့ response: method="getDetails", overview မှာ Myanmar text ပါမယ်, attempts ထဲမှာ getDetails ok=true ပါမယ်။

---
Task ID: filter-rsc-junk
Agent: main (Super Z)
Task: ScraperAPI ကနေ ရတဲ့ overview ထဲက RSC junk တွေကို စစ်ထုတ်

Work Log:
- ပြဿနာ: ScraperAPI က cinemm.com SPA shell ကို render လုပ်ပေးတယ်။ ဒါပေမဲ့ HTML ထဲမှာ `self.__next_f.push([1,"a:{...}"])` RSC chunks တွေပဲ ပါတယ်။ `extractOverviewFromHtml()` က အဲဒါကို overview အဖြစ် ပြန်ပေးတယ်။
- အသစ်ထည့်တဲ့ `isRscJunk()` function:
  - `self.__next_f.push` နဲ့ စဖို့ စစ်တယ်
  - RSC wire format `0:["$","div",...]` စစ်တယ်
  - RSC T chunk `2:T<hex>,...` စစ်တယ်
  - short `$` reference စစ်တယ်
  - JSON char ratio > 15% ဖြစ်ပြီး Myanmar char မပါရင် junk အဖြစ် သတ်မှတ်တယ်

- `extractOverviewFromHtml()` ကို ပြင်လိုက်တယ်:
  1. **Strategy A**: `self.__next_f.push([1,"..."])` chunks တွေကို regex နဲ့ ဖမ်းတယ်
  2. JSON.parse() နဲ့ unescape လုပ်တယ်
  3. အထဲမှာ `\d+:T[0-9a-f]+,(<text>)` pattern နဲ့ T-prefixed text chunks တွေကို ရှာတယ်
  4. Myanmar char ပါရင် candidate အဖြစ် ထည့်တယ်
  5. plain Myanmar text block တွေကိုလည်း ရှာတယ်
  6. **Strategy B**: cheerio နဲ့ body text တွေကို စစ်တယ် (isRscJunk filter သုံးပြီး)
  7. candidates တွေကို filter လုပ်ပြီး longest ကို return လုပ်တယ်

- ScraperAPI success condition ပြင်လိုက်တယ်:
  - အရင်: HTTP ok ရရင် ok=true
  - အခု: overview ရရင် + isRscJunk မဟုတ်ရင်ပဲ ok=true
  - RSC junk ပဲရရင် fallback ကို fall-through လုပ်တယ်

Commit: 7dbfeac "Filter RSC junk from ScraperAPI overview extraction"
Push: db317dd..7dbfeac main -> main (pushed successfully)

Stage Summary:
- အခု overview ထဲမှာ RSC junk မပါတော့ဘူး။
- ဒါပေမဲ့ **cinemm.com က ယခု post တွေ ပိတ်ထားလို့** search results 0 ပဲ ရတယ်။ getDetails ကလည်း empty ပြန်တယ်။ ScraperAPI ကလည်း SPA shell ပဲရတယ် (RSC junk စစ်ထုတ်ပြီး empty ဖြစ်သွားတယ်)။
- ဒါကြောင့် အခု response မှာ method="fallback" ပဲ ဖြစ်မယ်။ overview ဗလာပဲ ဖြစ်မယ်။ poster-resolve ကလည်း 0 results ကြောင့် fail ဖြစ်မယ်။
- **cinemm.com ပြန်ဖွင့်ပြီးရင်** အရာအားလုံး အလုပ်လုပ်မယ်။

---
Task ID: action-id-update
Agent: main (Super Z)
Task: cinemm.com ပြန်ဖွင့်ပြီးတဲ့နောက် ဘာတွေ ပြောင်းလဲထားလဲ စစ်ဆေး + code ပြင်ဆင်

Work Log:
- cinemm.com ပြန်ဖွင့်ပြီးတဲ့အတွက် direct HTTP probes တွေ စမ်းကြည့်တယ်:
  1. Search page HTML fetch — SPA shell ပဲ ရတယ် (19KB)
  2. searchAction (608f37e0...) POST — အလုပ်လုပ်တယ်! Inception ရလဒ်ပါပြန်တယ် (poster URL ပါ)
  3. getMovieDetailsAction (60663b32...) POST — overview="$undefined" ပြန်တယ် (သူတို့ တမင် ဖယ်ထားတယ်)
  4. getMovieSourcesAction (40fd46d9...) POST — {"ok":true,"access":"telegram","servers":[]}
  5. getSeriesDetailsAction (40011a39...) POST — overview="$undefined" ပြန်တယ်
  6. getEpisodeSourcesAction (60bebae0...) POST — error digest ပြန်တယ် (movie ID ပေးလို့)
  7. /api/movie/6611, /api/search?q=Inception — 404 ပြန်တယ်

- JS bundle ထဲက createServerReference calls တွေကို ခွဲခြမ်းစစ်ဆေးတယ်:
  - 40fd46d989efde0198496371446e1d00b777f8021f → getMovieSourcesAction (NEW! အသစ်)
  - 60bebae00379fff9c39e9dccf659b024a89da4b5b4 → getEpisodeSourcesAction
  - 608f37e00992dd40df0badde8f2f45e5db62a48046 → searchAction
  - 60663b32ebac1369c06f990ebeed80f0ec3101d061 → getMovieDetailsAction
  - 40011a39f4c37fb76852c6cc01a17bd20e98784283 → getSeriesDetailsAction

- တွေ့ရတဲ့ အဓိက bug: ကျွန်တော်တို့ code ထဲမှာ getMovieSources အတွက် getEpisodeSourcesAction ID ကို မှားသုံးနေတယ်။

Changes made:
1. **src/lib/cinemm.ts** — ACTIONS object ပြင်လိုက်တယ်:
   - အသစ် `getMovieSources: '40fd46d989efde0198496371446e1d00b777f8021f'` ထည့်တယ်
   - အားလုံး function name နဲ့ မှတ်သားထားတယ်
   - `getMovieDetails()` function ထဲက `ACTIONS.getEpisodeServers` ကို `ACTIONS.getMovieSources` လို့ ပြင်လိုက်တယ်
   - source response ထဲက `access` field ကိုလည်း ဖတ်တယ်

Commit: 9bd0496 "Update Server Action IDs: add getMovieSourcesAction"
Push: 7dbfeac..9bd0496 main -> main (pushed successfully)

Stage Summary:
- Action ID မှားယွင်းမှု ပြင်ပြီးပြီ။ အခု getMovieSourcesAction ကို မှန်မှန်ကန်ကန် ခေါ်တယ်။
- ဒါပေမဲ့ servers တွေ ဗလာပဲ (access="telegram") — cinemm.com က servers တွေကို Telegram bot ထဲမှာ ထားတယ်။
- Overview ပြဿနာ ဆက်ရှိနေတယ် — getMovieDetailsAction က overview="$undefined" ပြန်တယ်။
- Overview ကို browser rendering မှသာ ရနိုင်တယ်။ Railway မှာ Playwright မရလို့ အခက်အခဲရှိတယ်။
- နောက်ဆုံး strategy: browserless service (premium proxy, residential IPs) စဉ်းစားရမယ်။

---
Task ID: BREAKTHROUGH-boolean-arg
Agent: main (Super Z)
Task: cinemm.com client-side rendering ကို reverse-engineer လုပ်ပြီး overview ရယူ

Work Log:
- JS bundle ၇ ခုလုံး download လုပ်ပြီး action ID တွေကို extract လုပ်တယ်။ Action ID ၅ ခုပဲ ရှိတယ် (အရင် သိထားပြီးသား)။
- ဒါပေမဲ့ **client code ထဲမှာ overview fetch လုပ်ပုံ** ကို တွေ့ရတယ်:
  ```js
  let s = "movie" === e.type && !(null == (t = e.overview) ? void 0 : t.trim());
  // s = true if movie type AND overview is empty
  let t = await k(e.id, s);  // k = getMovieDetailsAction
  // response ထဲက overview ကို state ထဲ ထည့်တယ်
  t.overview && B({...e, overview: t.overview})
  ```
- ဒါက `getMovieDetailsAction(id, fetchOverview: boolean)` ပုံစံ ဖြစ်ကြောင်း ညွှန်ပြနေတယ်!
- Test လုပ်ကြည့်တယ်:
  - `[6611, true]` → overview text **ရတယ်!** (Myanmar text ပါပြန်တယ်!)
  - `[6611, false]` → overview="$undefined"
  - `[6611, "CM"]` → overview="$undefined" (ကျွန်တော်တို့ အရင်က ဒါပဲ ပေးနေတယ်!)
  - `[6611]` → overview ရတယ် (default true လားဆိုတာ မသေချာဘူး၊ ဒါပေမဲ့ ရတယ်)
- ဒီ pattern က series အတွက်လည်း အတူတူပါ:
  - `[1398, true]` → overview ရတယ်!

Changes made:
1. **src/lib/cinemm.ts** `getMovieDetails()`:
   - `callAction(ACTIONS.getMovieServers, [id, source])` → `[id, true]`
   - Comment ထဲမှာ အသစ်ရှာတွေ့တဲ့ pattern ကို မှတ်သားထားတယ်

2. **src/lib/cinemm.ts** `getSeriesDetails()`:
   - `callAction(ACTIONS.getSeriesDetails, [id, source])` → `[id, true]`

Commit: 11d8daf "BREAKTHROUGH: getMovieDetailsAction takes boolean arg, not source string"
Push: 9bd0496..11d8daf main -> main (pushed successfully)

Stage Summary:
- **အဓိက အောင်မြင်မှု:** cinemm.com က overview ကို Server Action ကနေ တမင် မဖယ်ထားဘူး။ ဒါက argument မှားယွင်းတဲ့အတွက်ကြောင့်သာ fail ဖြစ်တာ။
- **Browser rendering မလိုတော့ဘူး!** ScraperAPI, Playwright တွေ မလိုတော့ဘူး။
- **Direct HTTP call နဲ့ပဲ overview ရတယ်!** Railway ပေါ်မှာလည်း အလုပ်လုပ်မယ်။
- နောက်ဆုံး စမ်းသပ်ဖို့: Railway deploy ပြီးရင်
  https://cinemmscraper-production.up.railway.app/api/scrape-movie?id=6611&type=movie&source=CM&name=Inception&year=2010
  response မှာ `method: "getDetails"` နဲ့ `overview` မှာ Myanmar text ပါမယ်။

---
Task ID: FINAL-VICTORY
Agent: main (Super Z)
Task: အပြည့်အစုံ အနိုင် confirm

Work Log:
- Railway deploy ပြီးနောက် test URL ကို ပြန်စမ်းကြည့်တယ်။
- Response:
  - method: "getDetails" ✅
  - overview: 2,800+ chars Myanmar text (Inception ဇာတ်လမ်းအကျဉ်း အပြည့်အစုံ) ✅
  - poster: cinemm.com URL ✅
  - telegramLink: t.me link ✅
  - error: null ✅
  - attempts: ၂ ခုလုံး ok=true (poster-resolve + getDetails)

Stage Summary:
- Cat-and-mouse game 4 အဆင့် အောင်မြင်ခဲ့တယ်:
  1. Search HTML scrape → SPA shell ပြဿနာ
  2. Server Action ID တွေ ရှာ → အသစ်တွေ တွေ့
  3. Action ID ပြန်ပြင် → overview="$undefined"
  4. **JS bundle ထဲက client code ကို reverse-engineer** → boolean arg တွေ့
- အဓိက key: getMovieDetailsAction(id, fetchOverview:boolean)
- Browser rendering (Playwright/ScraperAPI) တွေ လုံးဝ မလိုတော့ဘူး။
- Direct HTTP POST နဲ့ပဲ overview ရတယ်။
- ဒါက ရေရှည် တည်ငြိမ်တဲ့ solution ဖြစ်တယ်။
