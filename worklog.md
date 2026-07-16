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

---
Task ID: telegram-bot-research
Agent: general-purpose
Task: Research how to integrate with @cinemmbot to fetch stream URLs

Work Log:
- Read `worklog.md` (248 lines, 5 prior task entries) for context. Key findings from previous agents:
    * cinemm.com's `getMovieSourcesAction` (ID `40fd46d9…`) returns `{ ok: true, access: "telegram", servers: [] }` — stream URLs have been moved OUT of the HTTP API entirely.
    * Deep links are constructed by `/api/scrape-movie/route.ts:47` as `https://t.me/cinemmbot?start=w_${type==='movie'?'m':'s'}_${id}` — but currently the app only SHOWS this link to the user; it never fetches from the bot itself.
    * Overview scraping is already solved (via `getMovieDetailsAction(id, true)` boolean-arg breakthrough, task `BREAKTHROUGH-boolean-arg`). What is NOT solved: getting the actual stream URLs that live inside the bot.
- Read `src/lib/cinemm.ts` (1,005 lines). Confirmed:
    * `ACTIONS` object (lines 31–37) holds 5 Server Action IDs. NOTE: `mintFreshUuid()` at line 324 references `ACTIONS.identifyUser` which is **not declared** in `ACTIONS` — this is a latent bug (would throw `undefined` if quota-exceeded path is ever triggered) but unrelated to this research task. Mentioning it here so the next agent can fix it.
    * `CinemmServer` interface (lines 68–72): `{ name, size, url }`.
    * `getMovieDetails()` (line 622) and `getSeriesDetails()` (line 714) both call `getMovieSourcesAction` / analogous series action but get back empty `servers:[]` because cinemm moved sources to Telegram.
    * `parseMovieDetailsResponse()` (line 478) is the right place to merge in Telegram-fetched servers if we add them later — it returns `CinemmMovieDetails` with `servers` already on it.
- Searched the project for any existing Telegram integration code: `grep -i 'telegram|MTProto|telethon|gramjs|madeline'` over the whole repo. Result:
    * NO existing MTProto / userbot code anywhere.
    * NO `telegram`, `telethon`, `gramjs`, `tdlib`, or `mtproto` packages in `package.json`.
    * Only Telegram-related code: `scrape-movie/route.ts` constructs deep links, `page.tsx` has a UI text-box where the user can paste their *own* bot URL (purely cosmetic deep-link generator). No actual bot interaction exists.
- Confirmed Dockerfile uses `node:20-slim` + bun; Railway `railway.toml` does NOT currently mount a persistent volume (only healthcheck config).

- Web research (4 z-ai `web_search` calls) confirmed the technical constraints of each option:

  **Option A — Telegram Bot API (`core.telegram.org/bots/api`):**
    * Verified from `core.telegram.org/bots/faq` (official): *"Bots will not be able to see messages from other bots regardless of mode."* Telegram enforces this specifically to prevent infinite bot→bot loops.
    * Bots can only receive messages addressed TO them by HUMAN users. They cannot initiate conversations with other bots, and they cannot read messages that other bots send.
    * **VERDICT: NOT VIABLE.** Hard Telegram-side restriction, no workaround. Adding our own bot would be useless — it cannot talk to @cinemmbot.

  **Option B — MTProto user client (act as a regular Telegram user):**
    * Libraries: **gramjs** (`npm i telegram`) for JS/TS — actively maintained, MIT licensed, full MTProto. Alternatives: Telethon (Python), MadelineProto (PHP), tdlib (C++ bindings).
    * Confirmed from `gram.js.org` and the gramjs GitHub README: `client.session.save()` returns a `StringSession` (just a base64 string) that can be stored in an env var. This is the *recommended* way to persist login across runs.
    * One-time setup requires: phone number + `API_ID` + `API_HASH` from `https://my.telegram.org/apps` + SMS verification code. After login, the StringSession can be reused forever (until the user actively revokes it).
    * Flow with @cinemmbot: connect client → `client.sendMessage('cinemmbot', { message: '/start w_m_6611' })` → `client.getMessages('cinemmbot', { limit: 1 })` to read the bot's reply → parse text + `replyMarkup` (inline buttons) for stream URLs.
    * Ban-risk research (Reddit / Telethon docs / gramjs issue #66):
        - "Telegram seems to be banning people using 3rd party API tools" (r/Telegram).
        - "Any third-party library is prone to cause the accounts to appear banned. Even official applications can make Telegram ban an account under certain circumstances." (docs.telethon.dev).
        - gramjs issue #66: "Telegram hates VoIP accounts. If your number is from a real sim then a simple email to the support would fix the issue."
        - Mitigations: (1) use a real-SIM burner number, NOT VoIP / SMS-receive services; (2) dedicated account, not the dev's personal account; (3) rate-limit strictly (≥3s between bot messages); (4) cache aggressively; (5) FloodWait-aware retry logic.
    * **VERDICT: VIABLE, this is the recommended option.**

  **Option C — Telegram Web (`web.telegram.org`) reverse engineering with Playwright:**
    * web.telegram.org uses MTProto over WebSocket inside a service worker. The DOM is fully virtualized (canvas-like rendering of messages), so simple CSS selectors will not find message text.
    * Requires manual QR-code scan (or 2FA password) on first login — cannot be automated in CI/Railway.
    * Sessions expire unpredictably; re-login requires another manual scan.
    * Cinemm already showed us how fragile SPA scraping is (worklog task `filter-rsc-junk`).
    * **VERDICT: NOT VIABLE.** Too fragile for production, requires manual intervention.

  **Option D — Telegram Desktop CLI wrappers (`tg`, `tdl`, `telegram-cli`):**
    * These are wrappers around MTProto (tdlib or custom) and have the SAME credential requirements as Option B (phone + API_ID + API_HASH + SMS).
    * They add a child_process spawn boundary, extra binary download, and more moving parts (CLI version drift, stdout parsing) for zero extra capability vs. gramjs direct.
    * Only benefit: language-agnostic — could let us call Telethon (Python) from Node. But we're already in Node, so gramjs is strictly better.
    * **VERDICT: NOT VIABLE / strictly worse than Option B** for our stack.

- Railway deployment analysis for Option B:
    * Confirmed from `docs.railway.com/volumes`: Railway supports persistent volumes. You attach one via Settings → Volumes → Add, give it a mount path (e.g. `/data`), and the contents survive redeploys.
    * **HOWEVER**, gramjs `StringSession` is a base64 string — it can be stored as a Railway env var (`TELEGRAM_SESSION`), which is even simpler than a volume and survives restarts automatically. No volume mount strictly required.
    * Caveat: Railway is "serverless-ish" — instances spin down during idle and can be replaced. A long-lived MTProto connection cannot be assumed. Our integration must be **request-scoped**: connect → fetch → disconnect on every API call. This adds ~2–4s of connect overhead per request, but is the only safe pattern for Railway. Mitigate with aggressive caching (already have `src/lib/cache.ts`, 24h TTL).
    * First-time login CANNOT happen on Railway (needs interactive SMS prompt). Workflow: run login script locally → it prints `StringSession` to stdout → paste that string into Railway env var `TELEGRAM_SESSION`. Documented in gramjs README.

Stage Summary:
- **RECOMMENDED OPTION: B (gramjs MTProto user client)** — it is the only technically viable option. Bot API is blocked by Telegram's bot-to-bot rule; Telegram Web is too fragile; CLI wrappers add no value over gramjs direct.

- **KEY TECHNICAL REQUIREMENTS:**
    1. **Credentials (all stored as Railway env vars):**
       - `TELEGRAM_API_ID` — numeric, from `https://my.telegram.org/apps`
       - `TELEGRAM_API_HASH` — 32-char hex string, from same
       - `TELEGRAM_SESSION` — base64 `StringSession` produced by one-time local login script
       - `TELEGRAM_BOT_USERNAME` — `cinemmbot` (so we can swap easily if cinemm renames the bot)
       - `TELEGRAM_PHONE` — only needed for re-login if session dies (optional)
    2. **npm packages to add:**
       - `telegram` (gramjs — the official package name on npm is `telegram`, not `gramjs`)
       - `input` (gramjs helper for interactive prompts during local-only login; can be skipped if we write the login script to read from stdin)
    3. **One-time setup steps (run LOCALLY, not on Railway):**
       a. Sign up a fresh Telegram account using a real-SIM burner number (NOT a VoIP / SMS-receive number — these get auto-banned per gramjs issue #66).
       b. Visit `https://my.telegram.org/apps` → create app → copy `api_id` + `api_hash`.
       c. Run `node scripts/telegram-login.mjs` (script to be written by next agent) — prompts for phone, then SMS code, then optional 2FA password, prints `StringSession`.
       d. Paste `StringSession` into Railway env var `TELEGRAM_SESSION`.
    4. **Code architecture (how it integrates with `/api/scrape-movie`):**
       - New file `src/lib/telegram-cinemm.ts` exposing `fetchStreamUrlsFromBot(deepLink: string): Promise<{ servers: CinemmServer[]; raw: string }>`:
           1. Parse `w_m_<id>` or `w_s_<id>` from the deep-link `start=` parameter (or accept `(type, id)` directly).
           2. Connect gramjs client using `StringSession(process.env.TELEGRAM_SESSION!)`.
           3. `await client.sendMessage('cinemmbot', { message: '/start ' + payload })`.
           4. Poll `client.getMessages('cinemmbot', { limit: 1 })` with a timeout (~10s, max 3 polls with 1s sleep — bots usually reply within 2–5s).
           5. Parse the bot's reply: extract URLs from message text (regex for `https?://`), and from `msg.replyMarkup.rows[].buttons[].url` for inline-keyboard buttons. Filter to known streaming hosts (or just collect all URLs and let the UI dedupe).
           6. `await client.disconnect()` (DO NOT leave connected — Railway reuses processes unpredictably and MTProto connections don't survive sleeps well).
           7. Return `{ servers, raw }`.
       - In `scrape-movie/route.ts`, after Step 1 (getDetails) returns `access: 'telegram'` with empty `servers`, add a new **Step 1.5**: try `fetchStreamUrlsFromBot()`. If it returns servers, populate `streamUrls` and return. If it throws (session expired, network, timeout), fall through to existing fallback (deep-link only).
       - Cache the bot's reply per-movie-id in `src/lib/cache.ts` with a long TTL (e.g. 7 days — stream URLs are stable per movie). This is critical to avoid hitting the bot on every page load.
       - Add a `/api/telegram-status` route that pings `client.getMe()` to surface session-alive state for debugging.
    5. **Pros of Option B:**
       - Actually works (only viable option).
       - gramjs is mature, full-featured, MIT licensed.
       - `StringSession` survives Railway restarts as an env var — no volume mount needed.
       - One-time setup; after that, fully automated.
       - Aggressive caching makes per-request cost negligible.
    6. **Cons / Risks of Option B:**
       - **BAN RISK (biggest)**: The burner account could be auto-banned by Telegram's anti-abuse heuristics. Mitigations: real-SIM number, dedicated account, ≥3s between bot messages, cache aggressively, monitor for `SESSION_REVOKED` / `USER_DEACTIVATED` errors and alert.
       - **Fragile to bot changes**: If cinemm changes the bot username, the message format, or adds a captcha, the parser breaks. Mitigation: log every bot reply (truncated) for forensic analysis; design parser to be lenient (extract any URL, not specific markup).
       - **Connect latency**: ~2–4s per cold call for MTProto handshake. Mitigation: cache hit-rate >95% in steady state.
       - **ToS gray area**: Telegram ToS technically forbids automating user accounts for "bot-like" behavior. They rarely enforce for low-volume use but the risk is nonzero. The dedicated-burner-account strategy contains the blast radius — if banned, only the burner is lost, not the main app.
       - **Session death**: If the user logs out of the burner account from another device, or Telegram revokes the session, the integration breaks silently. Mitigation: `/api/telegram-status` healthcheck + alert.
    7. **Will it work on Railway?** YES, with caveats:
       - Use env-var `StringSession` (not volume file) — simplest, survives redeploys.
       - Request-scoped connect/disconnect (do NOT hold a long-lived client in module scope — Railway may keep a process warm for hours then kill it without warning, leaving a half-open MTProto socket).
       - First-time login MUST happen locally; the login script cannot run on Railway (no interactive TTY for SMS code).
       - Add `maxDuration` bump on the scrape-movie route (currently 60s) — bot reply + parsing + caching fits comfortably but the gramjs connect can be slow on cold start.

- **RISKS AND MITIGATIONS summary (for the next agent who implements this):**
    | Risk | Likelihood | Mitigation |
    |------|-----------|------------|
    | Burner account auto-ban | Medium | Real-SIM number, dedicated account, rate-limit (≥3s/msg), cache aggressively |
    | @cinemmbot changes message format | Medium | Log all replies, lenient URL extraction, parser unit-tests with sample messages |
    | Session revoked / expired | Low | Healthcheck route, alert on `AuthKeyError` / `SESSION_REVOKED`, doc the re-login procedure |
    | Bot never replies / captcha | Low | 10s timeout → fall through to deep-link-only fallback (current behavior) |
    | Railway cold-start latency | Low | Cache hit-rate >95%, request-scoped client, optional: warm-up ping on app boot |
    | ToS enforcement | Low | Low volume, dedicated burner, don't spam —Telegram tolerates light userbot use |

- **ACTION ITEMS FOR NEXT AGENT (do NOT do here — research-only task):**
    1. Obtain a real-SIM burner phone number and create a fresh Telegram account.
    2. Register an app at `https://my.telegram.org/apps` → record `api_id` + `api_hash`.
    3. `npm i telegram input` (gramjs + interactive prompt helper).
    4. Write `scripts/telegram-login.mjs` that produces a `StringSession` string.
    5. Run the login script locally, capture the session string.
    6. Add 3 env vars to Railway: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`.
    7. Write `src/lib/telegram-cinemm.ts` with `fetchStreamUrlsFromBot(deepLink)` — request-scoped connect, ≥3s rate-limit, 10s reply timeout, lenient URL extraction from text + inline buttons.
    8. Wire it into `scrape-movie/route.ts` as new Step 1.5 (between getDetails and Playwright). Add `method: 'telegram-bot'` to the response shape.
    9. Add caching with 7-day TTL in `src/lib/cache.ts` for bot replies (key `tg:w_m_<id>` / `tg:w_s_<id>`).
    10. Add `/api/telegram-status` GET route returning `{ sessionAlive, me }` for monitoring.
    11. **Side-fix:** add `identifyUser: '<action-id>'` to the `ACTIONS` object in `cinemm.ts:31` (referenced at line 324 but missing — would crash the quota-refresh path). The action ID can be recovered from cinemm.com's bundled JS by grepping for `createServerReference("…", ..., "identifyUserAction")`.
    12. Capture one real bot reply (e.g. for Inception, `w_m_6611`) and save it as a fixture `src/lib/__fixtures__/cinemmbot-reply.txt` so the parser can be unit-tested without hitting Telegram.

---
Task ID: telegram-bot-integration
Agent: main (Super Z)
Task: Telegram bot (@cinemmbot) integration ထည့် — stream URLs ရယူ

Work Log:
- Research agent (telegram-bot-research) ကန gramjs (MTProto user client) ကို ထောက်ခံတယ်။
- npm install telegram input လုပ်တယ်။
- အသစ်တည်ဆောက်တဲ့ files:
  1. scripts/telegram-login.mjs — one-time login script
  2. src/lib/telegram-cinemm.ts — main library (fetchStreamUrlsFromBot, checkTelegramSession)
  3. src/app/api/telegram-status/route.ts — healthcheck endpoint
  4. src/app/api/scrape-movie/route.ts — Step 1.5 (Telegram bot) ထည့်ပြီး
  5. src/lib/cinemm.ts — mintFreshUuid() bug ပြင် (dead code, return null)

- Architecture:
  - getDetails() က overview ရပြီး servers ဗလာဖြစ်ရင် → Telegram bot ကို query လုပ်တယ်
  - 7-day cache (stream URLs change ရှားလို့)
  - 3-second rate limit (FloodWait ရှောင်ဖို့)
  - 15-second reply timeout
  - SESSION_REVOKED detection
  - FloodWait-aware retry

- gramjs patterns:
  - StringSession (env var ထဲမှာ သိမ်း) — Railway restart ကြာင့် မပျက်
  - Request-scoped connect/disconnect — long-lived sockets Railway မှာ break
  - getMessages() polling — bot reply ကို detect

Commit: e1c6594 "Add Telegram bot integration for stream URL extraction"
Push: 4cd308d..e1c6594 main -> main (pushed successfully)

Stage Summary:
- Code အားလုံး ready! ဒါပေမဲ့ အသုံးပြုဖို့ user (Bro) က နေ setup လုပ်ရမယ်:
  1. Burner Telegram account (real SIM, not VoIP)
  2. https://my.telegram.org/apps မှာ app register လုပ် → API_ID + API_HASH ရ
  3. Local မှာ: TELEGRAM_API_ID=xxx TELEGRAM_API_HASH=yyy node scripts/telegram-login.mjs
  4. Railway env vars ထည့်: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_BOT_USERNAME=cinemmbot
  5. Test: GET /api/telegram-status → { connected: true }

- ဒါပြီးရင် /api/scrape-movie က overview + poster + telegramStreamUrls အပြည့် ပြန်မယ်။

---
Task ID: telegram-login-setup
Agent: main (Super Z)
Task: Bro အတွက် Telegram login instructions ပြင်ဆင်

Work Log:
- Bro ဆီကနေ api_id (38615831) နဲ့ api_hash (5b575a81ca360c0bb0bd98585c6afb6c) ရရှိတယ်။
- Screenshot ကို VLM နဲ verify လုပ်တယ် — my.telegram.org/apps မှာ app ဖန်တီးပြီး page ဖြစ်တယ်။
- Bro ကို local environment မှာ login script run ဖို့ လမ်းညွှန်တယ်။
- scripts/login.mjs file ဖန်တီးတယ် — standalone version (Bro က သီးသန့် folder မှာ npm install telegram input လုပ်ပြီး run နိုင်ဖို့)။

Stage Summary:
- Bro က သူ့ local မှာ:
  1. mkdir cinemm-login && cd cinemm-login
  2. npm init -y && npm install telegram input
  3. login.mjs file သိမ်း
  4. TELEGRAM_API_ID=38615831 TELEGRAM_API_HASH=5b575a81ca360c0bb0bd98585c6afb6c node login.mjs
  5. Phone + SMS code + 2FA password ထည့်
  6. Session string ကူး
- ပြီးရင် Railway env vars ထည့်:
  - TELEGRAM_API_ID=38615831
  - TELEGRAM_API_HASH=5b575a81ca360c0bb0bd98585c6afb6c
  - TELEGRAM_SESSION=<the_long_string>
  - TELEGRAM_BOT_USERNAME=cinemmbot

---
Task ID: ui-feature-clarification
Agent: main (Super Z)
Task: Bro ပြောထားတဲ့ UI feature တွေ မှတ်တမ်းတင်

Work Log:
- Bro က cinemm.com post ထဲက "Show Sources" button နှိပ်ရင်:
  - Download Icon button နဲ့ Watch Icon button ဆိုပြီး ခလုတ်အသေးစား ၂ မျိုးပေါ်တယ်
  - Watch Icon နှိပ်ရင်: VLC Player app ကို တိုက်ရိုက် ခေါ်ယူပြီး, URL နဲ့ video တိုက်ရိုက် VLC app ထဲမှာ ဖွင့်ပေးတယ်
  - Download Icon နှိပ်ရင်: ပြင်ပ tab မသွားဘဲ, ချက်ချင်း download စတင်ပြီး အဲဒီနေရာမှာပဲ သိမ်းတယ်

- ဒီ feature တွေက ကျွန်တော်တို့ UI ထဲမှာ ထည့်ပေးလို့ရတယ်:
  1. "Watch in VLC" button — `vlc://` URL scheme ကို အသုံးပြုပြီး stream URL ကို VLC app ထဲ ပို့တယ်
  2. "Download" button — HTML5 `<a download>` attribute နဲ့ browser ထဲမှာပဲ download လုပ်စေတယ် (ပြင်ပ tab မလုပ်ဘူး)

Stage Summary:
- Bro ပြောထားတဲ့အတိုင်း VLC integration + download တိုက်ရိုက် feature တွေ နောက်ပြီး ထည့်ပေးနိုင်တယ်။
- အခု cinemm.com ပိတ်နေလို့ စောင့်နေရတယ်။ ပြန်ဖွင့်ရင် ဒီ feature တွေ ထည့်ပြီး test လုပ်မယ်။

---
Task ID: cinemm-strategy-update-2026-07-15
Agent: main (Super Z)
Task: Bro ရဲ့ နောက်ဆုံး စိတ်ကူးယူမှု + cinemm.com အသစ် အခြေအနေ မှတ်တမ်း

Work Log:
- cinemm.com က ၅ ရက်အတွင်း အကြီးအကျယ် redesign လုပ်ခဲ့တယ်:
  1. Action IDs အားလုံး regenerate
  2. Media IDs ကို bigint ပြောင်း (ဥပမာ 6611 → 1736115700307574)
  3. getMovieSourcesAction argument pattern ပြောင်း (source မပါတော့ဘူး)
  4. Movie collection တိုးတက် — 20000 နီးပါးထိ 估计 (Bro estimate)
  5. တခြား Myanmar subtitle channels က movies တွေကို သိမ်းယူထားတယ် (consolidation)

- Bro ရဲ့ စိတ်ကူးယူမှု (GOLDEN IDEA):
  "cinemm.com က Telegram bot update လုပ်တဲ့အခါ Bro (user) က bot ထဲမှာ
  တိုက်ရိုက် message ပို့ပြီး link ကို ယူပါ။ ပြီးရင် ကျွန်တော့် website ရဲ့
  post ထဲမှာ အဲဒီ link ကို ဖြည့်ပါ။ ဒါဆိုရင် Telegram bot ပိတ်သွားရင်တောင်
  link တွေ မပျောက်အောင် လုပ်နိုင်တယ်။"

- ဒီ idea က backup strategy ဖြစ်တယ်:
  - Primary: Telegram bot API (auto, server-side)
  - Backup: Bro က bot ထဲမှာ တိုက်ရိုက် link ယူ → website post ထဲ ဖြည့်
  - ဒါက bot ပိတ်သွားရင်တောင် historical data ရနိုင်တယ်

- ယခုလက်ရှိ အောင်မြင်တဲ့ အရာတွေ:
  - ✅ Search Action (bigint ID ပြန်)
  - ✅ getMovieDetailsAction (overview ရ)
  - ✅ Poster URL
  - ✅ Overview text အပြည့်
  - ✅ Movie collection တိုး (20000 နီးပါး — Bro estimate)

- စောင့်ကြည့်နေတဲ့ အရာ:
  - ⏳ Telegram bot update (bigint ID ခံမယ့်အချိန်)

Stage Summary:
- Bro က cinemm.com ကို ဆက်လက်စောင့်ကြည့်နေတယ်
- Telegram bot update ဖြစ်တဲ့အခါ Bro က အသိပေးမယ်
- အဲဒီအခါ ကျွန်တော်တို့ bot integration ပြန်test လုပ်မယ်
- Bro ရဲ့ backup idea (bot ထဲက link ယူပြီး website ထဲ ဖြည့်) ကိုလည်း
  consider လုပ်ထားမယ် — ဒါက bot reliability မရတဲ့အခါ အသုံးဝင်မယ်
- Bro ရဲ့ "ရွှေတွင်းတွေ့တာနဲ့တူပါဘဲ" ဆိုတဲ့ စကားက 5 ရက်တာ
  cat-and-mouse game အနိုင်ရတဲ့ ခံစားချက်ကို ဖော်ပြတယ်

---
Task ID: railway-volume-success
Agent: main (Super Z)
Task: Railway Volume setup verify အပြည့်အစုံ

Work Log:
- Bro က Railway dashboard မှ Volume setup လုပ်ပြီးပြီ:
  - Mount path: /app/db
  - Size: 1GB (free tier)
  - DATABASE_URL: file:/app/db/custom.db
- Volume အလုပ်လုပ်ကြောင်း verify လုပ်တယ်:
  1. Test URL submit (mediaId=volumetest123) → stored: 1 ✅
  2. Bro က Railway redeploy လုပ်တယ်
  3. ပြန်စစ်တာ → count: 1 ✅ (data မပျက်ဘူး!)
- Test entry ကို cleanup လုပ်တယ် (DELETE) → deleted: 1 ✅

Stage Summary:
- 5 ရက်တာ cat-and-mouse game အပြည့်အစုံ အနိုင်:
  1. cinemm.com API reverse engineering ✅
  2. Telegram bot integration ✅
  3. Shortlink resolver ✅
  4. Manual stream URL feature ✅
  5. Railway Volume persistence ✅
- အခု architecture အပြည့်အစုံ production-ready ဖြစ်ပါပြီ
- Bro က ဖုန်းနဲ့ပဲ အသုံးပြုနိုင်ပါပြီ:
  - Search movies/series
  - Add stream URLs (paste shortlinks)
  - View stored URLs (shared across users)
  - Copy/Open/Delete URLs
- Volume persistent ကြောင့် redeploy လုပ်လည်း data မပျက်ဘူး
- 7-day TTL auto-expire ဖြစ်တယ်

---
Task ID: FINAL-COMPLETE-VICTORY
Agent: main (Super Z)
Task: 5 ရက်တာ cat-and-mouse game အပြည့်အစုံ အနိုင်

Work Log:
- Bro စမ်းကြည့်ပြီး အောင်မြင်ကြောင်း အတည်ပြု:
  - Series post မှ Episode 1 ထဲ Add Stream URLs နှိပ်
  - shortlinks ၃ ခု paste လုပ်ပြီး Submit
  - ✅ Success: 3 URLs stored
  - ✅ Stream Links (Episode) section မှာ URLs ပေါ်
  - ✅ JSON file download လုပ်တဲ့အခါ episode-level downloadLinks + watchLinks မှာ **တကယ့် Stream URLs** ပါ

Stage Summary:
5 ရက်တာ ခရီးမှာ အောက်ပါ အဆင့်တွေ အပြည့်အစုံ အောင်မြင်:

DAY 1-2: cinemm.com Reverse Engineering
- ✅ Search HTML scrape → SPA shell fail
- ✅ Server Action ID 5 ခု reverse-engineer
- ✅ Boolean arg တွေ့ပြီး overview ရ
- ✅ Bigint ID system ပြောင်းလဲသွားတာ ပြန်ပြင်

DAY 3: Telegram Bot Integration
- ✅ gramjs MTProto user client login
- ✅ Bot click button + read edited message pattern
- ✅ Stream URLs auto-extract from KeyboardButtonCopy

DAY 4: Shortlink Resolver
- ✅ cinemm.com shortlink → real Stream URL (Cloudflare 302)
- ✅ Manual stream URL submission feature
- ✅ SQLite + Prisma + Railway Volume persistence

DAY 5: Episode-Level URLs + Final Polish
- ✅ Per-episode manual stream URLs (episodeId column)
- ✅ Series top-level button ဖယ်, episode-level button ထား
- ✅ episodeId filter (top-level vs episode)
- ✅ cinemm.com fail ဖြစ်ရင် manual URLs ဆက်ပြ
- ✅ JSON file ထဲမှာ Stream URL အစစ် (shortlink မဟုတ်ဘူး)

FINAL ARCHITECTURE:
- Frontend: Next.js + React + Tailwind (mobile responsive)
- Backend: Next.js API routes + Prisma + SQLite
- Storage: Railway Volume (persistent) + 7-day TTL cache
- cinemm.com: Direct Server Action HTTP POST (no browser rendering)
- Telegram bot: gramjs MTProto (auto fallback)
- Shortlink resolver: Cloudflare 302 redirect capture
- Manual URLs: User-submitted, stored, shared across users

FINAL FEATURES:
- Search movies/series → overview + poster
- Movie: Add Stream URLs → JSON download
- Series: Episode-level Add Stream URLs → JSON download
- Stream URL အစစ် (not shortlink) in JSON
- 7-day TTL, persistent, shared
- Mobile friendly (Bro ဖုန်းနဲ့ အပြည့်အစုံ သုံးနိုင်)

"ရွှေတွင်းတွေ့တာနဲ့တူပါဘဲ" — Bro ပြောတာအတိုင်း ဒီ ၅ ရက်တာ ခရီးက တကယ့် ရွှေတွင်းဖြစ်တယ်။
