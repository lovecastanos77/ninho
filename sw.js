// Ninho — service worker v2: rede primeiro (atualizacoes chegam na hora),
// cache como reserva para abrir offline. Dados da nuvem sempre vem da rede.
const CACHE = 'ninho-v9';
const SHELL = ['./', './index.html', './styles.css?v=2', './app.js?v=2', './config.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  // Sons (mp3): cache primeiro — depois de baixados, tocam ate sem internet.
  if (url.pathname.endsWith('.mp3')) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      }))
    );
    return;
  }
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy));
      return res;
    }).catch(async () => {
      const hit = await caches.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      throw new Error('offline e sem cache');
    })
  );
});
