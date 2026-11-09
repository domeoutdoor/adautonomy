# AdAutonomy: handoff

Written 9 Nov 2026 for Darren. Everything below is the current state of the project, what works, what does not, and why.

## What it is

A branded creative-QC web app for ICP (icpnet.com), JoAnna Cosenza's agency; client is Audible. Each round, the studio builds frames in Figma, one per deliverable, named by the delivery file name. The PM (JoAnna) compares every frame against its row in the client tracker (a Google Sheet, many tabs, one per job) and against Audible's brand and per-platform rules, then writes a fixes list for the studio. AdAutonomy does that comparison and writes the list.

Live: https://adautonomy-qc.netlify.app (Netlify, deploys from this repo's `main`). Open it once from the link John sends (it carries the access code as `#k=`); the page stores the code in the browser.

Standing product rules from John:
- No reference to AI anywhere in the interface, and no Claude look or language. The build script fails on the words "AI" and "claude" in visible text.
- Nothing is ever asked of JoAnna: no tokens, no codes, no setup. The access code rides in the link; Figma access is one Allow click.
- She has view-only access to the Figma boards and will not get more.

## Repository layout

```
index.html                  built page (do not edit; built from src/)
src/adautonomy.html         the app: one file, all HTML/CSS/JS
tools/build.py              src -> index.html; strips a meta tag, syntax-checks every <script>, fails on forbidden words
tools/tests/                Playwright and stub-server tests (node; playwright is needed for *_e2e.js)
netlify.toml                publish ".", functions "netlify/functions", esbuild bundler
netlify/functions/
  review.mjs                POST /api/review: the model call for visual checks and the reviewer panel (REVIEWER_API_KEY)
  sheet.mjs                 POST /api/sheet: Google Sheets (every tab) and Airtable
  drive.mjs                 POST /api/drive: Google Drive folder listing
  figma.mjs                 /api/figma, /api/figma/auth, /callback, /disconnect: board reading and Figma sign-in
  lib/google.mjs            env(), json(), fail(), err(), checkAccess(), Google service-account token, CSV parser
docs/audible-qc-brief.md    the same rulebook as a Claude Project instruction set (see "How JoAnna works today")
docs/one-click-brief.txt    the brief packed into a claude.ai/new?q= link
README.md                   the original deploy notes (older; this file supersedes where they differ)
```

Build and test:
```
python3 tools/build.py
node --check netlify/functions/*.mjs netlify/functions/lib/*.mjs
node tools/tests/oauth_test.mjs      # Figma sign-in round trip against a stand-in Figma
node tools/tests/nest_test.mjs       # nested-frame walk against a stand-in board
node tools/tests/key_e2e.js          # access code in the link, no prompts (needs playwright)
node tools/tests/connect_e2e.js      # Connect Figma dialog and resume after return (needs playwright)
```
Push to `main` and Netlify publishes in about 30 seconds. Environment variable changes need a redeploy (Deploys, Trigger deploy).

## Environment variables (Netlify, Project configuration, Environment variables)

| Name | Purpose |
|---|---|
| `REVIEWER_API_KEY` | key for the model behind /api/review |
| `REVIEWER_MODEL_*` | optional model overrides (see review.mjs) |
| `REVIEWER_ACCESS_CODE` | the shared code; the page sends it as `x-access-code`. Value is in Netlify; it travels in the link John sends as `#k=<code>` |
| `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` | the Figma OAuth app (see Figma below) |
| `Figma_Token` | a personal access token fallback; ignored once the OAuth app is configured. Can be deleted |
| `GOOGLE_SA_EMAIL`, `GOOGLE_SA_KEY` or `GOOGLE_API_KEY` | not set. Only needed for private sheets; link-shared sheets work without them |
| `AIRTABLE_TOKEN` | not set; Airtable is optional |

`env()` in lib/google.mjs matches names regardless of case.

## How the page works

- One campaign per job (tracker tab). `S.campaigns`, `S.trackers[campaignId]` (rows), `S.round` (dropped or rendered frames, findings). Stored in localStorage on the standalone site (`Store`), with a Firestore-style path kept from the original artifact runtime.
- Intake is universal: drop files (PNG/JPG frames, CSV/XLSX tracker, Figma layer XML) or paste links (Figma board, Google Sheet, Drive folder, Airtable). Several links in one paste are fine; leftover words become the tab hint ("Mistletoe").
- `parseName()` reads the frame name: `Prefix_Platform_WxH[px]_MK_LL_extra_UAID`. UAID is `\d{5}-\d{6}`, always the last such token. `_Mockup`/`_m` frames are reference only.
- `tableToRows()` finds the header row by the cell `UAID`, maps columns by header text (`COLS`), keeps Creative Vendor = ICP rows.
- Tracker tabs: `mergeTabs()` merges every tab that has UAID rows; each row carries `row.tab`; a named tab (focus) goes first and wins on duplicate UAIDs. `camp.trackerFocus` limits "Not on this board" to this round's tab.
- `runDataChecks()` does the file-level checks (name, dims off-by-one, format, CTA text vs order, copy limits, talent, Detailed Requirements, status, duplicates, missing rows). Visual checks go through /api/review with the images. `DEFAULT_RULES` holds the brand, platform, spec and video rules and the output format; rules marked `observed` are inferred from past rounds and should be confirmed with the brand team.
- Output: Changes needed, Please check, Passed, Not on this board; Studio list is the paste-ready version.
- Beta panel at the bottom posts feedback to a Netlify Form that emails John.

## Figma: what works and the wall we hit

Reading a board through Figma's REST API works and is built:
- `/api/figma/auth` sends the person to Figma's "Allow AdAutonomy" page; `/callback` exchanges the code and stores the grant in an encrypted httpOnly cookie (`ada_fig`, AES-GCM keyed from the client secret, 180 days, refreshed when under 36 h left). `/disconnect` forgets it. The page shows a one-button "Connect your Figma" dialog on `figma_connect_required` and resumes the board after the return (`ada:pendingFigma`).
- `list` reads a page or the whole file. Deliverable frames are nested on these boards (round page, platform group such as Advertising, "Layout design", then the frames), so `collect()` walks down through containers without a UAID, up to five levels, fetching missing children in batches. Reads are kept to one call per linked page or one per four pages, because of the limit below.
- `render` asks Figma for PNGs of up to 25 frames per call; the page fetches them (direct, or via `/api/figma?img=` as a proxy) and feeds them into the same intake as dropped files.

The wall: Figma's published rate limits put GET file, GET file nodes and GET image in "Tier 1", and for View and Collab seats Tier 1 is about 20 requests per month (their page also says as few as 6). Full and Dev seats get 15 to 20 per minute. JoAnna has a View seat on ICP's plan, so board reading from a link is unusable for her account; our tests on 9 Nov used the month in twenty minutes (Retry-After was 4.6 days). Figma's doc: https://developers.figma.com/docs/rest-api/rate-limits. The page says this plainly when it happens and points to the export path.

The Figma OAuth app: registered on John's Figma account at figma.com/developers/apps, named AdAutonomy, scopes File content (read) and Current user (read), callback `https://adautonomy-qc.netlify.app/api/figma/callback`. It is a private app, which Figma only lets the owner's account authorize; a public app (anyone can authorize) requires Figma's review with a test URL. A first private app was created and abandoned because the callback was saved as the site root; harmless. Note from testing: Figma redirected the code to the site root once; the page does not yet forward `?code=&state=` from the root to the callback, which would make that case self-healing (small fix).

Paths forward for board links, if ICP wants them:
1. Anyone at ICP with a Full or Dev seat clicks Connect Figma; their grant could be stored server-side (Netlify Blobs) and used for everyone. Not built; about an hour. Preference order would be shared grant, then the browser's own grant.
2. ICP gives JoAnna a Dev seat; then her own connection has the 15/min limit.
3. Export frames from Figma (select, Export, PNG) and drop them in. Unlimited, works today, no comments.

Comments on the board are a separate REST endpoint (Tier 2, 5/min for View seats) and are not read yet.

## Google Sheets

`sheet.mjs` reads the whole workbook. With Google credentials it uses the Sheets API (`values:batchGet` for all tabs). Without them, a link-shared sheet is exported as one `.xlsx` (`export?format=xlsx`, cap 5.5 MB) and the page parses every tab with SheetJS, the same path as a dropped Excel file. JoAnna's tracker is link-shared, 15 tabs, 4.9 MB, 914 ICP rows across 9 tabs, about 5 seconds. Private sheets need a service account (set `GOOGLE_SA_EMAIL`/`GOOGLE_SA_KEY`, share the sheet with that address).

Real-data quirks already handled: dimensions written as `800x533px` and `1920 x 1200`; header rows on row 2 or 3; a `Billing` tab with no UAID header.

## How JoAnna works today (decided 9 Nov)

She runs the QC inside her own Claude, which looks at the Figma board on her screen (desktop control), reads the comments, and reads the tracker. The rulebook and output format live in `docs/audible-qc-brief.md`; `docs/one-click-brief.txt` is the same brief packed into a `https://claude.ai/new?q=...` link that opens a chat with the brief pre-filled. She was emailed that button on 9 Nov. Her Claude account is separate from John's Claude workspace, so publishing AdAutonomy as a Claude artifact that drives her Claude's browser is not possible from John's side (it would need her in his workspace, or her publishing it herself).

The standalone site remains useful for the tracker, the export path, and for ICP people without Claude.

## Accounts and access

- GitHub: `domeoutdoor/adautonomy` (public; can be made private in repo Settings). Netlify deploys from `main`. The Claude GitHub app is installed on the org for this repo.
- Netlify: site `adautonomy-qc` in John's team (john@soapyfilm.com). Forms, functions, env vars live there.
- Figma: OAuth app under John's account (see above).
- Feedback from the beta panel goes to John's email.

## Backlog, in the order I would do it

1. Forward `?code=&state=` from the page root to `/api/figma/callback` (robustness).
2. Shared Figma grant for Full/Dev seats (Netlify Blobs), if ICP provides a seat.
3. Read board comments (REST, Tier 2) and fold them into findings (ask-for-change -> Changes needed; approve/waive -> suppress).
4. Real login instead of the code in the link, before anyone at ICP beyond JoAnna uses it.
5. Custom domain (adautonomy.com is John's).
6. Walkthrough video and the media site (started, not finished; the 3 MB video was too large for the old deploy path, which is gone now).
7. Confirm the `observed` platform rules with the brand team and mark them `confirmed`.
