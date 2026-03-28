import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection } from "geojson";
import { PATHS } from "../src/config.js";
import {
  buildGraphFromEtakPages,
  buildGraphFromGeoJson,
  writeEtakEdgeCache,
} from "../src/graph/builder.js";
import { writeGraphBin } from "../src/graph/graph-io.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/** JSON object keyed by teekate code string, values km/h (e.g. `{"10":5,"20":4}`). */
function parseGroundSpeedsKmhEnv(raw: string | undefined): Record<number, number> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GROUND_SPEEDS_KMH must be a JSON object");
  }
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const nk = Number(k);
    const nv = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(nk) || !Number.isFinite(nv)) continue;
    out[nk] = nv;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function main(): Promise<void> {
  const mergedPath = join(root, PATHS.etakMerged);
  const rawDir = join(root, PATHS.etakRawDir);
  const graphPath = join(root, PATHS.graphBin);
  const pohiPath = join(root, "data/pohi-segments.json");
  const edgeCachePath = join(root, PATHS.etakEdgesBin);
  const mult = Number.parseFloat(process.env.SPEED_MULTIPLIER ?? "1") || 1;
  const groundSpeedsKmh = parseGroundSpeedsKmhEnv(process.env.GROUND_SPEEDS_KMH);

  const buildOpts = {
    speedMultiplier: mult,
    ...(groundSpeedsKmh !== undefined ? { groundSpeedsKmh } : {}),
  };

  const usePages = existsSync(join(rawDir, "page-0.json"));
  const built = usePages
    ? await buildGraphFromEtakPages(rawDir, buildOpts)
    : await (async () => {
        const raw = await readFile(mergedPath, "utf8");
        const fc = JSON.parse(raw) as FeatureCollection;
        return buildGraphFromGeoJson(fc, buildOpts);
      })();

  const { graph, pohiSegments, edgeDist, edgeTeekate, segmentRecords } = built;

  await mkdir(dirname(graphPath), { recursive: true });
  await writeGraphBin(graphPath, graph, { edgeDist, edgeTeekate });
  await writeFile(pohiPath, JSON.stringify(pohiSegments), "utf8");
  if (segmentRecords && segmentRecords.length > 0) {
    await mkdir(dirname(edgeCachePath), { recursive: true });
    await writeEtakEdgeCache(edgeCachePath, segmentRecords);
  }
  console.error(
    `Graph: ${graph.nodeCount} nodes, ${graph.edgeTo.length} directed edges -> ${PATHS.graphBin}`,
  );
  console.error(`Highway segments: ${pohiSegments.length} -> data/pohi-segments.json`);
  if (segmentRecords && segmentRecords.length > 0) {
    console.error(`Edge cache: ${segmentRecords.length} segments -> ${PATHS.etakEdgesBin}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
