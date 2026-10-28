# Bridge Out of Poverty

A web app that matches young people **ages 9–26** in the greater Portland area with services. Housing, rent assistance and utility assistance come first. Every search is saved, so the program can track what works and what gets in the way.

## What it does

**For youth** (`/`)
- **Minimum details are fine.** Only the consent box is required. There's a **Quick search** with 3 short steps, and every step has **Skip to the end**. With no age, no age filter is applied and each program's age range is shown. With no area, programs from every area are shown along with where each one works. With no needs, the main housing, rent and utility help is shown.
- **Private search option:** matching uses every answer, but only age, area, language and needs are saved. Contact info is turned off.
- The full intake (all optional) covers:
  - age and area (Multnomah, Washington, Clackamas, Clark WA, Columbia, Yamhill)
  - race/ethnicity, sex, gender identity, LGBTQIA2S+ status
  - family situation (foster care, kicked out, parenting, pregnant…), income and income sources
  - housing, school, work
  - vulnerabilities (safety, violence, exploitation, disability, justice involvement, immigration, no ID or phone)
  - needs and preferences (youth-only, LGBTQIA2S+-affirming, culturally specific, walk-in, text, no police, confidential)
- Results grouped by need. Each result says **why it matched** and gives warnings, such as "not yet verified", "others reported a waitlist" or "may need an adult".
- 24/7 crisis lines show first when answers suggest the youth is in danger, for example sleeping outside, abuse or thoughts of self-harm.
- The youth gets a **check-in code** (`/followup`). They come back with it and report what happened with each program, plus any barriers. This page never shows their demographic answers.
- **Refresh my matches:** with the code, a youth can search again against today's directory, optionally changing their needs. Programs they were already sent to keep their existing status and aren't duplicated.
- Badges on each program: **24/7**, **★ Partner**, **Confidential**, **Culturally specific**, **LGBTQIA2S+ affirming**. The directory has a **Focus** filter for DV, formerly incarcerated, culturally specific, confidential, LGBTQIA2S+ and crisis programs.
- A Quick Exit button (or Shift+Esc) and a public directory (`/directory`).

**For staff** (`/staff`, password protected)
- **Dashboard**:
  - needs, unmet needs (gaps), barriers and outcomes
  - success rate and top barriers broken down by age, LGBTQIA2S+, race, housing, foster experience and county, so staff can see who is being served worse
  - per-program results and demographics
  - an option that hides counts under 5 for sharing
- **Youth & follow-ups**: find a youth by code, see their intake, update referral outcomes and barriers, see the history, and delete a youth's data on request.
- **Validate connections**: staff confirm with the provider that a youth was actually connected (initials and a note). This marks the referral "Got help", is logged in the history, shows the youth "✓ Confirmed by staff", and counts double in future matching. It can be undone.
- **Resources**: add or edit programs (eligibility ages, areas, populations served, cultural focus, languages, crisis line, active), then mark them **Verified**. Programs not verified in 180 days are flagged.
  - **☆ Favor** marks a program as a **Partner**, which is ranked higher in matching.
  - **↻ Refresh from starter list** adds starter programs you don't have yet. New starter programs are also added automatically at startup. Tick "also update" to refresh entries nobody has edited or verified. **Staff-edited or verified programs are never overwritten.**
  - **Import JSON** adds programs from a file in the same format as the export, using the same merge rules.
  - **Check websites** tests every program link. Links that are dead are flagged for staff, and youth see "try calling" on those programs.
- **Exports**: a de-identified referrals CSV (no codes, contact info, notes or ZIP) and the resources directory as JSON.
- **Assisted intake**: staff can complete the intake with a youth (`/?staff=1`).

## How matching works (`server/matcher.js`)

1. **Eligibility filters**: age range, area served, and populations a program is limited to. For example, foster-youth programs only match youth in or leaving foster care. Most utility discounts require someone 18 or older.
2. **Scoring**:
   - Points for Partner programs, confidential programs (for survivors or when asked), each extra need the program covers, for focus populations, for being culturally specific to the youth, for being LGBTQIA2S+-affirming, for matching preferences and language, and for recent verification.
   - **Points up or down based on past results.** Staff-validated connections count double. A program's success rate from reported outcomes changes its score. If youth like this one keep hitting a barrier there (no ID, no phone, parental consent), it ranks lower.
3. **Gaps**: if only the general 211 line matches a need, that need is logged as unmet so staff can see where programs are missing.

## Run it

Requires Node.js 22.13 or newer. There are no npm dependencies; it uses the built-in `node:sqlite`.

```bash
STAFF_PASSWORD='choose-a-strong-password' npm start
# open http://localhost:3000   (staff: http://localhost:3000/staff)
npm test
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `STAFF_PASSWORD` | random, printed at startup | Staff sign-in |
| `SESSION_SECRET` | random per start | Signs staff session cookies. Set it so sign-ins survive restarts |
| `DB_FILE` | `data/bridge.db` | SQLite database file |
| `SECURE_COOKIES` | off | Set to `1` when served over HTTPS |

## iPhone app (Home Screen, works offline)

The same app runs **entirely on an iPhone**. All youth records are kept in a database on the phone and never sent anywhere. GitHub hosts the app files for free and publishes the public data every week.

**One-time setup (repository owner)**
1. Merge this branch into `main`.
2. On GitHub, go to **Settings → Pages**, then under **Build and deployment** choose **Source: GitHub Actions**.
3. The **Phone app** workflow builds and publishes the app on every push to `main`, every Monday, and on demand (**Actions → Phone app → Run workflow**). The address is `https://<your-user>.github.io/Bridge-out-poverty-escape/`.

**On the iPhone**
1. Open that address in **Safari**, tap **Share → Add to Home Screen**, then open **Bridge** from the Home Screen.
2. Tap **Staff** and choose a passcode the first time (4+ characters). It locks the staff side and can't be recovered.
3. Use it exactly like the computer version: assisted intake, results, check-ins, validation, dashboard, Discover leads, programs.
4. **This phone** (bottom of the staff page): **Get latest directory & leads**, **Back up** (saves a `.sqlite` file to Files/iCloud Drive), and **Restore from backup**.

Notes
- Works offline after the first open. Updates download automatically once a day when online.
- **Back up regularly.** Deleting the app deletes its data. iPhone can also clear data for websites that aren't added to the Home Screen.
- Discovery and website checks run in the weekly GitHub job, because phones can't download other sites' data. To watch more public pages, list them in `data/discovery-pages.json` as `[{"name": "...", "url": "https://...", "needs": ["housing"], "network": true}]`.
- How it works: `scripts/build-mobile.js` bundles the server's own modules with `mobile/shims.js`, which stands in for Node features, and [sql.js](https://sql.js.org) (SQLite in WebAssembly). The pages call `window.LOCAL_API` (`mobile/shell.js`) instead of the network. Build locally with `npm run build:mobile`; the result is in `site/`.

## Live lookup (Multnomah County + Portland daily-access area)

When a live directory is connected, **every search pulls current listings** for the youth's needs. Only listings within a reasonable daily trip of Portland are kept: within **25 miles of downtown** by coordinates, or in a nearby city when a listing has no coordinates. That covers Portland, Gresham, Troutdale, Beaverton, Hillsboro, Forest Grove, Tigard, Lake Oswego, Milwaukie, Oregon City, Happy Valley, Wilsonville, Vancouver, Camas and similar cities.

- **Saved into the directory:** live listings are stored like any other program (badge "Live · source", distance from downtown), so referrals, outcomes, barriers, verification and ☆ Favor all work on them. Staff-verified or edited listings are never overwritten.
- **Who sees them:** youth in Multnomah, Washington, Clackamas or Clark County, or who skip the area question. Each need gets the top matches plus up to 2 of the best live listings.
- **Fast and safe:** results are cached for 12 hours per need. If a directory is slow (over 4 seconds) or down, the search uses saved listings and the problem shows on the staff Resources tab.
- **Full sync** runs at startup and every 12 hours, or on demand with **Sync live listings now**. Listings missing for 30 days are retired.

Connect a source with environment variables:

| Variable | Purpose |
|---|---|
| `HSDS_API_URL` | Base URL of any **Open Referral (HSDS)** API, the open standard for service directories (e.g. `https://example.org/api`). Calls `/services?search=…` |
| `HSDS_API_KEY`, `HSDS_LABEL` | Optional key (sent as `x-api-key` and Bearer) and the name shown to youth |
| `NDP_SEARCH_URL`, `NDP_API_KEY` | **211 National Data Platform** keyword search endpoint and subscription key, from apiportal.211.org |
| `NDP_LOCATION` | Location sent to 211 (default `Portland, OR`) |
| `ACCESS_RADIUS_MILES` | Daily-access radius (default 25) |
| `LIVE_SYNC_HOURS` | Full sync interval (default 12) |

**Getting data access:** 211info holds the most complete Portland-area database. It doesn't publish an open API; it shares data through partners (Connect Oregon / Unite Us) and the 211 National Data Platform. Contact 211info's resource team, or sign up at the 211 API portal. The 211 adapter follows the portal's keyword-search pattern but **has not been tested against the real API**; check field names once you have a key (the parser is in `server/live.js`). The Open Referral adapter follows the published HSDS standard.

## Discovery from public records (staff → **Discover** tab)

Finds organizations serving the Portland daily-access area from public information and queues them as **leads** for staff review. Each lead shows its evidence with links to the original record.

| Source | What it finds |
|---|---|
| **Federal grants & subawards** ([USAspending.gov API](https://api.usaspending.gov), no key) | Organizations in Multnomah, Washington, Clackamas and Clark counties receiving federal funds for youth homelessness (Transitional Living, Basic Center, Street Outreach), WIOA Youth, YouthBuild, Chafee, HUD Continuum of Care, Emergency Solutions, Emergency Food & Shelter, LIHEAP, CSBG, VOCA/VAWA/FVPSA (DV), Second Chance (reentry) and family programs. Includes **subawards**, which is how state and county money reaches local providers. |
| **IRS nonprofit registry** (Exempt Organizations list for OR and WA) | Established nonprofits in access-area cities whose activity code covers housing, shelter, youth development, food, jobs, mental health, DV, legal and reentry help. Revenue must be at least $25k. |
| **County listings & community networks** | Any public page staff add, such as a county resource page or a coalition member list. Starts with the OCADSV member programs page and the Multnomah County shelter page. Organizations linked from the page become leads, and staff are told when the page changes. |

- **Ranking:** youth-specific federal programs and network membership count most. Agreement across independent sources adds a bonus, and government agencies rank lower.
- **Known organizations:** organizations already in the directory are linked under "Already in directory" instead of being suggested again. Their public records appear at `/api/staff/resources/:id/records`.
- **Review & add** opens the program form pre-filled (name, website, address, needs, county), so staff can confirm ages, area and cost before youth see it. **Dismiss** keeps a note on why.
- Runs a minute after startup and then weekly (`DISCOVERY_DAYS`, or `DISCOVERY=off` to disable). Any source can be run on demand or turned off.
- **Program websites are watched too:** **Check websites** now notices when a program's page text changes, and flags it **Website changed — re-verify**.

Leads aren't shown to youth automatically. Funding and registry records say who provides services, not who a young person can walk in to today.

**Network access:** the server needs outbound HTTPS to `api.usaspending.gov`, `www.irs.gov`, and any pages you add (e.g. `www.multco.us`, `ocadsv.org`).

## ⚠️ The starter directory must be verified

`data/resources.seed.json` has about 80 real Portland-area, Oregon and national programs. It loads only once, into an empty database. **Every entry starts as "not yet verified"** and youth are told to call ahead. Programs, ages, hours and funding change often, especially rent and energy assistance. Before launch, a staff member should check each program on the **Resources** tab and click **Verified**. Phone numbers were only included where well known; most entries link to the program's website.

The starter list includes:
- **Domestic, dating and sexual violence:** National DV Hotline, love is respect, StrongHearts Native Helpline, RAINN, Call to Safety, Bradley Angle, Raphael House, DVRC, Clackamas Women's Services, Henderson House, YWCA Clark County.
- **Formerly incarcerated / justice-involved:** Central City Concern, Bridges to Change, Constructing Hope, OYA transition services, MPD record clearing, Multnomah DCJ, Portland YouthBuilders, Youth Villages LifeSet.
- **Culturally specific:** NAYA, NARA, SEI, Urban League, POIC, Black Parent Initiative, Latino Network, El Programa Hispano, Centro Cultural, Bienestar, Adelante Mujeres, APANO, IRCO.
- **Confidential:** marked on DV and exploitation programs, crisis lines, student health centers and Planned Parenthood.

## Privacy & safety notes

- No names are collected. Contact info is stored only if the youth chooses to give it.
- Data on minors is sensitive. Run the app over HTTPS, limit who has the staff password, back up and protect the database file, and set a retention policy. Before collecting real data, check consent and reporting rules with your agency, especially for youth under 18.
- Security headers include a strict Content-Security-Policy (no inline scripts). The app also requires JSON for write requests, uses SameSite/HttpOnly cookies, locks staff login after repeated failures, and uses parameterized SQL everywhere.

## Layout

```
server/  index.js (entry) · app.js (routes) · matcher.js · store.js (DB ops + reports) · live.js (live lookup) · discovery.js (public records)
         db.js (schema, seed) · taxonomy.js (all answer options) · validate.js · auth.js
public/  index.html + intake.js · followup · directory · staff · common.js · styles.css
data/    resources.seed.json
test/    matcher + API tests (node:test)
```
