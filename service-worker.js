const CACHE='race-weather-v6';
const ASSETS=[
  './','./index.html','./styles.css?v=8','./app.js?v=8','./manifest.webmanifest?v=3',
  './icon.svg','./grassi-header.png?v=5','./apple-touch-icon.png',
  './apple-touch-icon-180x180.png','./apple-touch-icon-precomposed.png','./icon-192.png'
];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)))});
