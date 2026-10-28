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
server/  index.js (entry) · app.js (routes) · matcher.js · store.js (DB ops + reports)
         db.js (schema, seed) · taxonomy.js (all answer options) · validate.js · auth.js
public/  index.html + intake.js · followup · directory · staff · common.js · styles.css
data/    resources.seed.json
test/    matcher + API tests (node:test)
```
