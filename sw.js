/* Tidenblick Service Worker: App-Shell offline, BSH-Daten network-first, Kartekacheln begrenzt cache-first */
'use strict';

const VERSION = 'tidenblick-v1';
const SHELL_CACHE = VERSION + '-shell';
const API_CACHE = VERSION + '-api';
const TILE_CACHE = VERSION + '-tiles';
const MAX_TILES = 400;
const API_TIMEOUT = 8000;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts.css',
  './app.js',
  './stations.js',
  './presets.js',
  './manifest.webmanifest',
  './vendor/d3.min.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/suncalc.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'gdi.bsh.de') {
    event.respondWith(apiStrategy(req));
    return;
  }
  if (url.hostname === 'server.arcgisonline.com') {
    event.respondWith(tileStrategy(req));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(req));
  }
});

async function apiStrategy(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await withTimeout(fetch(req), API_TIMEOUT);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone()).then(() => trimCache(cache, MAX_TILES));
  }
  return res;
}

async function shellStrategy(req) {
  const cache = await caches.open(SHELL_CACHE);
  if (req.mode === 'navigate') {
    try {
      const res = await fetch(req);
      if (res.ok) cache.put('./index.html', res.clone());
      return res;
    } catch (err) {
      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      if (cached) return cached;
      throw err;
    }
  }
  const cached = await cache.match(req);
  if (cached) {
    fetch(req).then((res) => { if (res.ok) return cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
