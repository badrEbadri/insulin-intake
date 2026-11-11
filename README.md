# Insulin Intake — Vanilla Web Edition

A plain HTML, CSS and JavaScript edition of the insulin/weight record tracker.

## Run locally

Because the app uses a service worker and browser storage, run it from a local web server rather than opening `index.html` directly. For example, with Python installed:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy

Upload the contents of this folder to a static website host (not the enclosing folder if the host asks for the publish directory). The entry point is `index.html`; no build step or backend is required.

## Data and privacy

Insulin and weight records are stored in the browser's local storage on the device/browser where they are entered. They are not synced to a server. Clearing browser data can erase records; use the app's CSV export and backup options. The original Expo app's data is separate and is not automatically imported.

This is a record-keeping tool only. It does not calculate or recommend insulin doses, provide medical advice, or reproduce native iOS notification scheduling. Use the records in accordance with your clinician's instructions.
