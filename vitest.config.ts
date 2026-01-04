import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    environmentMatchGlobs: [
      ['tests/components/**', 'jsdom']
    ]
  }
});
