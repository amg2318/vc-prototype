/**
 * Registers the offline service worker in production builds only, so the dev
 * server never serves stale cached files.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error: unknown) => {
      // Expected on the LAN dev setup with an untrusted certificate; harmless.
      console.warn('Service worker registration failed:', error);
    });
  });
}
