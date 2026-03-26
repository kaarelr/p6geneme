import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection } from "geojson";
import { PATHS } from "../src/config.js";
import { buildGraphFromEtakPages, buildGraphFromGeoJson } from "../src/graph/builder.js";
import { writeGraphBin } from "../src/graph/graph-io.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function main(): Promise<void> {
  const mergedPath = join(root, PATHS.etakMerged);
  const rawDir = join(root, PATHS.etakRawDir);
  const graphPath = join(root, PATHS.graphBin);
  const pohiPath = join(root, "data/pohi-segments.json");
  const mult = Number.parseFloat(process.env.SPEED_MULTIPLIER ?? "1") || 1;

  const usePages = existsSync(join(rawDir, "page-0.json"));
  const { graph, pohiSegments } = usePages
    ? await buildGraphFromEtakPages(rawDir, { speedMultiplier: mult })
    : await (async () => {
        const raw = await readFile(mergedPath, "utf8");
        const fc = JSON.parse(raw) as FeatureCollection;
        return buildGraphFromGeoJson(fc, { speedMultiplier: mult });
      })();

  await mkdir(dirname(graphPath), { recursive: true });
  await writeGraphBin(graphPath, graph);
  await writeFile(pohiPath, JSON.stringify(pohiSegments), "utf8");
  console.error(
    `Graph: ${graph.nodeCount} nodes, ${graph.edgeTo.length} directed edges -> ${PATHS.graphBin}`,
  );
  console.error(`Põhimaantee segments: ${pohiSegments.length} -> data/pohi-segments.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
