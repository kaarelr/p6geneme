import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import { COORD_SCALE } from "../config.js";
import { speedMpsFromTeekate } from "../etak/speed.js";
import { isRestrictedTyyp, Tyyp } from "../etak/types.js";
import type { Segment2D } from "../geo/buffer.js";
import { euclideanM } from "../geo/distance.js";
import type { CompactGraph } from "./types.js";

function coordKey(x: number, y: number): string {
  const kx = Math.round(x * COORD_SCALE);
  const ky = Math.round(y * COORD_SCALE);
  return `${kx}:${ky}`;
}

function parsePosition(p: Position): [number, number] {
  const x = p[0]!;
  const y = p[1]!;
  return [x, y];
}

export interface BuildGraphOptions {
  speedMultiplier?: number;
  /** km/h by teekate code; merged with `DEFAULT_GROUND_SPEEDS_KMH` in `speedMpsFromTeekate` */
  groundSpeedsKmh?: Record<number, number>;
}

export interface BuildGraphResult {
  graph: CompactGraph;
  /** Highway (põhimaantee) segments for 500 m buffer checks */
  pohiSegments: Segment2D[];
}

function pass1Feature(
  f: Feature,
  keys: Set<string>,
  pohiSegments: Segment2D[],
): void {
  const geom = f.geometry;
  if (!geom || geom.type !== "LineString") return;
  const line = geom as LineString;
  for (const p of line.coordinates) {
    const [x, y] = parsePosition(p);
    keys.add(coordKey(x, y));
  }
  const tyyp = (f.properties as Record<string, unknown> | null)?.tyyp as
    | number
    | undefined;
  if (tyyp === Tyyp.Pohimaantee) {
    const coords = line.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = parsePosition(coords[i]!);
      const [bx, by] = parsePosition(coords[i + 1]!);
      pohiSegments.push({ ax, ay, bx, by });
    }
  }
}

function finalizeGraphFromKeysAndDirected(
  keys: Set<string>,
  directed: Map<string, number>,
  pohiSegments: Segment2D[],
): BuildGraphResult {
  const keyToId = new Map<string, number>();
  let nid = 0;
  for (const k of keys) {
    keyToId.set(k, nid++);
  }

  const nodeCount = nid;
  const nodeX = new Float64Array(nodeCount);
  const nodeY = new Float64Array(nodeCount);
  for (const k of keys) {
    const id = keyToId.get(k)!;
    const [sx, sy] = k.split(":");
    nodeX[id] = Number(sx) / COORD_SCALE;
    nodeY[id] = Number(sy) / COORD_SCALE;
  }

  const degrees = new Uint32Array(nodeCount);
  for (const key of directed.keys()) {
    const comma = key.indexOf(",");
    const a = Number(key.slice(0, comma));
    degrees[a]!++;
  }

  const rowOffsets = new Uint32Array(nodeCount + 1);
  let sum = 0;
  for (let i = 0; i < nodeCount; i++) {
    rowOffsets[i] = sum;
    sum += degrees[i]!;
  }
  rowOffsets[nodeCount] = sum;
  const edgeCount = sum;
  const edgeTo = new Uint32Array(edgeCount);
  const edgeTime = new Float64Array(edgeCount);
  const cursor = rowOffsets.slice() as Uint32Array;

  for (const [key, t] of directed) {
    const comma = key.indexOf(",");
    const a = Number(key.slice(0, comma));
    const b = Number(key.slice(comma + 1));
    const slot = cursor[a]!;
    cursor[a] = slot + 1;
    edgeTo[slot] = b;
    edgeTime[slot] = t;
  }

  return {
    graph: { nodeCount, nodeX, nodeY, rowOffsets, edgeTo, edgeTime },
    pohiSegments,
  };
}

function pass2Feature(
  f: Feature,
  keyToId: Map<string, number>,
  directed: Map<string, number>,
  speedMultiplier: number,
  groundSpeedsKmh: Record<number, number> | undefined,
): void {
  const geom = f.geometry;
  if (!geom || geom.type !== "LineString") return;
  const line = geom as LineString;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const tyyp = props.tyyp as number | undefined;
  const teekate = props.teekate as number | undefined;
  const restricted = isRestrictedTyyp(tyyp);
  const mps = speedMpsFromTeekate(teekate, speedMultiplier, groundSpeedsKmh);
  const coords = line.coordinates;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = parsePosition(coords[i]!);
    const [x1, y1] = parsePosition(coords[i + 1]!);
    const id0 = keyToId.get(coordKey(x0, y0))!;
    const id1 = keyToId.get(coordKey(x1, y1))!;
    const dist = euclideanM(x0, y0, x1, y1);
    const time = restricted ? Number.POSITIVE_INFINITY : dist / mps;
    addDirected(directed, id0, id1, time);
    addDirected(directed, id1, id0, time);
  }
}

function addDirected(
  directed: Map<string, number>,
  a: number,
  b: number,
  t: number,
): void {
  if (a === b || !Number.isFinite(t) || t < 0) return;
  const k = `${a},${b}`;
  const prev = directed.get(k);
  if (prev === undefined || t < prev) directed.set(k, t);
}

export function buildGraphFromGeoJson(
  fc: FeatureCollection,
  options: BuildGraphOptions = {},
): BuildGraphResult {
  const speedMultiplier = options.speedMultiplier ?? 1;
  const groundSpeedsKmh = options.groundSpeedsKmh;
  const keys = new Set<string>();
  const pohiSegments: Segment2D[] = [];
  for (const f of fc.features) pass1Feature(f, keys, pohiSegments);

  const keyToId = new Map<string, number>();
  let nid = 0;
  for (const k of keys) keyToId.set(k, nid++);

  const directed = new Map<string, number>();
  for (const f of fc.features)
    pass2Feature(f, keyToId, directed, speedMultiplier, groundSpeedsKmh);

  return finalizeGraphFromKeysAndDirected(keys, directed, pohiSegments);
}

export async function buildGraphFromEtakPages(
  rawDir: string,
  options: BuildGraphOptions = {},
): Promise<BuildGraphResult> {
  const speedMultiplier = options.speedMultiplier ?? 1;
  const groundSpeedsKmh = options.groundSpeedsKmh;
  const files = (await readdir(rawDir))
    .filter((n) => /^page-\d+\.json$/.test(n))
    .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)));
  if (files.length === 0) {
    throw new Error(`No page-*.json files in ${rawDir}`);
  }

  const keys = new Set<string>();
  const pohiSegments: Segment2D[] = [];

  for (const name of files) {
    const fc = JSON.parse(
      await readFile(join(rawDir, name), "utf8"),
    ) as FeatureCollection;
    for (const f of fc.features) pass1Feature(f, keys, pohiSegments);
  }

  const keyToId = new Map<string, number>();
  let nid = 0;
  for (const k of keys) keyToId.set(k, nid++);

  const directed = new Map<string, number>();
  for (const name of files) {
    const fc = JSON.parse(
      await readFile(join(rawDir, name), "utf8"),
    ) as FeatureCollection;
    for (const f of fc.features)
      pass2Feature(f, keyToId, directed, speedMultiplier, groundSpeedsKmh);
  }

  return finalizeGraphFromKeysAndDirected(keys, directed, pohiSegments);
}
