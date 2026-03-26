import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, FeatureCollection } from "geojson";
import {
  DEFAULT_TIME_BUDGET_S,
  PATHS,
  START_LAT,
  START_LON,
} from "../src/config.js";
import {
  highwayProximityWarningsMerged,
  type Segment2D,
} from "../src/geo/buffer.js";
import { euclideanM } from "../src/geo/distance.js";
import { epsg3301ToWgs84, wgs84ToEpsg3301 } from "../src/geo/proj.js";
import {
  bestNodeWithinBudget,
  dijkstra,
  findNearestNode,
  reconstructPath,
} from "../src/graph/dijkstra.js";
import { readGraphBin } from "../src/graph/graph-io.js";
import { buildRouteGpx } from "../src/gpx/formatRoute.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function main(): Promise<void> {
  const graphPath = join(root, PATHS.graphBin);
  const pohiPath = join(root, "data/pohi-segments.json");
  const outPath = join(root, PATHS.routeGeojson);
  const gpxPath = join(root, PATHS.routeGpx);

  const budget =
    Number.parseFloat(process.env.TIME_BUDGET_S ?? "") ||
    DEFAULT_TIME_BUDGET_S;
  const lon = Number.parseFloat(process.env.START_LON ?? "") || START_LON;
  const lat = Number.parseFloat(process.env.START_LAT ?? "") || START_LAT;

  const [sx, sy] = wgs84ToEpsg3301(lon, lat);
  const g = await readGraphBin(graphPath);
  const start = findNearestNode(g, sx, sy);

  let pohi: Segment2D[] = [];
  try {
    pohi = JSON.parse(await readFile(pohiPath, "utf8")) as Segment2D[];
  } catch {
    /* optional */
  }

  console.error(`Start node ${start} near (${sx.toFixed(1)}, ${sy.toFixed(1)})`);
  const t0 = performance.now();
  const { dist, parent } = dijkstra(g, start);
  console.error(`Dijkstra ${((performance.now() - t0) / 1000).toFixed(2)}s`);

  const end = bestNodeWithinBudget(g, dist, budget, sx, sy);
  if (end < 0) {
    console.error("No reachable node within budget.");
    process.exit(1);
  }

  const nodes = reconstructPath(parent, end);
  const coords3301: [number, number][] = nodes.map((id) => [
    g.nodeX[id]!,
    g.nodeY[id]!,
  ]);
  const coordsWgs: [number, number][] = coords3301.map(([x, y]) => {
    const [lo, la] = epsg3301ToWgs84(x, y);
    return [lo, la];
  });
  const cumulativeTimeS = nodes.map((id) => dist[id]!);

  let pathLenM = 0;
  for (let i = 0; i < coords3301.length - 1; i++) {
    const [x0, y0] = coords3301[i]!;
    const [x1, y1] = coords3301[i + 1]!;
    pathLenM += euclideanM(x0, y0, x1, y1);
  }

  const straightM = euclideanM(sx, sy, g.nodeX[end]!, g.nodeY[end]!);
  const travelTimeS = dist[end]!;

  const BUFFER_M = 500;
  const bufferWarnings = highwayProximityWarningsMerged(
    coords3301,
    pohi,
    BUFFER_M,
  );

  const routeLine: Feature = {
    type: "Feature",
    properties: {
      straightLineM: straightM,
      pathLengthM: pathLenM,
      travelTimeS,
      timeBudgetS: budget,
      bufferWarnings500m: bufferWarnings.length,
      cumulativeTimeS,
      start: { lon, lat },
      end: {
        lon: coordsWgs[coordsWgs.length - 1]![0],
        lat: coordsWgs[coordsWgs.length - 1]![1],
      },
    },
    geometry: {
      type: "LineString",
      coordinates: coordsWgs,
    },
  };

  const crossingFeatures: Feature[] = bufferWarnings.map((w, idx) => {
    const [lo, la] = epsg3301ToWgs84(w.midX, w.midY);
    return {
      type: "Feature",
      properties: {
        type: "road_crossing",
        leg: w.leg,
        index: idx,
      },
      geometry: {
        type: "Point",
        coordinates: [lo, la],
      },
    };
  });

  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [routeLine, ...crossingFeatures],
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(fc, null, 2), "utf8");
  console.error(`Wrote ${PATHS.routeGeojson}`);

  const gpxDesc = [
    `Straight-line: ${(straightM / 1000).toFixed(2)} km`,
    `Path: ${(pathLenM / 1000).toFixed(2)} km`,
    `Est. time: ${(travelTimeS / 3600).toFixed(2)} h`,
    bufferWarnings.length
      ? `500 m buffer warnings: ${bufferWarnings.length}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const gpxXml = buildRouteGpx({
    name: "Põgenemine Püssist — planned route",
    description: gpxDesc,
    coordinates: coordsWgs,
    cumulativeTimeS,
    roadCrossings: bufferWarnings.map((w, idx) => {
      const [lo, la] = epsg3301ToWgs84(w.midX, w.midY);
      return {
        lon: lo,
        lat: la,
        name: `Põhimaantee lähedus (${idx + 1})`,
        sym: "Danger Area",
      };
    }),
  });
  await writeFile(gpxPath, gpxXml, "utf8");
  console.error(`Wrote ${PATHS.routeGpx}`);
  console.error(
    `Straight-line: ${(straightM / 1000).toFixed(2)} km | Path: ${(pathLenM / 1000).toFixed(2)} km | Time: ${(travelTimeS / 3600).toFixed(2)} h`,
  );
  if (bufferWarnings.length)
    console.error(`500 m buffer warnings (midpoints near põhimaantee): ${bufferWarnings.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
