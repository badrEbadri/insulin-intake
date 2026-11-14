# Insulin Intake

A plain HTML, CSS, and JavaScript record keeper for insulin doses and weight measurements. It has no build step or application server. The browser stores the records on the device where they were entered.

## Run locally

Use a local web server so the browser can load the service worker and browser storage APIs. For example:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly with a `file://` URL bypasses service-worker support.

## Project map

| File | Responsibility |
| --- | --- |
| `index.html` | Page shell, accessibility landmarks, metadata, icon links, and script loading order. |
| `app.js` | App state, local records, screen templates, chart rendering, form actions, CSV handling, backups, and installation behavior. Function comments mark each section. |
| `styles.css` | Theme tokens, mobile-first layout, reusable components, chart scrolling/touch behavior, and responsive breakpoints. |
| `manifest.webmanifest` | Install name, launch mode, colors, and PWA icon files. JSON does not allow comments; field explanations are below. |
| `service-worker.js` | Offline app-shell cache and same-origin GET caching. |
| `telegram-config.js` | Optional frontend Telegram backup settings. See the security note below before changing or publishing it. |
| `icons/icon.svg` | Scalable app and favicon artwork. |
| `icons/icon-32.png` | PNG favicon for browsers that need a bitmap. |
| `icons/icon-180.png` | PNG Home Screen icon referenced by the iPhone `apple-touch-icon` link. |
| `icons/icon-192.png`, `icons/icon-512.png` | PNG install icons referenced by the web manifest. |
| `icons/ui.svg` | SVG sprite symbols used by the desktop and mobile navigation. IDs match the `icon` fields in `NAV_ITEMS`. |

## How the app works

### Startup and screen rendering

1. `index.html` loads `telegram-config.js` before `app.js`, so optional configuration exists before app initialization.
2. `app.js` creates a fresh UI state, loads and validates records from `localStorage`, and restores a supported screen from the URL hash.
3. `render()` maps the current screen name to its renderer and replaces `#app-content` with that screen's HTML. The shared navigation, dialog, and status toast live outside that replaceable region.
4. One delegated click handler routes navigation, record actions, and chart taps. Delegation is used because screen markup is replaced during each render.

The page renderers are `renderDashboard`, `renderInsulin`, `renderWeight`, `renderCharts`, `renderHistory`, and `renderSettings`. They build HTML from the in-memory `state`; they do not write records themselves.

### Record shape and storage

The `insulin-intake-vanilla-v1` localStorage value contains two arrays:

```json
{
  "doses": [
    { "id": 1, "insulinType": "Rapid-acting", "units": 5, "takenAt": "2026-11-14T15:00:00.000Z", "notes": "" }
  ],
  "weights": [
    { "id": 1, "kilograms": 80.5, "measuredAt": "2026-11-14T15:00:00.000Z", "notes": "" }
  ]
}
```

IDs are unique within each array. Timestamps are stored as ISO strings and displayed in the device's local time. The `view`, selected date ranges, and chart selection are runtime UI state; they are not persisted with the records. Changing `STORAGE_KEY` requires a migration or existing records will no longer be read.

`validDose()` and `validWeight()` filter invalid stored entries when the app starts. `persist()` writes both arrays together. It reports a storage error instead of pretending the save succeeded.

### Automatic backups

Each saved, edited, or deleted record queues a full-history JSON snapshot. The app first tries the browser's origin-private file system and falls back to IndexedDB. `BACKUP_LIMIT` is the maximum number of snapshots retained across the two stores; older copies are pruned. The Settings page reads both stores and can export a selected snapshot as CSV.

Automatic browser backups remain tied to the browser and device. They are not server backups, and clearing site data can remove them. The separate CSV export is the portable user-controlled backup.

### CSV format and restore

CSV exports use this header and column order:

```text
record_type,id,timestamp,insulin_type,insulin_units,weight_kg,notes
```

`parseCsv()` validates the header, row sizes, IDs, timestamps, values, and duplicates before returning data. `restoreCsv()` asks before replacing all existing records. Keep the header and column order unchanged if editing a backup manually.

### Telegram configuration and privacy

The optional Telegram backup sends the full CSV to the configured chat after a new record is created. `telegram-config.js` runs in the visitor's browser, so any bot token placed there is visible to anyone who can load the site. Never use a sensitive or shared bot token in a public deployment. The request uses `no-cors`; the app cannot tell whether Telegram accepted the upload. Local saving does not depend on Telegram.

Dose and weight entries themselves remain in this browser's local storage unless the user explicitly exports or restores a file. The app records and displays entries; it does not calculate or recommend doses or interpret health trends.

## Front-end maintenance guide

### Add or rename a screen

1. Add the screen's `id`, label, and sprite symbol to `NAV_ITEMS` in `app.js`.
2. Add a renderer and register it in the `pages` map inside `render()`.
3. Add the new screen ID to the initial URL-hash allow-list near app startup if it should open from a direct link.
4. If it needs its own interaction, add a `data-action` to its HTML and handle that action in the delegated click listener.
5. For a new navigation symbol, add a `<symbol>` to `icons/ui.svg`; use that symbol ID in `NAV_ITEMS`.

### Change chart behavior

`renderInsulinChart()` creates individual time-of-day dose bars for the Day range and stacks totals by day/type for longer ranges. `renderWeightChart()` plots saved measurements only. `nearestChartMark()` turns nearby phone taps into chart selections. `render()` centers the selected or newest mark in the mobile scroller. Keep these pieces coordinated when changing chart markup or `data-chart-*` attributes.

### Change colors or responsive layout

Start with the CSS custom properties at the top of `styles.css`. The default layout is mobile-first. The 700 px breakpoint adds the desktop sidebar; the 1020 px breakpoint widens desktop content; the 390 px breakpoint tightens very narrow phone layouts. Marked charts intentionally use a wider horizontally scrollable canvas on phones to improve touch targets.

### Change offline assets

`APP_SHELL` in `service-worker.js` is the install-time list of files required for the app shell. Keep all entries valid. Change `CACHE_NAME` when a deployed update must discard an older named cache. The `fetch` handler only caches same-origin GET requests; it does not intercept writes or external requests.

### Change install metadata or icons

`manifest.webmanifest` is strict JSON, so do not add JavaScript-style comments inside it. Keep its PNG paths, declared sizes, and files in `icons/` aligned. iPhone Home Screen icons use the `apple-touch-icon` link in `index.html`; the PWA manifest icons serve supported browser install flows.

## Deploy

Deploy the contents of this folder to a static host. The included GitHub Pages workflow deploys the repository root after pushes to `main`. No bundler or backend is required.
