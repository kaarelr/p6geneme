import { createWriteStream } from "node:fs";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import type { FeatureCollection } from "geojson";
import { ETAK_WFS, PATHS, WFS_PAGE_SIZE } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const MAX_RETRIES = 5;
const RETRY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(startIndex: number, bbox?: string): Promise<FeatureCollection> {
  const bboxParam = bbox ? `&BBOX=${bbox},EPSG:3301` : "";
  const url = `${ETAK_WFS}&count=${WFS_PAGE_SIZE}&startIndex=${startIndex}${bboxParam}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return (await res.json()) as FeatureCollection;
    } catch (e) {
      lastErr = e;
      await sleep(RETRY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

function writeChunk(ws: ReturnType<typeof createWriteStream>, s: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = ws.write(s, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else ws.once("drain", resolve);
  });
}

/** Stream one GeoJSON FeatureCollection without holding all features in memory */
async function streamMergePagesToGeoJson(
  rawDir: string,
  mergedPath: string,
): Promise<number> {
  const files = (await readdir(rawDir))
    .filter((n) => /^page-\d+\.json$/.test(n))
    .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)));
  const ws = createWriteStream(mergedPath, { encoding: "utf8" });
  let count = 0;
  let first = true;
  await writeChunk(ws, '{"type":"FeatureCollection","features":[\n');
  for (const name of files) {
    const fc = JSON.parse(
      await readFile(join(rawDir, name), "utf8"),
    ) as FeatureCollection;
    for (const f of fc.features) {
      await writeChunk(ws, first ? JSON.stringify(f) : `,\n${JSON.stringify(f)}`);
      first = false;
      count++;
    }
  }
  await writeChunk(ws, "\n]}\n");
  ws.end();
  await finished(ws);
  return count;
}

async function main(): Promise<void> {
  const rawDir = join(root, PATHS.etakRawDir);
  const mergedPath = join(root, PATHS.etakMerged);
  const checkpointPath = join(root, PATHS.checkpoint);
  await mkdir(rawDir, { recursive: true });

  const bbox = process.env.ETAK_BBOX?.trim();
  let startIndex = 0;
  try {
    const cp = await readFile(checkpointPath, "utf8");
    startIndex = Number.parseInt(cp.trim(), 10) || 0;
    console.error(`Resuming from startIndex=${startIndex}`);
  } catch {
    startIndex = 0;
  }

  for (;;) {
    console.error(`Fetching startIndex=${startIndex} ...`);
    const page = await fetchPage(startIndex, bbox);
    const feats = page.features ?? [];
    if (feats.length === 0) break;
    await writeFile(
      join(rawDir, `page-${startIndex}.json`),
      JSON.stringify(page),
      "utf8",
    );
    startIndex += feats.length;
    await writeFile(checkpointPath, String(startIndex), "utf8");
    if (feats.length < WFS_PAGE_SIZE) break;
    await sleep(150);
  }

  await mkdir(dirname(mergedPath), { recursive: true });
  const n = await streamMergePagesToGeoJson(rawDir, mergedPath);
  console.error(`Wrote ${n} features (streamed) to ${PATHS.etakMerged}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
