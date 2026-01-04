import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(
      process.env.GITHUB_RUN_NUMBER || process.env.BUILD_NUMBER || `${Date.now()}`
    )
  },
  plugins: [
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
