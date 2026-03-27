import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { START_LAT, START_LON } from "../config.js";
import { DEFAULT_GROUND_SPEEDS_KMH } from "../etak/speed.js";
import { Teekate } from "../etak/types.js";
import "./web.css";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

/** Shown on production static build when API base URL was not baked in (GitHub Pages cannot host /api). */
const API_SETUP_NOTE =
  import.meta.env.DEV || API_BASE
    ? ""
    : `<p class="panel-note">API nupud vajavad <code>VITE_API_URL</code> (nt Fly.io); määra GitHub secret <code>ROUTE_API_URL</code> ja ehita uuesti.</p>`;

/** User-chosen start (map click / drag); sent to API on recompute / rebuild. */
let userStartLon = START_LON;
let userStartLat = START_LAT;

const panel = document.querySelector<HTMLElement>("#panel")!;

/** Last loaded route — used for GPX export */
const routeSnapshot: {
  coordsLonLat: [number, number][];
  cumulativeTimeS: number[] | null;
  travelTimeS: number;
  roadCrossings: L.LatLngExpression[];
} = {
  coordsLonLat: [],
  cumulativeTimeS: null,
  travelTimeS: 0,
  roadCrossings: [],
};

/**
 * EPSG:3857 (Web Mercator) TMS — layer name MUST include @GMC for Leaflet default CRS.
 * See: https://geoportaal.maaamet.ee/docs/Naidisandmed/leaflet/3857/
 */
const MAAAMET_QUERY = "?ASUTUS=MAAAMET&KESKKOND=LIVE&IS=TMSNAIDE";

const maaametTileOpts = {
  attribution:
    '&copy; <a href="https://www.maaamet.ee/">Maa-amet</a>',
  tms: true,
  minZoom: 6,
  continuousWorld: true,
  worldCopyJump: true,
  updateWhenIdle: false,
} as L.TileLayerOptions;

function maaametKaart(): L.TileLayer {
  return L.tileLayer(
    `https://tiles.maaamet.ee/tm/tms/1.0.0/kaart@GMC/{z}/{x}/{y}.jpg${MAAAMET_QUERY}`,
    {
      ...maaametTileOpts,
      maxZoom: 18,
      maxNativeZoom: 18,
    },
  );
}

function maaametFoto(): L.TileLayer {
  return L.tileLayer(
    `https://tiles.maaamet.ee/tm/tms/1.0.0/foto@GMC/{z}/{x}/{y}.jpg${MAAAMET_QUERY}`,
    {
      ...maaametTileOpts,
      maxZoom: 18,
      maxNativeZoom: 18,
    },
  );
}

/** Place names / roads overlay; max zoom 15 per Maa-amet sample */
function maaametHybriid(): L.TileLayer {
  return L.tileLayer(
    `https://tiles.maaamet.ee/tm/tms/1.0.0/hybriid@GMC/{z}/{x}/{y}.png${MAAAMET_QUERY}`,
    {
      ...maaametTileOpts,
      maxZoom: 18,
      maxNativeZoom: 15,
      opacity: 0.95,
      zIndex: 2,
    },
  );
}

const baseKaart = maaametKaart();
const baseFoto = maaametFoto();
const baseFotoHybriid = L.layerGroup([maaametFoto(), maaametHybriid()]);
const baseOsm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  minZoom: 0,
  attribution: "&copy; OpenStreetMap",
});

const map = L.map("map", {
  zoomControl: true,
  minZoom: 6,
  maxZoom: 19,
}).setView([userStartLat, userStartLon], 12);
baseKaart.addTo(map);

const startIcon = L.divIcon({
  className: "start-point-marker",
  html: '<div class="start-point-marker-inner" aria-hidden="true"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const startMarker = L.marker([userStartLat, userStartLon], {
  draggable: true,
  zIndexOffset: 1000,
  title: "Stardipunkt — lohista või kliki kaardil",
  icon: startIcon,
}).addTo(map);

startMarker.bindPopup("Stardipunkt — kliki kaardil või lohista");

function syncStartMarkerFromUser(): void {
  startMarker.setLatLng([userStartLat, userStartLon]);
}

startMarker.on("dragend", () => {
  const ll = startMarker.getLatLng();
  userStartLon = ll.lng;
  userStartLat = ll.lat;
});

map.on("click", (e: L.LeafletMouseEvent) => {
  userStartLon = e.latlng.lng;
  userStartLat = e.latlng.lat;
  startMarker.setLatLng(e.latlng);
});

L.control
  .layers(
    {
      "Maa-amet kaart (ETAK)": baseKaart,
      "Maa-amet foto": baseFoto,
      "Maa-amet foto + hübriid": baseFotoHybriid,
      OpenStreetMap: baseOsm,
    },
    {},
    { collapsed: false },
  )
  .addTo(map);

let routePolyline: L.Polyline | null = null;

const TEEKATE_CODES = [
  Teekate.Pusikate,
  Teekate.Kruuskate,
  Teekate.Pinnatud,
  Teekate.Pinnas,
] as const;

const TEEKATE_LABEL_ET: Record<number, string> = {
  [Teekate.Pusikate]: "Pusikate",
  [Teekate.Kruuskate]: "Kruuskate",
  [Teekate.Pinnatud]: "Pinnatud",
  [Teekate.Pinnas]: "Pinnas",
};

/** Last speeds used for graph rebuild; keeps inputs after panel re-render. */
let lastGroundSpeedsKmh: Record<number, number> | null = null;

function groundSpeedInputValue(code: number): number {
  const fromLast = lastGroundSpeedsKmh?.[code];
  if (fromLast !== undefined && Number.isFinite(fromLast)) return fromLast;
  return DEFAULT_GROUND_SPEEDS_KMH[code] ?? 4;
}

function graphRebuildFieldsetHtml(): string {
  const rows = TEEKATE_CODES.map((code) => {
    const v = groundSpeedInputValue(code);
    const label = TEEKATE_LABEL_ET[code] ?? `Teekate ${code}`;
    return `      <div class="waypoint-row">
        <label for="teekate-speed-${code}">${label} (${code}) — km/h</label>
        <input type="number" id="teekate-speed-${code}" min="0.1" max="50" step="0.1" value="${v}" />
      </div>`;
  }).join("\n");
  return `<fieldset class="graph-rebuild-fieldset">
    <legend>Teekate kiirus (km/h)</legend>
${rows}
    <button type="button" class="recompute-btn" id="btn-rebuild-graph">Ehita graaf uuesti</button>
    <p class="panel-note" id="rebuild-graph-status" aria-live="polite"></p>
    <p class="panel-note recompute-hint">Taasehitab graafi ja arvutab marsruudi API kaudu (kohalikus dev-is Vite middleware; tootmises Fly.io server).</p>
  </fieldset>`;
}

function graphRebuildBlock(): string {
  return graphRebuildFieldsetHtml();
}

const recomputeBlock = `<div class="recompute-wrap">
      <button type="button" class="recompute-btn" id="btn-recompute">Arvuta marsruut uuesti</button>
      <p class="panel-note" id="recompute-status" aria-live="polite"></p>
      <p class="panel-note recompute-hint">Kasutab API-t (kohalikus dev-is Vite middleware; tootmises <code>VITE_API_URL</code>).</p>
    </div>`;

function clearRouteLayers(): void {
  if (routePolyline) {
    map.removeLayer(routePolyline);
    routePolyline = null;
  }
  if (waypointLayer) {
    map.removeLayer(waypointLayer);
    waypointLayer = null;
  }
}

/**
 * Pure walking time that fits in total elapsed time given break/sleep overhead ratios.
 * elapsed = walking * (1 + breakDur/breakInt + sleepDur/sleepInt)
 */
function effectiveWalkingBudgetS(params: {
  totalElapsedH: number;
  sleepIntervalH: number;
  sleepDurationH: number;
  breakIntervalMin: number;
  breakDurationMin: number;
}): number {
  const totalS = Math.max(60, params.totalElapsedH * 3600);
  const sleepInt = Math.max(0.001, params.sleepIntervalH);
  const sleepDur = Math.max(0, params.sleepDurationH);
  const breakInt = Math.max(1, params.breakIntervalMin);
  const breakDur = Math.max(0, params.breakDurationMin);
  const sleepRatio = sleepDur / sleepInt;
  const breakRatio = breakDur / breakInt;
  const denom = 1 + breakRatio + sleepRatio;
  return Math.floor(totalS / denom);
}

function readGroundSpeedsKmhFromPanel(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const code of TEEKATE_CODES) {
    const el = panel.querySelector<HTMLInputElement>(`#teekate-speed-${code}`);
    if (!el) continue;
    const n = Number(el.value);
    if (Number.isFinite(n) && n > 0) out[code] = n;
  }
  return out;
}

function readPanelEffectiveWalkingBudgetS(): number | undefined {
  const elTotal = panel.querySelector<HTMLInputElement>("#total-budget-h");
  if (!elTotal) return undefined;
  const totalH = Number(elTotal.value);
  if (!Number.isFinite(totalH) || totalH <= 0) return undefined;
  const sleepInt =
    Number(panel.querySelector<HTMLInputElement>("#sleep-interval-h")?.value) || 8;
  const sleepDur = Number(
    panel.querySelector<HTMLInputElement>("#sleep-duration-h")?.value,
  );
  const sleepDurN = Number.isFinite(sleepDur) ? sleepDur : 6;
  const breakInt =
    Number(panel.querySelector<HTMLInputElement>("#break-interval-min")?.value) ||
    60;
  const breakDur = Number(
    panel.querySelector<HTMLInputElement>("#break-duration-min")?.value,
  );
  const breakDurN = Number.isFinite(breakDur) ? breakDur : 5;
  return effectiveWalkingBudgetS({
    totalElapsedH: totalH,
    sleepIntervalH: sleepInt,
    sleepDurationH: sleepDurN,
    breakIntervalMin: breakInt,
    breakDurationMin: breakDurN,
  });
}

function updateBudgetSummary(): void {
  const el = panel.querySelector<HTMLElement>("#budget-summary");
  if (!el) return;
  const totalH =
    Number(panel.querySelector<HTMLInputElement>("#total-budget-h")?.value) || 24;
  const sleepInt =
    Number(panel.querySelector<HTMLInputElement>("#sleep-interval-h")?.value) || 8;
  const sleepDur = Number(
    panel.querySelector<HTMLInputElement>("#sleep-duration-h")?.value,
  );
  const sleepDurN = Number.isFinite(sleepDur) ? sleepDur : 6;
  const breakInt =
    Number(panel.querySelector<HTMLInputElement>("#break-interval-min")?.value) ||
    60;
  const breakDur = Number(
    panel.querySelector<HTMLInputElement>("#break-duration-min")?.value,
  );
  const breakDurN = Number.isFinite(breakDur) ? breakDur : 5;
  const walkingS = effectiveWalkingBudgetS({
    totalElapsedH: totalH,
    sleepIntervalH: sleepInt,
    sleepDurationH: sleepDurN,
    breakIntervalMin: breakInt,
    breakDurationMin: breakDurN,
  });
  const sleepIntS = Math.max(60, sleepInt * 3600);
  const breakIntS = Math.max(60, breakInt * 60);
  const nSleep = walkingS + 1e-6 >= sleepIntS ? 1 : 0;
  const nBreak = Math.floor(walkingS / breakIntS);
  const sleepPhrase = nSleep === 1 ? "1 ööbimine" : "0 ööbimist";
  el.textContent = `Hinnanguline käimisaeg: ${(walkingS / 3600).toFixed(2)} h (kokku ${totalH.toFixed(1)} h) · ${sleepPhrase} · ~${nBreak} pausi`;
}

const GPX_TIME_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0, 0);

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cumulativeSecondsToGpxTime(offsetS: number): string {
  const d = new Date(GPX_TIME_EPOCH_MS + offsetS * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

type GpxWpt = { lat: number; lon: number; name: string; sym: string };

function collectPlannedWaypoints(
  times: number[] | null,
  coordsLonLat: [number, number][],
  maxWalkS: number,
  sleepIntH: number,
  breakIntMin: number,
  showSleep: boolean,
  showBreak: boolean,
  roadCrossings: L.LatLngExpression[],
  showRoad: boolean,
): GpxWpt[] {
  const wpts: GpxWpt[] = [];
  const sleepIntS = Math.max(60, sleepIntH * 3600);
  const breakIntS = Math.max(60, breakIntMin * 60);
  if (times && coordsLonLat.length === times.length) {
    if (showSleep) {
      const t = sleepIntS;
      if (t <= maxWalkS + 1e-6) {
        const pos = positionAtTime(times, coordsLonLat, t);
        if (pos) {
          const [lon, lat] = pos;
          wpts.push({
            lat,
            lon,
            name: `Ööbimine (${(t / 3600).toFixed(1)} h käimisest)`,
            sym: "Campground",
          });
        }
      }
    }
    if (showBreak) {
      for (let k = 1; k * breakIntS <= maxWalkS + 1e-6; k++) {
        const t = k * breakIntS;
        if (showSleep && Math.abs(t - sleepIntS) < 1) continue;
        const pos = positionAtTime(times, coordsLonLat, t);
        if (!pos) continue;
        const [lon, lat] = pos;
        wpts.push({
          lat,
          lon,
          name: `Paus (${(t / 3600).toFixed(2)} h käimisest)`,
          sym: "Food",
        });
      }
    }
  }
  if (showRoad) {
    roadCrossings.forEach((ll, idx) => {
      const lat = Array.isArray(ll) ? ll[0]! : ll.lat;
      const lon = Array.isArray(ll) ? ll[1]! : ll.lng;
      wpts.push({
        lat,
        lon,
        name: `Põhimaantee lähedus (${idx + 1})`,
        sym: "Danger Area",
      });
    });
  }
  return wpts;
}

function buildGpxXml(opts: {
  name: string;
  description: string;
  coordsLonLat: [number, number][];
  cumulativeTimeS: number[] | null;
  waypoints: GpxWpt[];
}): string {
  const name = escXml(opts.name);
  const desc = escXml(opts.description);
  const creator = "p6geneme-route-calculator-web";
  const wptBlock = opts.waypoints
    .map(
      (w) => `  <wpt lat="${Number(w.lat.toFixed(7))}" lon="${Number(w.lon.toFixed(7))}">
    <name>${escXml(w.name)}</name>
    <sym>${escXml(w.sym)}</sym>
  </wpt>`,
    )
    .join("\n");
  const times = opts.cumulativeTimeS;
  const hasTimes =
    Array.isArray(times) && times.length === opts.coordsLonLat.length;
  const trkpts = opts.coordsLonLat
    .map(([lon, lat], i) => {
      const lo = Number(lon.toFixed(7));
      const la = Number(lat.toFixed(7));
      const timeEl =
        hasTimes && Number.isFinite(times[i]!)
          ? `\n        <time>${cumulativeSecondsToGpxTime(times[i]!)}</time>`
          : "";
      return `      <trkpt lat="${la}" lon="${lo}">${timeEl}\n      </trkpt>`;
    })
    .join("\n");
  const descBlock = desc ? `    <desc>${desc}</desc>\n` : "";
  const wptPrefix = wptBlock ? `${wptBlock}\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
${descBlock}  </metadata>
${wptPrefix}  <trk>
    <name>${name}</name>
${descBlock}    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function attachGraphRebuildHandler(): void {
  const btn = panel.querySelector<HTMLButtonElement>("#btn-rebuild-graph");
  const status = panel.querySelector<HTMLElement>("#rebuild-graph-status");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
    btn.disabled = true;
    try {
      const groundSpeedsKmh = readGroundSpeedsKmhFromPanel();
      if (Object.keys(groundSpeedsKmh).length === 0) {
        throw new Error("Sisesta vähemalt üks kehtiv teekate kiirus (km/h).");
      }
      const walkingS = readPanelEffectiveWalkingBudgetS();
      const body: {
        groundSpeedsKmh: Record<number, number>;
        timeBudgetS?: number;
        startLon: number;
        startLat: number;
      } = {
        groundSpeedsKmh,
        startLon: userStartLon,
        startLat: userStartLat,
      };
      if (walkingS !== undefined) body.timeBudgetS = walkingS;
      const res = await fetch(apiUrl("/api/rebuild-graph"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        route?: FeatureCollection;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      lastGroundSpeedsKmh = readGroundSpeedsKmhFromPanel();
      if (data.route) {
        renderRouteFromFeatureCollection(data.route);
      } else {
        await loadRoute({ bustCache: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (status) {
        status.textContent = msg;
        status.hidden = false;
      } else {
        alert(msg);
      }
    } finally {
      btn.disabled = false;
    }
  });
}

function attachRecomputeHandler(): void {
  const btn = panel.querySelector<HTMLButtonElement>("#btn-recompute");
  const status = panel.querySelector<HTMLElement>("#recompute-status");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
    btn.disabled = true;
    try {
      const walkingS = readPanelEffectiveWalkingBudgetS();
      const body: {
        timeBudgetS?: number;
        startLon: number;
        startLat: number;
      } = {
        startLon: userStartLon,
        startLat: userStartLat,
      };
      if (walkingS !== undefined) body.timeBudgetS = walkingS;
      const res = await fetch(apiUrl("/api/recompute-route"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        route?: FeatureCollection;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (data.route) {
        renderRouteFromFeatureCollection(data.route);
      } else {
        await loadRoute({ bustCache: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (status) {
        status.textContent = msg;
        status.hidden = false;
      } else {
        alert(msg);
      }
    } finally {
      btn.disabled = false;
    }
  });
}

function attachExportGpxHandler(): void {
  const btn = panel.querySelector<HTMLButtonElement>("#btn-export-gpx");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (routeSnapshot.coordsLonLat.length === 0) return;
    const sleepInt =
      Number(panel.querySelector<HTMLInputElement>("#sleep-interval-h")?.value) ||
      8;
    const breakInt =
      Number(panel.querySelector<HTMLInputElement>("#break-interval-min")?.value) ||
      60;
    const showSleep =
      panel.querySelector<HTMLInputElement>("#show-sleep")?.checked ?? true;
    const showBreak =
      panel.querySelector<HTMLInputElement>("#show-break")?.checked ?? true;
    const showRoad =
      panel.querySelector<HTMLInputElement>("#show-road")?.checked ?? true;
    const wpts = collectPlannedWaypoints(
      routeSnapshot.cumulativeTimeS,
      routeSnapshot.coordsLonLat,
      routeSnapshot.travelTimeS,
      sleepInt,
      breakInt,
      showSleep,
      showBreak,
      routeSnapshot.roadCrossings,
      showRoad,
    );
    const nPts = routeSnapshot.coordsLonLat.length;
    const desc = `Punkte: ${nPts} | Käimise aeg marsruudil: ${(routeSnapshot.travelTimeS / 3600).toFixed(2)} h`;
    const gpx = buildGpxXml({
      name: "Põgenemine Püssist — planned route",
      description: desc,
      coordsLonLat: routeSnapshot.coordsLonLat,
      cumulativeTimeS: routeSnapshot.cumulativeTimeS,
      waypoints: wpts,
    });
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `marsruut-${new Date().toISOString().slice(0, 10)}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

/** Largest index i with times[i] <= t (times non-decreasing). */
function segmentIndexForTime(times: number[], t: number): number {
  if (times.length === 0) return -1;
  if (t <= times[0]!) return 0;
  const last = times.length - 1;
  if (t >= times[last]!) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolate [lon, lat] at cumulative time t along the route. */
function positionAtTime(
  times: number[],
  coordsLonLat: [number, number][],
  t: number,
): [number, number] | null {
  if (
    times.length < 2 ||
    coordsLonLat.length !== times.length ||
    t < times[0]! ||
    t > times[times.length - 1]!
  ) {
    if (times.length === 1 && coordsLonLat.length === 1 && t === times[0]!) {
      return coordsLonLat[0]!;
    }
    return null;
  }
  const i = segmentIndexForTime(times, t);
  if (i >= times.length - 1) {
    return coordsLonLat[times.length - 1]!;
  }
  const t0 = times[i]!;
  const t1 = times[i + 1]!;
  const denom = t1 - t0;
  const u = denom <= 0 ? 0 : (t - t0) / denom;
  const [lon0, lat0] = coordsLonLat[i]!;
  const [lon1, lat1] = coordsLonLat[i + 1]!;
  return [lon0 + u * (lon1 - lon0), lat0 + u * (lat1 - lat0)];
}

function parseCumulativeTimeS(props: Record<string, unknown>): number[] | null {
  const raw = props.cumulativeTimeS;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function collectRoadCrossings(fc: FeatureCollection): L.LatLngExpression[] {
  const out: L.LatLngExpression[] = [];
  for (const feat of fc.features) {
    const p = feat.properties as Record<string, unknown> | null | undefined;
    if (feat.geometry?.type !== "Point" || p?.type !== "road_crossing") continue;
    const g = feat.geometry as Point;
    const c = g.coordinates;
    if (c.length < 2) continue;
    const lon = c[0]!;
    const lat = c[1]!;
    out.push([lat, lon]);
  }
  return out;
}

function divWaypointIcon(classSuffix: string, label: string): L.DivIcon {
  return L.divIcon({
    className: `waypoint-pin waypoint-pin--${classSuffix}`,
    html: `<div class="waypoint-pin-inner">${label}</div>`,
    iconSize: [24, 28],
    iconAnchor: [12, 28],
  });
}

let waypointLayer: L.LayerGroup | null = null;

function redrawWaypoints(
  times: number[] | null,
  coordsLonLat: [number, number][],
  travelTimeS: number,
  roadCrossings: L.LatLngExpression[],
  getSleepIntervalH: () => number,
  getBreakIntervalMin: () => number,
  showSleep: boolean,
  showBreak: boolean,
  showRoad: boolean,
): void {
  if (waypointLayer) {
    map.removeLayer(waypointLayer);
    waypointLayer = null;
  }
  const layer = L.layerGroup();
  waypointLayer = layer;
  const sleepS = Math.max(60, getSleepIntervalH() * 3600);
  const breakS = Math.max(60, getBreakIntervalMin() * 60);
  const maxT = travelTimeS;

  if (times && times.length === coordsLonLat.length && showSleep) {
    const t = sleepS;
    if (t <= maxT + 1e-6) {
      const pos = positionAtTime(times, coordsLonLat, t);
      if (pos) {
        const [lon, lat] = pos;
        L.marker([lat, lon], { icon: divWaypointIcon("sleep", "Ö") })
          .bindPopup(`Ööbimine (~${(t / 3600).toFixed(1)} h käimisest)`)
          .addTo(layer);
      }
    }
  }

  if (times && times.length === coordsLonLat.length && showBreak) {
    for (let k = 1; k * breakS <= maxT + 1e-6; k++) {
      const t = k * breakS;
      if (showSleep && Math.abs(t - sleepS) < 1) continue;
      const pos = positionAtTime(times, coordsLonLat, t);
      if (!pos) continue;
      const [lon, lat] = pos;
      L.marker([lat, lon], { icon: divWaypointIcon("break", "P") })
        .bindPopup(`Paus (~${(t / 3600).toFixed(2)} h käimisest)`)
        .addTo(layer);
    }
  }

  if (showRoad) {
    roadCrossings.forEach((ll, idx) => {
      L.marker(ll, { icon: divWaypointIcon("road", "!") })
        .bindPopup(`Põhimaantee lähedus (${idx + 1})`)
        .addTo(layer);
    });
  }

  layer.addTo(map);
}

function renderRouteFromFeatureCollection(fc: FeatureCollection): void {
  clearRouteLayers();

  const lineFeat = fc.features.find((f) => f.geometry?.type === "LineString") as
    | Feature
    | undefined;
  if (!lineFeat || lineFeat.geometry?.type !== "LineString") {
    panel.innerHTML = `${graphRebuildBlock()}${recomputeBlock}<p class="msg">Vigane marsruudi GeoJSON</p>`;
    attachGraphRebuildHandler();
    attachRecomputeHandler();
    return;
  }
  const line = lineFeat.geometry as LineString;
  const coordsLonLat = line.coordinates.map(
    ([lon, lat]) => [lon, lat] as [number, number],
  );
  const coordsLatLng = line.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngExpression);
  const props = (lineFeat.properties ?? {}) as Record<string, unknown>;

  const startProp = props.start as { lon?: unknown; lat?: unknown } | undefined;
  if (
    startProp &&
    typeof startProp === "object" &&
    typeof startProp.lon === "number" &&
    typeof startProp.lat === "number"
  ) {
    userStartLon = startProp.lon;
    userStartLat = startProp.lat;
    syncStartMarkerFromUser();
  }

  routePolyline = L.polyline(coordsLatLng, {
    color: "#c62828",
    weight: 4,
    opacity: 0.9,
  }).addTo(map);
  map.fitBounds(routePolyline.getBounds(), { padding: [40, 40] });

  const straightKm = Number(props.straightLineM ?? 0) / 1000;
  const pathKm = Number(props.pathLengthM ?? 0) / 1000;
  const timeH = Number(props.travelTimeS ?? 0) / 3600;
  const buf = Number(props.bufferWarnings500m ?? 0);
  const travelTimeS = Math.max(
    0,
    Number.isFinite(Number(props.travelTimeS)) ? Number(props.travelTimeS) : 0,
  );
  const timeBudgetS = Number(props.timeBudgetS ?? 0);
  const budgetH = Number.isFinite(timeBudgetS) ? timeBudgetS / 3600 : 0;
  const cumulativeTimeS = parseCumulativeTimeS(props);
  const roadCrossings = collectRoadCrossings(fc);
  const hasTimeData =
    cumulativeTimeS !== null && cumulativeTimeS.length === coordsLonLat.length;

  routeSnapshot.coordsLonLat = coordsLonLat;
  routeSnapshot.cumulativeTimeS = cumulativeTimeS;
  routeSnapshot.travelTimeS = travelTimeS;
  routeSnapshot.roadCrossings = roadCrossings;

  const timeNote = hasTimeData
    ? ""
    : `<p class="panel-note">Puudub <code>cumulativeTimeS</code> — käivita uuesti <code>yarn route:compute</code> (öök/pausid).</p>`;

  panel.innerHTML = `
    <h1>Marsruut</h1>
    ${API_SETUP_NOTE}
    ${graphRebuildBlock()}
    ${recomputeBlock}
    <dl>
      <dt>Sirgjooneline kaugus</dt><dd>${straightKm.toFixed(2)} km</dd>
      <dt>Teekonna pikkus</dt><dd>${pathKm.toFixed(2)} km</dd>
      <dt>Käimise aeg (marsruudil)</dt><dd>${timeH.toFixed(2)} h</dd>
      <dt>Dijkstra käimise eelarve</dt><dd>${budgetH.toFixed(2)} h</dd>
      <dt>500 m hoiatusi (põhimaantee)</dt><dd>${buf}</dd>
    </dl>
    ${timeNote}
    <fieldset class="waypoint-fieldset">
      <legend>Aeg ja peatused</legend>
      <div class="waypoint-row">
        <label for="total-budget-h">Koguaeg (h)</label>
        <input type="number" id="total-budget-h" min="1" max="168" step="0.5" value="24" />
      </div>
      <p class="budget-summary" id="budget-summary"></p>
      <div class="waypoint-row">
        <label for="sleep-interval-h">Ööbimine peale (h käimist)</label>
        <input type="number" id="sleep-interval-h" min="0.5" max="48" step="0.5" value="8" />
      </div>
      <div class="waypoint-row">
        <label for="sleep-duration-h">Ööbimise kestus (h)</label>
        <input type="number" id="sleep-duration-h" min="0" max="24" step="0.5" value="6" />
      </div>
      <div class="waypoint-row">
        <label for="break-interval-min">Paus iga (min käimist)</label>
        <input type="number" id="break-interval-min" min="15" max="720" step="15" value="60" />
      </div>
      <div class="waypoint-row">
        <label for="break-duration-min">Pausi kestus (min)</label>
        <input type="number" id="break-duration-min" min="0" max="180" step="5" value="5" />
      </div>
      <div class="waypoint-checks">
        <label><input type="checkbox" id="show-sleep" checked /> Ööbimised kaardil</label>
        <label><input type="checkbox" id="show-break" checked /> Pausid kaardil</label>
        <label><input type="checkbox" id="show-road" checked /> Põhimaantee hoiatused</label>
      </div>
      <button type="button" class="export-gpx-btn" id="btn-export-gpx">Ekspordi GPX</button>
    </fieldset>
  `;

  const elTotalBudget = panel.querySelector<HTMLInputElement>("#total-budget-h")!;
  const elSleepH = panel.querySelector<HTMLInputElement>("#sleep-interval-h")!;
  const elSleepDur = panel.querySelector<HTMLInputElement>("#sleep-duration-h")!;
  const elBreakIntMin = panel.querySelector<HTMLInputElement>("#break-interval-min")!;
  const elBreakDurMin = panel.querySelector<HTMLInputElement>("#break-duration-min")!;
  const elShowSleep = panel.querySelector<HTMLInputElement>("#show-sleep")!;
  const elShowBreak = panel.querySelector<HTMLInputElement>("#show-break")!;
  const elShowRoad = panel.querySelector<HTMLInputElement>("#show-road")!;

  elSleepH.disabled = !hasTimeData;
  elSleepDur.disabled = !hasTimeData;
  elBreakIntMin.disabled = !hasTimeData;
  elBreakDurMin.disabled = !hasTimeData;
  elShowSleep.disabled = !hasTimeData;
  elShowBreak.disabled = !hasTimeData;

  updateBudgetSummary();

  function refreshMarkers(): void {
    redrawWaypoints(
      hasTimeData ? cumulativeTimeS : null,
      coordsLonLat,
      travelTimeS,
      roadCrossings,
      () => Number(elSleepH.value) || 8,
      () => Number(elBreakIntMin.value) || 60,
      elShowSleep.checked,
      elShowBreak.checked,
      elShowRoad.checked,
    );
  }

  const budgetInputs = [
    elTotalBudget,
    elSleepH,
    elSleepDur,
    elBreakIntMin,
    elBreakDurMin,
  ];
  for (const el of budgetInputs) {
    el.addEventListener("input", () => {
      updateBudgetSummary();
    });
    el.addEventListener("change", () => {
      updateBudgetSummary();
    });
  }

  if (hasTimeData || roadCrossings.length > 0) {
    elSleepH.addEventListener("input", refreshMarkers);
    elSleepH.addEventListener("change", refreshMarkers);
    elBreakIntMin.addEventListener("input", refreshMarkers);
    elBreakIntMin.addEventListener("change", refreshMarkers);
    elShowSleep.addEventListener("change", refreshMarkers);
    elShowBreak.addEventListener("change", refreshMarkers);
    elShowRoad.addEventListener("change", refreshMarkers);
    refreshMarkers();
  }

  attachGraphRebuildHandler();
  attachRecomputeHandler();
  attachExportGpxHandler();
}

async function loadRoute(options?: { bustCache?: boolean }): Promise<void> {
  clearRouteLayers();

  const base = import.meta.env.BASE_URL;
  const geoUrl = options?.bustCache
    ? `${base}route.geojson?t=${Date.now()}`
    : `${base}route.geojson`;

  try {
    const res = await fetch(geoUrl);
    if (!res.ok) throw new Error(String(res.status));
    const fc = (await res.json()) as FeatureCollection;
    renderRouteFromFeatureCollection(fc);
  } catch {
    panel.innerHTML = `${graphRebuildBlock()}${recomputeBlock}
      <p class="msg">Puudub <code>public/route.geojson</code>. Käivita:</p>
      <pre>yarn etak:graph\nyarn route:compute</pre>
      <p>(eeldab <code>data/etak-roads.geojson</code> — lisa <code>yarn etak:download</code>)</p>`;
    attachGraphRebuildHandler();
    attachRecomputeHandler();
  }
}

void loadRoute();
