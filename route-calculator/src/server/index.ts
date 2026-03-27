import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  DEFAULT_TIME_BUDGET_S,
  PATHS,
  START_LAT,
  START_LON,
} from "../config.js";
import { buildGraphFromEtakPages, buildGraphFromGeoJson } from "../graph/builder.js";
import { readGraphBin } from "../graph/graph-io.js";
import type { CompactGraph } from "../graph/types.js";
import type { Segment2D } from "../geo/buffer.js";
import {
  ComputeRouteError,
  computeRouteFeatureCollection,
} from "../route/compute.js";

/** Project root for `data/` (defaults to cwd; set `DATA_ROOT` in production). */
function dataRoot(): string {
  return process.env.DATA_ROOT ?? process.cwd();
}

let graph: CompactGraph | null = null;
let pohiSegments: Segment2D[] = [];

async function loadGraphFromDisk(): Promise<void> {
  const root = dataRoot();
  const graphPath = join(root, PATHS.graphBin);
  graph = await readGraphBin(graphPath);
  const pohiPath = join(root, "data/pohi-segments.json");
  try {
    pohiSegments = JSON.parse(await readFile(pohiPath, "utf8")) as Segment2D[];
  } catch {
    pohiSegments = [];
  }
}

function parseGroundSpeedsKmh(
  raw: unknown,
): Record<number, number> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const nk = Number(k);
    const nv = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(nk) && Number.isFinite(nv)) out[nk] = nv;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function rebuildGraphFromDisk(
  groundSpeedsKmh?: Record<number, number>,
): Promise<void> {
  const root = dataRoot();
  const mergedPath = join(root, PATHS.etakMerged);
  const rawDir = join(root, PATHS.etakRawDir);
  const pohiPath = join(root, "data/pohi-segments.json");
  const mult = Number.parseFloat(process.env.SPEED_MULTIPLIER ?? "1") || 1;

  const buildOpts = {
    speedMultiplier: mult,
    ...(groundSpeedsKmh !== undefined ? { groundSpeedsKmh } : {}),
  };

  const usePages = existsSync(join(rawDir, "page-0.json"));
  const built = usePages
    ? await buildGraphFromEtakPages(rawDir, buildOpts)
    : await (async () => {
        const raw = await readFile(mergedPath, "utf8");
        const fc = JSON.parse(raw) as import("geojson").FeatureCollection;
        return buildGraphFromGeoJson(fc, buildOpts);
      })();

  graph = built.graph;
  pohiSegments = built.pohiSegments;
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(pohiPath, JSON.stringify(pohiSegments), "utf8");
}

function parseTimeBudgetS(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 60) return undefined;
  return n;
}

async function main(): Promise<void> {
  await loadGraphFromDisk();

  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const corsOriginsEnv = process.env.CORS_ORIGINS?.trim();
  await app.register(cors, {
    origin:
      corsOriginsEnv && corsOriginsEnv !== "*"
        ? corsOriginsEnv.split(",").map((s) => s.trim())
        : true,
  });

  app.get("/health", async () => ({ ok: true }));

  app.post<{
    Body: {
      timeBudgetS?: unknown;
      startLon?: unknown;
      startLat?: unknown;
    };
    Querystring: { timeBudgetS?: string };
  }>("/api/recompute-route", async (request, reply) => {
    if (!graph) {
      reply.code(503);
      return { ok: false as const, error: "Graph not loaded" };
    }

    let timeBudgetS = DEFAULT_TIME_BUDGET_S;
    const q = request.query.timeBudgetS;
    if (q !== undefined && q !== "") {
      const n = Number.parseFloat(q);
      if (Number.isFinite(n) && n >= 60) timeBudgetS = n;
    }
    const body = request.body;
    if (body?.timeBudgetS !== undefined) {
      const tb = parseTimeBudgetS(body.timeBudgetS);
      if (tb !== undefined) timeBudgetS = tb;
    }

    let startLon =
      Number.parseFloat(String(body?.startLon ?? "")) || START_LON;
    let startLat =
      Number.parseFloat(String(body?.startLat ?? "")) || START_LAT;
    if (body?.startLon !== undefined && body?.startLat !== undefined) {
      const lon = Number(body.startLon);
      const lat = Number(body.startLat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        startLon = lon;
        startLat = lat;
      }
    }

    try {
      const route = computeRouteFeatureCollection({
        graph,
        pohiSegments,
        startLon,
        startLat,
        timeBudgetS,
      });
      return { ok: true as const, route };
    } catch (e) {
      if (e instanceof ComputeRouteError) {
        reply.code(400);
        return { ok: false as const, error: e.message };
      }
      throw e;
    }
  });

  app.post<{
    Body: {
      groundSpeedsKmh?: unknown;
      timeBudgetS?: unknown;
      startLon?: unknown;
      startLat?: unknown;
    };
  }>("/api/rebuild-graph", async (request, reply) => {
    const body = request.body ?? {};
    const groundSpeedsKmh = parseGroundSpeedsKmh(body.groundSpeedsKmh);

    let timeBudgetS = DEFAULT_TIME_BUDGET_S;
    const tb = parseTimeBudgetS(body.timeBudgetS);
    if (tb !== undefined) timeBudgetS = tb;

    let startLon =
      Number.parseFloat(String(body.startLon ?? "")) || START_LON;
    let startLat =
      Number.parseFloat(String(body.startLat ?? "")) || START_LAT;
    if (body.startLon !== undefined && body.startLat !== undefined) {
      const lon = Number(body.startLon);
      const lat = Number(body.startLat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        startLon = lon;
        startLat = lat;
      }
    }

    try {
      await rebuildGraphFromDisk(groundSpeedsKmh);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reply.code(500);
      return { ok: false as const, error: msg };
    }

    if (!graph) {
      reply.code(500);
      return { ok: false as const, error: "Graph build produced no graph" };
    }

    try {
      const route = computeRouteFeatureCollection({
        graph,
        pohiSegments,
        startLon,
        startLat,
        timeBudgetS,
      });
      return { ok: true as const, route };
    } catch (e) {
      if (e instanceof ComputeRouteError) {
        reply.code(400);
        return { ok: false as const, error: e.message };
      }
      throw e;
    }
  });

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
