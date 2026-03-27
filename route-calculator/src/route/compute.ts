import type { Feature, FeatureCollection } from "geojson";
import {
  highwayProximityWarningsMerged,
  type Segment2D,
} from "../geo/buffer.js";
import { euclideanM } from "../geo/distance.js";
import { epsg3301ToWgs84, wgs84ToEpsg3301 } from "../geo/proj.js";
import {
  bestNodeWithinBudget,
  dijkstra,
  findNearestNode,
  reconstructPath,
} from "../graph/dijkstra.js";
import type { CompactGraph } from "../graph/types.js";

export interface ComputeRouteParams {
  graph: CompactGraph;
  pohiSegments: Segment2D[];
  startLon: number;
  startLat: number;
  timeBudgetS: number;
}

export class ComputeRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeRouteError";
  }
}

/**
 * Single-source Dijkstra + farthest-within-budget end selection; returns GeoJSON
 * FeatureCollection (line + road crossing points). Shared by CLI and API server.
 */
export function computeRouteFeatureCollection(
  params: ComputeRouteParams,
): FeatureCollection {
  const { graph: g, pohiSegments: pohi, startLon: lon, startLat: lat } = params;
  const budget = params.timeBudgetS;

  const [sx, sy] = wgs84ToEpsg3301(lon, lat);
  const start = findNearestNode(g, sx, sy);

  const { dist, parent } = dijkstra(g, start);

  const end = bestNodeWithinBudget(g, dist, budget, sx, sy);
  if (end < 0) {
    throw new ComputeRouteError("No reachable node within budget.");
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

  return {
    type: "FeatureCollection",
    features: [routeLine, ...crossingFeatures],
  };
}
