import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

const buildId = process.env.GITHUB_RUN_NUMBER || process.env.BUILD_NUMBER || `${Date.now()}`;
const buildTime = new Date().toISOString();

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        headless: resolve(__dirname, 'headless.html')
      }
    }
  },
  plugins: [
    {
      name: 'daylist-version-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId, buildTime }, null, 2)
        });
      }
    },
    vue(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'DayList',
        short_name: 'DayList',
        description: 'Repeating daily checklists + scheduled tasks. Offline-first with peer-to-peer sync.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#eef4ff',
        theme_color: '#eef4ff',
        icons: [
          {
            src: './icon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      },
      devOptions: {
        enabled: true
      }
    })
  ]
});
