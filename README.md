# Bridge Out of Poverty

A web app that matches young people **ages 9–26** in the greater Portland area with services. Housing, rent assistance and utility assistance come first. Every search is saved, so the program can track what works and what gets in the way.

## What it does

**For youth** (`/`)
- A 7-step intake. Only age, area and consent are required:
  - age and area (Multnomah, Washington, Clackamas, Clark WA, Columbia, Yamhill)
  - race/ethnicity, sex, gender identity, LGBTQIA2S+ status
  - family situation (foster care, kicked out, parenting, pregnant…), income and income sources
  - housing, school, work
  - vulnerabilities (safety, violence, exploitation, disability, justice involvement, immigration, no ID or phone)
  - needs and preferences (youth-only, LGBTQIA2S+-affirming, culturally specific, walk-in, text, no police, confidential)
- Results grouped by need. Each result says **why it matched** and gives warnings, such as "not yet verified", "others reported a waitlist" or "may need an adult".
- 24/7 crisis lines show first when answers suggest the youth is in danger, for example sleeping outside, abuse or thoughts of self-harm.
- The youth gets a **check-in code** (`/followup`). They come back with it and report what happened with each program, plus any barriers. This page never shows their demographic answers.
- A Quick Exit button (or Shift+Esc) and a public directory (`/directory`).

**For staff** (`/staff`, password protected)
- **Dashboard**:
  - needs, unmet needs (gaps), barriers and outcomes
  - success rate and top barriers broken down by age, LGBTQIA2S+, race, housing, foster experience and county, so staff can see who is being served worse
  - per-program results and demographics
  - an option that hides counts under 5 for sharing
- **Youth & follow-ups**: find a youth by code, see their intake, update referral outcomes and barriers, see the history, and delete a youth's data on request.
- **Resources**: add or edit programs (eligibility ages, areas, populations served, cultural focus, languages, crisis line, active), then mark them **Verified**. Programs not verified in 180 days are flagged.
- **Exports**: a de-identified referrals CSV (no codes, contact info, notes or ZIP) and the resources directory as JSON.
- **Assisted intake**: staff can complete the intake with a youth (`/?staff=1`).

## How matching works (`server/matcher.js`)

1. **Eligibility filters**: age range, area served, and populations a program is limited to. For example, foster-youth programs only match youth in or leaving foster care. Most utility discounts require someone 18 or older.
2. **Scoring**:
   - Points for each extra need the program covers, for focus populations, for being culturally specific to the youth, for being LGBTQIA2S+-affirming, for matching preferences and language, and for recent verification.
   - **Points up or down based on past results.** A program's success rate from reported outcomes changes its score. If youth like this one keep hitting a barrier there (no ID, no phone, parental consent), it ranks lower.
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

## ⚠️ The starter directory must be verified

`data/resources.seed.json` has about 60 real Portland-area, Oregon and national programs. It loads only once, into an empty database. **Every entry starts as "not yet verified"** and youth are told to call ahead. Programs, ages, hours and funding change often, especially rent and energy assistance. Before launch, a staff member should check each program on the **Resources** tab and click **Verified**. Phone numbers were only included where well known; most entries link to the program's website.

## Privacy & safety notes

- No names are collected. Contact info is stored only if the youth chooses to give it.
- Data on minors is sensitive. Run the app over HTTPS, limit who has the staff password, back up and protect the database file, and set a retention policy. Before collecting real data, check consent and reporting rules with your agency, especially for youth under 18.
- Security headers include a strict Content-Security-Policy (no inline scripts). The app also requires JSON for write requests, uses SameSite/HttpOnly cookies, locks staff login after repeated failures, and uses parameterized SQL everywhere.

## Layout

```
server/  index.js (entry) · app.js (routes) · matcher.js · store.js (DB ops + reports)
         db.js (schema, seed) · taxonomy.js (all answer options) · validate.js · auth.js
public/  index.html + intake.js · followup · directory · staff · common.js · styles.css
data/    resources.seed.json
test/    matcher + API tests (node:test)
```
