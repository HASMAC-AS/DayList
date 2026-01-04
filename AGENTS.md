# Repository Guidelines

## Project Structure & Module Organization
- `index.html` is the entry point and includes the core UI markup and styles.
- JavaScript modules live at the repo root: `app.js` (bootstrapping), `core.js` (utilities/shared logic), and `todayView.js` (today view behavior).
- PWA assets are `manifest.json`, `icon.svg`, and `sw.js` (service worker).
- Tests live in `tests/` with shared setup in `tests/setup.js`; Vitest is configured in `vitest.config.js`.

## Build, Test, and Development Commands
- `npm install`: install the single dev dependency (Vitest).
- `npm test`: run the Vitest test suite in CI mode.
- Local running: there is no build step. Open `index.html` directly or serve the repository with a static server of your choice.

## Coding Style & Naming Conventions
- ES modules are required (`"type": "module"` in `package.json`), so use `import`/`export`.
- Follow the existing 2‑space indentation and semicolon usage across JS/CSS.
- Naming: `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for constants (e.g., `DAY_MS`), and `*.test.js` for tests.
- Keep module responsibilities narrow (utilities in `core.js`, UI logic in `todayView.js`).

## Testing Guidelines
- Test runner: Vitest with a Node environment (see `vitest.config.js`).
- Tests should be placed in `tests/` and named `*.test.js` (e.g., `tests/core.test.js`).
- `tests/setup.js` polyfills `crypto` for deterministic test behavior; keep it updated if new globals are required.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative statements (e.g., “Add …”, “Fix …”). Merge commits follow the standard “Merge pull request #…”.
- PRs should include: a concise summary, test results (command + outcome), and linked issues when applicable.
- Include screenshots or recordings for UI changes, and call out any updates to `sw.js` or `manifest.json` that affect caching or installability.
