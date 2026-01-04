/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string }> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.skipWaiting();
clientsClaim();

const appShellUrl = new URL('index.html', self.registration.scope).toString();
registerRoute(new NavigationRoute(createHandlerBoundToURL(appShellUrl)));

registerRoute(
  ({ request }) => request.method === 'GET' && request.destination !== 'document',
  new StaleWhileRevalidate({
    cacheName: 'daylist-runtime'
  })
);

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
