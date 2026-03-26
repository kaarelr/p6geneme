/* global self, caches, fetch */
'use strict';

var APP_CACHE = 'trail-map-app-v3';
var TILE_CACHE = 'trail-map-tiles-v1';

var PRECACHE = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/proj4.js',
  './vendor/proj4leaflet.js',
  './vendor/gpx.js',
  './vendor/images/layers.png',
  './vendor/images/layers-2x.png',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './icons/map.svg',
  './spike.html',
];

function precacheUrl(path) {
  return new URL(path, self.location).toString();
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(APP_CACHE).then(function (cache) {
      return Promise.all(
        PRECACHE.map(function (p) {
          var u = precacheUrl(p);
          return cache.add(u).catch(function () {
            /* ignore missing optional assets */
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k !== APP_CACHE && k !== TILE_CACHE;
          })
          .map(function (k) {
            return caches.delete(k);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isTileRequest(url) {
  return url.indexOf('tiles.maaamet.ee') !== -1;
}

function tileStrategy(request) {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request)
        .then(function (response) {
          if (
            response &&
            (response.ok || response.type === 'opaque')
          ) {
            try {
              cache.put(request, response.clone());
            } catch (e) {}
          }
          return response;
        })
        .catch(function () {
          return new Response('', {
            status: 503,
            statusText: 'Offline',
          });
        });
    });
  });
}

function appStrategy(request) {
  return fetch(request)
    .then(function (response) {
      if (
        response &&
        (response.ok || response.type === 'opaque') &&
        request.method === 'GET'
      ) {
        var copy = response.clone();
        caches.open(APP_CACHE).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        if (hit) return hit;
        if (request.mode === 'navigate') {
          return caches.match(precacheUrl('./index.html'));
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = request.url;
  try {
    var parsed = new URL(url);
    if (parsed.origin !== self.location.origin && !isTileRequest(url)) {
      return;
    }
  } catch (e) {
    return;
  }

  if (isTileRequest(url)) {
    event.respondWith(tileStrategy(request));
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    event.respondWith(appStrategy(request));
  }
});
