(function () {
  'use strict';

  if (typeof L === 'undefined' || typeof proj4 === 'undefined' || !L.Proj) {
    console.error('Leaflet, proj4, and Proj4Leaflet are required for L-EST / reljeef.');
  }

  const TILE_CACHE_NAME = 'trail-map-tiles-v1';
  const DB_NAME = 'trail-map-db';
  const DB_STORE = 'gpx';
  const OFFLINE_ZOOM_MIN = 12;
  const OFFLINE_ZOOM_MAX = 16;
  /** Max spacing along track (m). Smaller = tighter corridor, more tiles; ~100m keeps tiles near the path only. */
  const OFFLINE_CORRIDOR_STEP_M = 100;
  /** Zoom 12–13 tiles are large — one tile margin. Finer zooms rely on dense samples only. */
  const OFFLINE_TILE_BUFFER_LOW_ZOOM = 1;
  const OFFLINE_TILE_BUFFER_HIGH_ZOOM = 0;
  const OFFLINE_BUFFER_ZOOM_CUTOFF = 13;

  const EPSG3301_DEF =
    '+proj=lcc +lat_1=58 +lat_2=59.33333333333334 +lat_0=57.51755393055556 ' +
    '+lon_0=24 +x_0=500000 +y_0=6375000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

  const LEST_RESOLUTIONS = [
    4000, 2000, 1000, 500, 250, 125, 62.5, 31.25, 15.625, 7.8125, 3.90625, 1.953125,
    0.9765625, 0.48828125, 0.244140625,
  ];
  const LEST_MAX_Z = LEST_RESOLUTIONS.length - 1;

  const MAA_ATTR =
    '&copy; <a href="https://www.maaamet.ee/" rel="noreferrer">Maa-amet</a> · ' +
    '<a href="https://tiles.maaamet.ee/" rel="noreferrer">tiles</a>';

  const LAYERS_META = {
    kaart: { ext: 'png' },
    hallkaart: { ext: 'png' },
    foto: { ext: 'jpg' },
    hybriid: { ext: 'png' },
    reljeef: { ext: 'png' },
  };

  let map = null;
  let currentMapKind = null;
  let baseLayer = null;
  let terrainBlendLayer = null;
  let reljeefLestLayer = null;
  let gpxLayer = null;
  let lastGpxBlobUrl = null;
  let lastRoutePoints = [];
  let lastGpxText = null;
  let lastGpxName = null;

  function maaTms(layerId, matrix) {
    const ext = LAYERS_META[layerId].ext;
    return (
      'https://tiles.maaamet.ee/tm/tms/1.0.0/' +
      layerId +
      '@' +
      matrix +
      '/{z}/{x}/{y}.' +
      ext
    );
  }

  function latLngToTileXY(lat, lng, z) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, z);
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { x, y };
  }

  function xyzToTmsY(y, z) {
    return Math.pow(2, z) - 1 - y;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = ((lat2 - lat1) * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Insert points so consecutive vertices are at most maxSegmentM apart (along straight segments in lat/lng).
   * Keeps tile collection close to the GPX path instead of huge jumps skipping the corridor.
   */
  function densifyLatLngs(pts, maxSegmentM) {
    if (!pts || pts.length < 2) return pts ? pts.slice() : [];
    const out = [[pts[0][0], pts[0][1]]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const d = haversineM(a[0], a[1], b[0], b[1]);
      if (d <= maxSegmentM) {
        out.push([b[0], b[1]]);
        continue;
      }
      const n = Math.ceil(d / maxSegmentM);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
      out.push([b[0], b[1]]);
    }
    return out;
  }

  function buildGmcTileUrl(layerId, z, x, tmsY) {
    const ext = LAYERS_META[layerId].ext;
    return (
      'https://tiles.maaamet.ee/tm/tms/1.0.0/' +
      layerId +
      '@GMC/' +
      z +
      '/' +
      x +
      '/' +
      tmsY +
      '.' +
      ext
    );
  }

  function collectTilesGmc(latlngs, zMin, zMax) {
    const dense = densifyLatLngs(latlngs, OFFLINE_CORRIDOR_STEP_M);
    const set = new Set();
    for (let z = zMin; z <= zMax; z++) {
      const buf = z <= OFFLINE_BUFFER_ZOOM_CUTOFF
        ? OFFLINE_TILE_BUFFER_LOW_ZOOM
        : OFFLINE_TILE_BUFFER_HIGH_ZOOM;
      for (let i = 0; i < dense.length; i++) {
        const ll = dense[i];
        const { x, y } = latLngToTileXY(ll[0], ll[1], z);
        for (let dx = -buf; dx <= buf; dx++) {
          for (let dy = -buf; dy <= buf; dy++) {
            const tmsY = xyzToTmsY(y + dy, z);
            set.add(z + '/' + (x + dx) + '/' + tmsY);
          }
        }
      }
    }
    const tiles = [];
    set.forEach(function (key) {
      const parts = key.split('/').map(Number);
      tiles.push({ z: parts[0], x: parts[1], y: parts[2] });
    });
    return tiles;
  }

  /** Which Maa-amet @GMC layers to cache: current base only (+ hallkaart if color topo + terrain blend). */
  function getOfflineLayerIds() {
    const base = elBaseSelect.value;
    if (base === 'lest') return [];
    const ids = [base];
    if (base === 'kaart' && elTerrainToggle.checked && ids.indexOf('hallkaart') === -1) {
      ids.push('hallkaart');
    }
    return ids;
  }

  function parseGpxLatLngs(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const pts = [];
    doc.querySelectorAll('trkpt, rtept').forEach(function (el) {
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) pts.push([lat, lon]);
    });
    return pts;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onerror = function () {
        reject(req.error);
      };
      req.onupgradeneeded = function () {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
    });
  }

  function idbPut(record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(record);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function idbGet(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function idbDelete(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  const elNet = document.getElementById('net-status');
  const elStorage = document.getElementById('storage-stats');
  const elTrackStats = document.getElementById('track-stats');
  const elProgressWrap = document.getElementById('progress-wrap');
  const elProgressBar = document.getElementById('progress-bar');
  const elOfflineBtn = document.getElementById('btn-offline');
  const elBaseSelect = document.getElementById('base-layer');
  const elTerrainToggle = document.getElementById('terrain-toggle');
  const elTerrainWrap = document.getElementById('terrain-toggle-wrap');
  const elTerrainHint = document.getElementById('terrain-hint');
  const elGpxInput = document.getElementById('gpx-input');
  const elClear = document.getElementById('btn-clear-gpx');
  const elIosBanner = document.getElementById('ios-banner');
  const elIosDismiss = document.getElementById('ios-banner-dismiss');
  const elOfflineSummary = document.getElementById('offline-summary');

  function setNetStatus() {
    const online = navigator.onLine;
    elNet.textContent = online ? 'Online' : 'Offline';
    elNet.classList.toggle('online', online);
    elNet.classList.toggle('offline', !online);
  }

  function updateStorageStats() {
    Promise.all([
      navigator.storage && navigator.storage.estimate
        ? navigator.storage.estimate()
        : Promise.resolve({ usage: 0, quota: 0 }),
      typeof caches !== 'undefined'
        ? caches.open(TILE_CACHE_NAME).then(function (c) {
            return c.keys();
          })
        : Promise.resolve([]),
    ])
      .then(function (results) {
        const est = results[0];
        const keys = results[1];
        const tileKeys = keys.filter(function (r) {
          return r.url.indexOf('tiles.maaamet.ee') !== -1;
        });
        const mb = (est.usage / (1024 * 1024)).toFixed(1);
        elStorage.textContent =
          tileKeys.length + ' tiles · ~' + mb + ' MB origin storage';
      })
      .catch(function () {
        elStorage.textContent = '';
      });
  }

  function detachGpxVisual() {
    if (gpxLayer && map) {
      map.removeLayer(gpxLayer);
      gpxLayer = null;
    }
    if (lastGpxBlobUrl) {
      URL.revokeObjectURL(lastGpxBlobUrl);
      lastGpxBlobUrl = null;
    }
  }

  function removeGpxFromMap() {
    detachGpxVisual();
    lastRoutePoints = [];
    lastGpxText = null;
    lastGpxName = null;
    elTrackStats.textContent = '';
    updateOfflineButtonState();
  }

  function updateOfflineButtonState() {
    const isLest = elBaseSelect.value === 'lest';
    elOfflineBtn.disabled =
      lastRoutePoints.length === 0 || isLest;
    elOfflineBtn.title = isLest
      ? 'Offline download uses Web Mercator tiles only. Pick a “Web Mercator” base layer to cache.'
      : '';
  }

  function showGpxStats(layer) {
    const km = (layer.get_distance() / 1000).toFixed(2);
    const gain = Math.round(layer.get_elevation_gain());
    const loss = Math.round(layer.get_elevation_loss());
    elTrackStats.textContent =
      'Distance: ' + km + ' km · Ascent: ' + gain + ' m · Descent: ' + loss + ' m';
  }

  function buildGpxLayer() {
    const startIcon = L.divIcon({
      className: 'trail-pin trail-pin--start',
      html: '<div class="trail-pin-inner">A</div>',
      iconSize: [24, 28],
      iconAnchor: [12, 28],
    });
    const endIcon = L.divIcon({
      className: 'trail-pin trail-pin--end',
      html: '<div class="trail-pin-inner">B</div>',
      iconSize: [24, 28],
      iconAnchor: [12, 28],
    });

    gpxLayer = new L.GPX(lastGpxBlobUrl, {
      async: true,
      marker_options: {
        startIcon: startIcon,
        endIcon: endIcon,
        startIconUrl: '',
        endIconUrl: '',
        shadowUrl: '',
      },
      polyline_options: {
        color: '#c62828',
        weight: 4,
        opacity: 0.92,
      },
    });

    gpxLayer.on('loaded', function (e) {
      const target = e.target;
      map.fitBounds(target.getBounds().pad(0.12));
      showGpxStats(target);
      updateOfflineButtonState();
    });

    gpxLayer.addTo(map);
  }

  function addGpxFromText(name, text, writeIdb) {
    detachGpxVisual();
    lastGpxText = text;
    lastGpxName = name || 'track.gpx';
    lastRoutePoints = parseGpxLatLngs(text);
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    lastGpxBlobUrl = URL.createObjectURL(blob);
    buildGpxLayer();
    updateOfflineButtonState();
    if (writeIdb) {
      return idbPut({
        id: 'last',
        name: lastGpxName,
        text: text,
        updated: Date.now(),
      });
    }
    return Promise.resolve();
  }

  function restoreGpxIfAny() {
    if (!map || !lastGpxText) return;
    lastGpxBlobUrl = URL.createObjectURL(
      new Blob([lastGpxText], { type: 'application/gpx+xml' })
    );
    buildGpxLayer();
    updateOfflineButtonState();
  }

  function destroyMap() {
    detachGpxVisual();
    if (map) {
      map.remove();
      map = null;
    }
    baseLayer = null;
    terrainBlendLayer = null;
    reljeefLestLayer = null;
    currentMapKind = null;
  }

  function initLestMap() {
    if (typeof L.Proj === 'undefined' || !L.Proj.CRS) {
      initGmcMap('kaart');
      elBaseSelect.value = 'kaart';
      return;
    }
    const crs = new L.Proj.CRS('EPSG:3301', EPSG3301_DEF, {
      resolutions: LEST_RESOLUTIONS,
      origin: [40500, 5993000],
      bounds: L.bounds(L.point(40500, 5993000), L.point(1064500, 7017000)),
    });

    map = L.map('map', {
      crs: crs,
      zoomControl: true,
      maxZoom: LEST_MAX_Z,
      minZoom: 0,
    });

    const sw = crs.projection.unproject(L.point(40500, 5993000));
    const ne = crs.projection.unproject(L.point(1064500, 7017000));
    map.setMaxBounds(L.latLngBounds(sw, ne));
    map.setView([58.6, 25.0], 5);

    baseLayer = L.tileLayer(maaTms('kaart', 'LEST'), {
      tms: true,
      maxZoom: LEST_MAX_Z,
      maxNativeZoom: LEST_MAX_Z,
      attribution: MAA_ATTR + ' · L-EST / EPSG:3301',
    }).addTo(map);

    reljeefLestLayer = L.tileLayer(maaTms('reljeef', 'LEST'), {
      tms: true,
      maxZoom: LEST_MAX_Z,
      maxNativeZoom: LEST_MAX_Z,
      opacity: 0.62,
      attribution: '',
      pane: 'overlayPane',
    });
    if (elTerrainToggle.checked) {
      reljeefLestLayer.addTo(map);
    }

    terrainBlendLayer = null;
    currentMapKind = 'lest';
  }

  function syncGmcTerrainBlend() {
    const id = elBaseSelect.value;
    if (id !== 'kaart') {
      if (terrainBlendLayer && map.hasLayer(terrainBlendLayer)) {
        map.removeLayer(terrainBlendLayer);
      }
      return;
    }
    if (elTerrainToggle.checked) {
      if (!map.hasLayer(terrainBlendLayer)) terrainBlendLayer.addTo(map);
    } else {
      map.removeLayer(terrainBlendLayer);
    }
  }

  function initGmcMap(baseId) {
    map = L.map('map', {
      crs: L.CRS.EPSG3857,
      zoomControl: true,
      maxZoom: 18,
    });
    map.setView([58.6, 25.0], 7);

    map.createPane('terrainBlend');
    const terrainPane = map.getPane('terrainBlend');
    terrainPane.classList.add('leaflet-terrain-blend-pane');
    terrainPane.style.zIndex = 250;

    baseLayer = L.tileLayer(maaTms(baseId, 'GMC'), {
      tms: true,
      maxZoom: 18,
      attribution: MAA_ATTR + ' · Web Mercator',
    }).addTo(map);

    terrainBlendLayer = L.tileLayer(maaTms('hallkaart', 'GMC'), {
      tms: true,
      maxZoom: 18,
      attribution: '',
      pane: 'terrainBlend',
    });

    reljeefLestLayer = null;
    currentMapKind = 'gmc';
    syncGmcTerrainBlend();
  }

  function swapGmcBase(id) {
    map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(maaTms(id, 'GMC'), {
      tms: true,
      maxZoom: 18,
      attribution: MAA_ATTR + ' · Web Mercator',
    });
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    syncGmcTerrainBlend();
    if (terrainBlendLayer && map.hasLayer(terrainBlendLayer)) {
      terrainBlendLayer.bringToFront();
    }
  }

  function syncOverlayUi() {
    const v = elBaseSelect.value;
    if (v === 'lest') {
      elTerrainWrap.style.display = 'inline-flex';
      elTerrainToggle.disabled = false;
      if (elTerrainHint) {
        elTerrainHint.textContent = 'Reljeef hillshade';
        elTerrainHint.title =
          'Maa-amet reljeef layer (grey relief shading) on L-EST tiles — the real hillshade, not available on Web Mercator.';
      }
      if (reljeefLestLayer) {
        if (elTerrainToggle.checked) {
          if (!map.hasLayer(reljeefLestLayer)) reljeefLestLayer.addTo(map);
        } else {
          map.removeLayer(reljeefLestLayer);
        }
      }
    } else if (v === 'kaart') {
      elTerrainWrap.style.display = 'inline-flex';
      elTerrainToggle.disabled = false;
      if (elTerrainHint) {
        elTerrainHint.textContent = 'Terrain shading';
        elTerrainHint.title =
          'Blends grayscale topo (hallkaart) for contrast. True reljeef hillshade requires the “Best relief” L-EST layer.';
      }
      syncGmcTerrainBlend();
    } else {
      elTerrainWrap.style.display = 'none';
      elTerrainToggle.disabled = true;
      if (terrainBlendLayer && map.hasLayer(terrainBlendLayer)) {
        map.removeLayer(terrainBlendLayer);
      }
    }
    updateOfflineButtonState();
  }

  function onBaseLayerChange() {
    const v = elBaseSelect.value;
    if (v === 'lest') {
      if (currentMapKind !== 'lest') {
        destroyMap();
        initLestMap();
        restoreGpxIfAny();
      }
    } else {
      if (currentMapKind !== 'gmc') {
        destroyMap();
        initGmcMap(v);
        restoreGpxIfAny();
      } else {
        swapGmcBase(v);
      }
    }
    syncOverlayUi();
  }

  elBaseSelect.addEventListener('change', onBaseLayerChange);

  elTerrainToggle.addEventListener('change', function () {
    if (elBaseSelect.value === 'lest' && reljeefLestLayer) {
      if (elTerrainToggle.checked) reljeefLestLayer.addTo(map);
      else map.removeLayer(reljeefLestLayer);
    } else {
      syncGmcTerrainBlend();
    }
  });

  elGpxInput.addEventListener('change', function () {
    const f = elGpxInput.files && elGpxInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () {
      addGpxFromText(f.name, reader.result, true)
        .then(updateStorageStats)
        .catch(console.error);
    };
    reader.readAsText(f);
    elGpxInput.value = '';
  });

  elClear.addEventListener('click', function () {
    removeGpxFromMap();
    idbDelete('last').then(updateStorageStats).catch(console.error);
  });

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  elOfflineBtn.addEventListener('click', function () {
    if (lastRoutePoints.length === 0 || elBaseSelect.value === 'lest') return;
    const layerIds = getOfflineLayerIds();
    if (layerIds.length === 0) return;

    const tiles = collectTilesGmc(lastRoutePoints, OFFLINE_ZOOM_MIN, OFFLINE_ZOOM_MAX);
    const urls = [];
    tiles.forEach(function (t) {
      layerIds.forEach(function (lid) {
        urls.push(buildGmcTileUrl(lid, t.z, t.x, t.y));
      });
    });
    const total = urls.length;
    let done = 0;
    if (elOfflineSummary) {
      elOfflineSummary.hidden = false;
      elOfflineSummary.textContent =
        'Along track: ' +
        tiles.length +
        ' tile positions × ' +
        layerIds.length +
        ' layer(s) = ' +
        total +
        ' files';
    }
    elProgressWrap.classList.add('visible');
    elProgressWrap.setAttribute('aria-hidden', 'false');
    elOfflineBtn.disabled = true;

    const batchSize = 6;
    function runBatch(start) {
      const end = Math.min(start + batchSize, total);
      const chunk = urls.slice(start, end);
      return Promise.all(
        chunk.map(function (url) {
          return fetch(url, { mode: 'no-cors', cache: 'default' }).then(
            function () {},
            function () {}
          );
        })
      ).then(function () {
        done = end;
        elProgressBar.style.width = ((100 * done) / total).toFixed(1) + '%';
        if (done < total) {
          return sleep(20).then(function () {
            return runBatch(done);
          });
        }
      });
    }

    runBatch(0)
      .then(function () {
        updateOfflineButtonState();
        elProgressWrap.classList.remove('visible');
        elProgressBar.style.width = '0%';
        elProgressWrap.setAttribute('aria-hidden', 'true');
        if (elOfflineSummary) {
          elOfflineSummary.hidden = true;
          elOfflineSummary.textContent = '';
        }
        updateStorageStats();
      })
      .catch(function (err) {
        console.error(err);
        elOfflineBtn.disabled = false;
        if (elOfflineSummary) {
          elOfflineSummary.hidden = true;
          elOfflineSummary.textContent = '';
        }
      });
  });

  window.addEventListener('online', setNetStatus);
  window.addEventListener('offline', setNetStatus);
  setNetStatus();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  function isIos() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  if (isIos() && !isStandalone()) {
    try {
      if (!localStorage.getItem('trail-map-ios-banner-dismissed')) {
        elIosBanner.classList.add('visible');
      }
    } catch (e) {}
  }

  elIosDismiss.addEventListener('click', function () {
    elIosBanner.classList.remove('visible');
    try {
      localStorage.setItem('trail-map-ios-banner-dismissed', '1');
    } catch (e) {}
  });

  let deferredPrompt = null;
  const elInstall = document.getElementById('btn-install');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (elInstall) elInstall.hidden = false;
  });
  if (elInstall) {
    elInstall.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      var uc = deferredPrompt.userChoice;
      if (uc && typeof uc.then === 'function') {
        uc.then(function () {
          deferredPrompt = null;
          elInstall.hidden = true;
        }).catch(function () {
          deferredPrompt = null;
          elInstall.hidden = true;
        });
      } else {
        deferredPrompt = null;
        elInstall.hidden = true;
      }
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .catch(function (err) {
        console.warn('SW register failed', err);
      });
  }

  if (typeof L.Proj !== 'undefined' && L.Proj.CRS) {
    initLestMap();
  } else {
    initGmcMap('kaart');
    elBaseSelect.value = 'kaart';
  }
  syncOverlayUi();

  idbGet('last')
    .then(function (rec) {
      if (rec && rec.text) {
        return addGpxFromText(rec.name, rec.text, false);
      }
    })
    .catch(function () {})
    .finally(updateStorageStats);

  setInterval(updateStorageStats, 60000);
  updateStorageStats();
})();
