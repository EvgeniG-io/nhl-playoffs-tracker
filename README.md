# NHL Playoff Tracker

Chrome extension (**Manifest V3**) with a popup that tracks **teams in playoff position** across the NHL and shows each club’s **next scheduled game** or **most recent finished game**, using only the league’s public **`api-web.nhle.com`** JSON APIs (no HTML scraping).

## What it does

When you open the popup:

1. **Playoff team list**  
   Loads standings from **`GET /v1/standings/{YYYY-MM-DD}`** starting from today’s calendar date (local time).  
   If that day returns no rows (common during parts of the playoffs/off-season), it **steps backward day by day** until it finds the latest standings snapshot with teams.

   From those standings it builds the list of “playoff-context” clubs:

   - If the API exposes explicit playoff qualification on **exactly 16** teams (checked via several plausible boolean-style fields), it uses those teams.
   - Otherwise it takes the **top eight teams per conference**, ordered by **`conferenceSequence`** (the same ordering the API uses inside each conference).

   Those teams populate a **dropdown** so you pick which club you care about.

2. **Season handling**  
   Schedule requests use **`GET /v1/club-schedule-season/{TEAM}/{SEASON}`**, where **`SEASON`** is derived from the current calendar (for example April 2026 maps to **`20252026`**), following the NHL season that runs roughly October through June.

3. **Two views** (toggle in the popup):

   - **Next upcoming game** — Earliest future game on that team’s schedule (start time strictly after “now”), with opponent, **localized date**, **local time**, **home/away**, and playoff **series context** when applicable.
   - **Last result & highlights** — Most recent **completed** game for that team, with **final score**, optional playoff series lines, and links to NHL media when the API provides paths.

4. **Playoff series details**  
   Schedule entries for playoff games include partial **`seriesStatus`** data; for **series score** (which seed is which team), the extension matches the same game on **`GET /v1/scoreboard/{gameDate}`** by **game id** and merges **`topSeedTeamAbbrev` / `bottomSeedTeamAbbrev`** so it can show a readable **“Team A vs. Team B · wins–wins”** line.

5. **Highlights and GameCenter**  
   Recap and condensed paths from the schedule object are turned into **`https://www.nhl.com/...`** links so you can open **3-minute recap**, **condensed game**, or **GameCenter** in a new tab when those fields exist.

## UI behavior

- Loading and error states for standings and schedules.
- Empty states when there is no upcoming game or no completed game in the current season payload.
- Modern popup styling with light/dark-friendly colors.

## Chrome Web Store assets

Listing images, promo tiles, and a publishing checklist live in **`store/`**. Start with **`store/CHROME_WEB_STORE.md`**.

## Install (development)

1. Clone this repo.
2. Chrome → **Extensions** → enable **Developer mode** → **Load unpacked** → choose this folder (`nhl-playoff-tracker`).

## Permissions

Host permissions are limited to **`/v1/standings/*`**, **`/v1/club-schedule-season/*`**, and **`/v1/scoreboard/*`** on **`api-web.nhle.com`** (see `manifest.json`).

Opening recap or GameCenter uses normal browser navigation to **`nhl.com`** (no extra host permission required for typical `<a href>` navigation).

## Privacy

- **Schedules and standings**: requested only from **`api-web.nhle.com`**.
- **Highlight pages** load on **NHL’s website** when you choose a link.

The extension does not collect or store analytics in this codebase; it performs fetches when you open or refresh the popup and when you change team or view.

### Host the privacy policy on GitHub Pages (Store URL)

A short, public **privacy policy** page ships in this repo as **`privacy/index.html`**. After you push to GitHub:

1. Open the repo on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose your default branch (usually **`main`**) and folder **`/ (root)`**, then save.

Your policy will be available at:

`https://<your-username>.github.io/<repository-name>/privacy/`

Example (must match your **exact** GitHub repo name; this project is **`nhl-playoffs-tracker`**):

`https://evgenig-io.github.io/nhl-playoffs-tracker/privacy/`

The **site root** (`…github.io/nhl-playoffs-tracker/`) only works after you add a root `index.html` (this repo includes one that links to the policy). If you still see 404 at root, wait a few minutes after the first Pages build, hard-refresh, or confirm Pages source is **`main`** and **`/ (root)`**.

Use that URL in the Chrome Web Store **Privacy policy** field. A **`.nojekyll`** file is included at the repo root so GitHub Pages serves the static HTML as-is.

Edit **`privacy/index.html`** if your behavior or APIs change.

## Icon (Chrome toolbar & Web Store)

PNG assets live in **`icons/`** (`icon16.png`, `icon48.png`, `icon128.png`). They are **original artwork** in an **NHL-inspired** navy / silver / ice palette with generic hockey/playoff motifs. They are **not** the official NHL logo or team marks, which are **trademarks**; for publishing, use this set or your own licensed graphics.
