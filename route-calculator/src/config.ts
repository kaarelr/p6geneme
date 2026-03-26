/** Püssi motodrome area — WGS84 */
export const START_LON = 27.045;
export const START_LAT = 59.358;

/** Event time budget (seconds) */
export const DEFAULT_TIME_BUDGET_S = 86_400;

/** WFS */
export const ETAK_WFS =
  "https://gsavalik.envir.ee/geoserver/etak/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=etak:e_501_tee_j&outputFormat=application/json&srsName=EPSG:3301";

export const WFS_PAGE_SIZE = 5000;

/** Coordinate key: 1 cm precision in EPSG:3301 */
export const COORD_SCALE = 100;

/** Paths relative to route-calculator package root */
export const PATHS = {
  etakRawDir: "data/etak-raw",
  etakMerged: "data/etak-roads.geojson",
  graphBin: "data/graph.bin",
  routeGeojson: "public/route.geojson",
  routeGpx: "public/route.gpx",
  checkpoint: "data/etak-raw/checkpoint.txt",
} as const;
