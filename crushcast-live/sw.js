'use strict';
const STATIC_CACHE='crushcast-v6-static';
const STATIC=['/','/app.css','/app.js','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install',e=>{
 e.waitUntil(caches.open(STATIC_CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
 e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==STATIC_CACHE&&k.startsWith('crushcast-')).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
 const url=new URL(e.request.url);
 if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
 /* CRITICAL: never cache any API, user sessions, shared profiles or conversation data. */
 if(!STATIC.includes(url.pathname))return;
 e.respondWith(fetch(e.request).then(response=>{
  if(response.ok&&response.type==='basic'){const copy=response.clone();caches.open(STATIC_CACHE).then(cache=>cache.put(e.request,copy)).catch(()=>{});}
  return response;
 }).catch(()=>caches.match(e.request)));
});
