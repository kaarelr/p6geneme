import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LineString, Point } from "geojson";
import {
  DEFAULT_TIME_BUDGET_S,
  PATHS,
  START_LAT,
  START_LON,
} from "../src/config.js";
import type { Segment2D } from "../src/geo/buffer.js";
import { readGraphBin } from "../src/graph/graph-io.js";
import { buildRouteGpx } from "../src/gpx/formatRoute.js";
import { computeRouteFeatureCollection } from "../src/route/compute.js";

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

  const { graph: g } = await readGraphBin(graphPath);

  let pohi: Segment2D[] = [];
  try {
    pohi = JSON.parse(await readFile(pohiPath, "utf8")) as Segment2D[];
  } catch {
    /* optional */
  }

  const t0 = performance.now();
  const fc = computeRouteFeatureCollection({
    graph: g,
    pohiSegments: pohi,
    startLon: lon,
    startLat: lat,
    timeBudgetS: budget,
  });
  console.error(`Route compute ${((performance.now() - t0) / 1000).toFixed(2)}s`);

  const lineFeat = fc.features.find((f) => f.geometry?.type === "LineString");
  const lineGeom = lineFeat?.geometry as LineString | undefined;
  if (!lineGeom?.coordinates?.length) {
    console.error("computeRouteFeatureCollection returned no LineString.");
    process.exit(1);
  }
  const coordsWgs = lineGeom.coordinates as [number, number][];
  const props = (lineFeat?.properties ?? {}) as Record<string, unknown>;
  const cumulativeTimeS = props.cumulativeTimeS as number[];
  const straightM = Number(props.straightLineM ?? 0);
  const pathLenM = Number(props.pathLengthM ?? 0);
  const travelTimeS = Number(props.travelTimeS ?? 0);
  const bufferWarningsCount = Number(props.bufferWarnings500m ?? 0);

  const roadCrossingPoints = fc.features
    .filter(
      (f) =>
        f.geometry?.type === "Point" &&
        (f.properties as Record<string, unknown> | null)?.type ===
          "road_crossing",
    )
    .map((f) => {
      const c = (f.geometry as Point).coordinates;
      return { lon: c[0]!, lat: c[1]! };
    });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(fc, null, 2), "utf8");
  console.error(`Wrote ${PATHS.routeGeojson}`);

  const gpxDesc = [
    `Straight-line: ${(straightM / 1000).toFixed(2)} km`,
    `Path: ${(pathLenM / 1000).toFixed(2)} km`,
    `Est. time: ${(travelTimeS / 3600).toFixed(2)} h`,
    bufferWarningsCount
      ? `500 m buffer warnings: ${bufferWarningsCount}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const gpxXml = buildRouteGpx({
    name: "Põgenemine Püssist — planned route",
    description: gpxDesc,
    coordinates: coordsWgs,
    cumulativeTimeS,
    roadCrossings: roadCrossingPoints.map((p, idx) => ({
      lon: p.lon,
      lat: p.lat,
      name: `Põhimaantee lähedus (${idx + 1})`,
      sym: "Danger Area",
    })),
  });
  await writeFile(gpxPath, gpxXml, "utf8");
  console.error(`Wrote ${PATHS.routeGpx}`);
  console.error(
    `Straight-line: ${(straightM / 1000).toFixed(2)} km | Path: ${(pathLenM / 1000).toFixed(2)} km | Time: ${(travelTimeS / 3600).toFixed(2)} h`,
  );
  if (bufferWarningsCount)
    console.error(
      `500 m buffer warnings (midpoints near highway): ${bufferWarningsCount}`,
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
