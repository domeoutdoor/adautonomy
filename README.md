# AdAutonomy, standalone build

This folder is the whole product: one page and four small functions.

- `index.html` is the app. It runs from any static host. A review is read from whatever the user gives it: exported frames (PNG or JPG named with the delivery file name), the tracker workbook or CSV, the board's layer XML, or links to the Figma board, the Google Sheet (with a tab name), a Google Drive folder or an Airtable table. One intake box takes files and links alike, and several links at once.
- `netlify/functions/review.mjs` is the reviewer endpoint the page calls for visual checks, the conversation panel and workflow analysis. Without it, the page still runs data checks, builds the studio list and keeps campaigns, rules, workflows and reports in the browser.
- `netlify/functions/figma.mjs` reads a Figma board through Figma's REST API: frame names and sizes per page, then renders the chosen frames as PNG so the review sees what is on the board right now. It needs only view access.
- `netlify/functions/sheet.mjs` reads a Google Sheets tab or an Airtable table into order rows.
- `netlify/functions/drive.mjs` lists and fetches a Google Drive folder.
- `netlify/functions/lib/google.mjs` holds the shared helpers (access check, Google service-account token, CSV).
- `netlify.toml` tells Netlify where everything lives.

## Deploy on Netlify

1. Create a site from this folder (drag the folder onto app.netlify.com, or `netlify deploy --prod --dir .` with the Netlify CLI).
2. In the site settings, add environment variables (same value for all deploy contexts, then redeploy):
   - `REVIEWER_API_KEY`: your model provider key. Required for visual checks and the reviewer panel.
   - `REVIEWER_ACCESS_CODE`: a code your team enters once in the page. Recommended, so the endpoints are not open to anyone who finds the URL.
   - `REVIEWER_MODEL_QUICK`, `REVIEWER_MODEL_DEFAULT`, `REVIEWER_MODEL_COMPLEX`: optional model ids for the three depth settings.
   - `FIGMA_TOKEN`: optional. A Figma personal access token (scope: File content, read only) from an account that can view the boards. Without it, the page asks each user for their own token the first time they paste a Figma link and keeps it in their browser.
   - `GOOGLE_SA_EMAIL` and `GOOGLE_SA_KEY`: optional. A Google Cloud service account (Sheets API and Drive API enabled). Share private sheets and folders with that email as Viewer. Without it, only "Anyone with the link" sheets can be read and Drive folders cannot. `GOOGLE_API_KEY` is a lighter alternative that reaches link-shared items only.
   - `AIRTABLE_TOKEN`: optional. A personal access token with `data.records:read`. Without it, the page asks the user for one and keeps it in their browser.
3. Point your domain at the site (for example a subdomain of adautonomy.com).

## Shared data

In this build, campaigns, order rows, rules, workflows and saved reports live in each user's browser. To share them across a team, add a small store behind the same function pattern (one table each for campaigns, reviews, workflows and rules). The page's `Store` object has a single `save`/`remove`/`saveTracker`/`loadTracker` surface, so the swap is contained.

## Client data

Frames are sent to the reviewer endpoint only when someone clicks Run visual checks or sends a message in the reviewer panel. Data checks never leave the browser. Figma, Google and Airtable tokens are used only to fetch the item the user linked, and are never logged.
