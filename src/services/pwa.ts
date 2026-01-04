import { registerSW } from 'virtual:pwa-register';

export function registerPwa(opts: { onNeedRefresh?: () => void; onOfflineReady?: () => void } = {}) {
  if (!('serviceWorker' in navigator)) return;

  registerSW({
    immediate: true,
    onNeedRefresh() {
      opts.onNeedRefresh?.();
    },
    onOfflineReady() {
      opts.onOfflineReady?.();
    }
  });
}
