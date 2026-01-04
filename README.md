# DayList

DayList is a small, offline-first PWA for daily repeating and scheduled tasks. It ships as plain HTML/CSS/JS with no build step.

## Quick Start (Local Web Server)
1. Install dev dependencies:
   ```sh
   npm install
   ```
2. Run a local server:
   ```sh
   npm run dev
   ```
3. Open `http://localhost:5173` in your browser.

The `dev` script uses Python’s built-in web server. If `python3` isn’t available, replace it with your local Python command.

## Tests
### Unit Tests
Run the Vitest suite:
```sh
npm test
```

### E2E Tests (Playwright)
Run the Playwright suite (installs browsers on first run):
```sh
npm run test:e2e
```

Playwright runs against the local `index.html` file (no dev server required). The E2E specs live in `tests/e2e`.


## Project Layout
- `index.html` contains the main UI and styles.
- `app.js`, `core.js`, and `todayView.js` implement the app logic.
- `tests/` contains Vitest tests and shared setup.
