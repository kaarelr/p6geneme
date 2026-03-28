import { readdir, readFile, writeFile } from "node:fs/promises";
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
  /** If true (default), collect rows for `data/etak-edges.bin` during ETAK/GeoJSON builds */
  collectSegmentRecords?: boolean;
}

export interface BuildGraphResult {
  graph: CompactGraph;
  pohiSegments: Segment2D[];
  edgeDist: Float64Array;
  edgeTeekate: Int32Array;
  /** Present when built from GeoJSON/pages with `collectSegmentRecords` */
  segmentRecords?: EtakSegmentRecord[];
}

/** One road segment for `etak-edges.bin` (EPSG:3301 coordinates). */
export interface EtakSegmentRecord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tyyp: number;
  teekate: number;
}

interface DirectedMeta {
  time: number;
  dist: number;
  teekate: number;
}

const EDGE_CACHE_MAGIC = Buffer.from("ETEC");
const EDGE_CACHE_VERSION = 1;
/** Per record: 4×f64 + 2×i32 = 40 bytes */
const EDGE_RECORD_BYTES = 40;

function getOrCreateId(keyToId: Map<string, number>, k: string): number {
  let id = keyToId.get(k);
  if (id === undefined) {
    id = keyToId.size;
    keyToId.set(k, id);
  }
  return id;
}

/**
 * Precompute speed lookup: one object spread total instead of per-call.
 * Only ~4 distinct teekate codes exist, so the cache stays tiny.
 */
function cachedSpeedLookup(
  mult: number,
  groundSpeedsKmh?: Record<number, number>,
): (teekate: number | undefined) => number {
  const cache = new Map<number | undefined, number>();
  return (teekate: number | undefined): number => {
    let v = cache.get(teekate);
    if (v === undefined) {
      v = speedMpsFromTeekate(teekate, mult, groundSpeedsKmh);
      cache.set(teekate, v);
    }
    return v;
  };
}

function addDirected(
  directed: Map<string, DirectedMeta>,
  a: number,
  b: number,
  dist: number,
  time: number,
  teekate: number,
): void {
  if (a === b || !Number.isFinite(time) || time < 0) return;
  const k = `${a},${b}`;
  const prev = directed.get(k);
  if (prev === undefined || time < prev.time) {
    directed.set(k, { time, dist, teekate });
  }
}

function processFeature(
  f: Feature,
  keyToId: Map<string, number>,
  directed: Map<string, DirectedMeta>,
  pohiSegments: Segment2D[],
  speedMultiplier: number,
  groundSpeedsKmh: Record<number, number> | undefined,
  segmentRecords: EtakSegmentRecord[] | null,
): void {
  const geom = f.geometry;
  if (!geom || geom.type !== "LineString") return;
  const line = geom as LineString;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const tyyp = props.tyyp as number | undefined;
  const teekateRaw = props.teekate;
  const teekateNum =
    teekateRaw === null || teekateRaw === undefined
      ? -1
      : Number(teekateRaw);
  const teekate = Number.isFinite(teekateNum) ? teekateNum : -1;

  for (const p of line.coordinates) {
    const [x, y] = parsePosition(p);
    getOrCreateId(keyToId, coordKey(x, y));
  }

  if (tyyp === Tyyp.Pohimaantee) {
    const coords = line.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = parsePosition(coords[i]!);
      const [bx, by] = parsePosition(coords[i + 1]!);
      pohiSegments.push({ ax, ay, bx, by });
    }
  }

  const restricted = isRestrictedTyyp(tyyp);
  const mps = speedMpsFromTeekate(
    teekate >= 0 ? teekate : undefined,
    speedMultiplier,
    groundSpeedsKmh,
  );
  const coords = line.coordinates;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = parsePosition(coords[i]!);
    const [x1, y1] = parsePosition(coords[i + 1]!);
    const id0 = keyToId.get(coordKey(x0, y0))!;
    const id1 = keyToId.get(coordKey(x1, y1))!;
    const dist = euclideanM(x0, y0, x1, y1);
    const time = restricted ? Number.POSITIVE_INFINITY : dist / mps;
    const tkStore = restricted ? -1 : teekate;
    addDirected(directed, id0, id1, dist, time, tkStore);
    addDirected(directed, id1, id0, dist, time, tkStore);
    if (segmentRecords !== null) {
      segmentRecords.push({
        x0,
        y0,
        x1,
        y1,
        tyyp: tyyp ?? -1,
        teekate: teekate >= 0 ? teekate : -1,
      });
    }
  }
}

function finalizeFromKeyToId(
  keyToId: Map<string, number>,
  directed: Map<string, DirectedMeta>,
  pohiSegments: Segment2D[],
): BuildGraphResult {
  const nodeCount = keyToId.size;
  const keysById = new Array<string>(nodeCount);
  for (const [k, id] of keyToId) {
    keysById[id] = k;
  }

  const nodeX = new Float64Array(nodeCount);
  const nodeY = new Float64Array(nodeCount);
  for (let id = 0; id < nodeCount; id++) {
    const k = keysById[id]!;
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
  const edgeDist = new Float64Array(edgeCount);
  const edgeTeekate = new Int32Array(edgeCount);
  const cursor = rowOffsets.slice() as Uint32Array;

  for (const [key, meta] of directed) {
    const comma = key.indexOf(",");
    const a = Number(key.slice(0, comma));
    const b = Number(key.slice(comma + 1));
    const slot = cursor[a]!;
    cursor[a] = slot + 1;
    edgeTo[slot] = b;
    edgeTime[slot] = meta.time;
    edgeDist[slot] = meta.dist;
    edgeTeekate[slot] = meta.teekate;
  }

  return {
    graph: { nodeCount, nodeX, nodeY, rowOffsets, edgeTo, edgeTime },
    pohiSegments,
    edgeDist,
    edgeTeekate,
  };
}

function attachSegmentRecords(
  result: BuildGraphResult,
  segmentRecords: EtakSegmentRecord[] | null,
): BuildGraphResult {
  if (segmentRecords !== null && segmentRecords.length > 0) {
    return { ...result, segmentRecords };
  }
  return result;
}

export function reweightGraph(
  graph: CompactGraph,
  edgeDist: Float64Array,
  edgeTeekate: Int32Array,
  options: BuildGraphOptions,
): void {
  const mult = options.speedMultiplier ?? 1;
  const getMps = cachedSpeedLookup(mult, options.groundSpeedsKmh);
  const ec = graph.edgeTime.length;
  for (let e = 0; e < ec; e++) {
    const tk = edgeTeekate[e]!;
    graph.edgeTime[e] =
      edgeDist[e]! / getMps(tk >= 0 ? tk : undefined);
  }
}

export async function writeEtakEdgeCache(
  path: string,
  records: EtakSegmentRecord[],
): Promise<void> {
  const header = 4 + 4 + 4;
  const buf = Buffer.allocUnsafe(header + records.length * EDGE_RECORD_BYTES);
  let o = 0;
  EDGE_CACHE_MAGIC.copy(buf, o);
  o += 4;
  buf.writeUInt32LE(EDGE_CACHE_VERSION, o);
  o += 4;
  buf.writeUInt32LE(records.length >>> 0, o);
  o += 4;
  for (const r of records) {
    buf.writeDoubleLE(r.x0, o);
    o += 8;
    buf.writeDoubleLE(r.y0, o);
    o += 8;
    buf.writeDoubleLE(r.x1, o);
    o += 8;
    buf.writeDoubleLE(r.y1, o);
    o += 8;
    buf.writeInt32LE(r.tyyp | 0, o);
    o += 4;
    buf.writeInt32LE(r.teekate | 0, o);
    o += 4;
  }
  await writeFile(path, buf);
}

/**
 * Rebuild graph from compact segment cache (no JSON parse).
 * Single pass over a flat buffer — no intermediate JS objects.
 */
export async function buildGraphFromEdgeCache(
  cachePath: string,
  options: BuildGraphOptions = {},
): Promise<BuildGraphResult> {
  const buf = await readFile(cachePath);
  if (buf.length < 12 || !buf.subarray(0, 4).equals(EDGE_CACHE_MAGIC)) {
    throw new Error("Invalid etak-edges.bin magic");
  }
  const ver = buf.readUInt32LE(4);
  if (ver !== EDGE_CACHE_VERSION) {
    throw new Error(`Unsupported etak-edges version ${ver}`);
  }
  const count = buf.readUInt32LE(8);
  const bodyStart = 12;
  if (bodyStart + count * EDGE_RECORD_BYTES > buf.length) {
    throw new Error("Truncated etak-edges.bin");
  }

  const getMps = cachedSpeedLookup(
    options.speedMultiplier ?? 1,
    options.groundSpeedsKmh,
  );
  const keyToId = new Map<string, number>();
  const directed = new Map<string, DirectedMeta>();
  const pohiSegments: Segment2D[] = [];

  for (let i = 0; i < count; i++) {
    const off = bodyStart + i * EDGE_RECORD_BYTES;
    const x0 = buf.readDoubleLE(off);
    const y0 = buf.readDoubleLE(off + 8);
    const x1 = buf.readDoubleLE(off + 16);
    const y1 = buf.readDoubleLE(off + 24);
    const tyyp = buf.readInt32LE(off + 32);
    const teekate = buf.readInt32LE(off + 36);

    const id0 = getOrCreateId(keyToId, coordKey(x0, y0));
    const id1 = getOrCreateId(keyToId, coordKey(x1, y1));
    const dist = euclideanM(x0, y0, x1, y1);
    const restricted = isRestrictedTyyp(tyyp);
    const mps = getMps(teekate >= 0 ? teekate : undefined);
    const time = restricted ? Number.POSITIVE_INFINITY : dist / mps;
    const tkStore = restricted ? -1 : teekate;
    addDirected(directed, id0, id1, dist, time, tkStore);
    addDirected(directed, id1, id0, dist, time, tkStore);
    if (tyyp === Tyyp.Pohimaantee) {
      pohiSegments.push({ ax: x0, ay: y0, bx: x1, by: y1 });
    }
  }

  return finalizeFromKeyToId(keyToId, directed, pohiSegments);
}

export function buildGraphFromGeoJson(
  fc: FeatureCollection,
  options: BuildGraphOptions = {},
): BuildGraphResult {
  const speedMultiplier = options.speedMultiplier ?? 1;
  const groundSpeedsKmh = options.groundSpeedsKmh;
  const collect = options.collectSegmentRecords !== false;
  const keyToId = new Map<string, number>();
  const directed = new Map<string, DirectedMeta>();
  const pohiSegments: Segment2D[] = [];
  const segmentRecords: EtakSegmentRecord[] | null = collect ? [] : null;

  for (const f of fc.features) {
    processFeature(
      f,
      keyToId,
      directed,
      pohiSegments,
      speedMultiplier,
      groundSpeedsKmh,
      segmentRecords,
    );
  }

  return attachSegmentRecords(
    finalizeFromKeyToId(keyToId, directed, pohiSegments),
    segmentRecords,
  );
}

export async function buildGraphFromEtakPages(
  rawDir: string,
  options: BuildGraphOptions = {},
): Promise<BuildGraphResult> {
  const speedMultiplier = options.speedMultiplier ?? 1;
  const groundSpeedsKmh = options.groundSpeedsKmh;
  const collect = options.collectSegmentRecords !== false;
  const files = (await readdir(rawDir))
    .filter((n) => /^page-\d+\.json$/.test(n))
    .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)));
  if (files.length === 0) {
    throw new Error(`No page-*.json files in ${rawDir}`);
  }

  const keyToId = new Map<string, number>();
  const directed = new Map<string, DirectedMeta>();
  const pohiSegments: Segment2D[] = [];
  const segmentRecords: EtakSegmentRecord[] | null = collect ? [] : null;

  for (const name of files) {
    const fc = JSON.parse(
      await readFile(join(rawDir, name), "utf8"),
    ) as FeatureCollection;
    for (const f of fc.features) {
      processFeature(
        f,
        keyToId,
        directed,
        pohiSegments,
        speedMultiplier,
        groundSpeedsKmh,
        segmentRecords,
      );
    }
  }

  return attachSegmentRecords(
    finalizeFromKeyToId(keyToId, directed, pohiSegments),
    segmentRecords,
  );
}
