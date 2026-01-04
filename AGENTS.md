# Repository Guidelines

## Project Structure & Module Organization
- `index.html` is the Vite entry point.
- Application code lives in `src/`:
  - `src/main.ts` bootstraps the app.
  - `src/App.vue` is the root view.
  - `src/lib` holds pure utilities and models.
  - `src/services` holds side-effect services (sync, persistence, PWA, toast).
  - `src/stores` holds Pinia state and orchestration.
  - `src/components` contains UI components.
- PWA assets live in `public/icon.svg`, and the web manifest is generated as `manifest.webmanifest` by VitePWA. The service worker is `src/sw.ts` (built to `sw.js`).
- Tests live in `tests/` with shared setup in `tests/setup.js`; Vitest is configured in `vitest.config.ts`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start the Vite dev server.
- `npm run build`: create a production build.
- `npm run preview`: preview the production build locally.
- `npm test`: run the Vitest suite.
- `npm run test:e2e`: run Playwright e2e tests against the preview server.

## Coding Style & Naming Conventions
- ES modules are required (`"type": "module"` in `package.json`), so use `import`/`export`.
- Follow the existing 2-space indentation and semicolon usage across JS/CSS.
- Naming: `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for constants (e.g., `DAY_MS`), and `*.test.js` for tests.
- Keep module responsibilities narrow (pure logic in `src/lib`, side effects in `src/services`, UI in `src/components`).

## Testing Guidelines
- Test runner: Vitest (see `vitest.config.ts`).
- Tests should be placed in `tests/` and named `*.test.js` (e.g., `tests/core.test.js`).
- `tests/setup.js` polyfills `crypto` for deterministic test behavior; keep it updated if new globals are required.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative statements (e.g., "Add ...", "Fix ..."). Merge commits follow the standard "Merge pull request #...".
- PRs should include: a concise summary, test results (command + outcome), and linked issues when applicable.
- Include screenshots or recordings for UI changes, and call out any updates to `sw.js` or the web manifest that affect caching or installability.
