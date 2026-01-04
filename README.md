# DayList

DayList is an offline-first PWA for daily repeating and scheduled tasks. It runs on Vue 3 + Vite with a lightweight UI and peer-to-peer sync.

## Quick Start
1. Install dependencies:
   ```sh
   npm install
   ```
2. Start the dev server:
   ```sh
   npm run dev
   ```
3. Open `http://localhost:5173` in your browser.

## Build
Create a production build:
```sh
npm run build
```

Preview the production build:
```sh
npm run preview
```

## Tests
### Unit + Component Tests (Vitest)
```sh
npm test
```

### E2E Tests (Playwright)
```sh
npm run test:e2e
```

Playwright runs against the Vite preview server. E2E specs live in `tests/e2e`.

## Project Layout
- `index.html` is the Vite entry point.
- `src/` contains the Vue app, styles, and domain logic.
- `src/lib` holds pure utilities and models.
- `src/services` holds side-effect services (sync, persistence, PWA, toast).
- `src/stores` holds Pinia state and orchestration.
- `src/components` contains UI components.
- `tests/` contains unit, component, and e2e tests.
