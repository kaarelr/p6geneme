import { readFile, writeFile } from "node:fs/promises";
import { GRAPH_VERSION, type CompactGraph } from "./types.js";

const GRAPH_MAGIC = Buffer.from("ETK1");

function u32(buf: Buffer, o: number): number {
  return buf.readUInt32LE(o);
}

function writeU32(buf: Buffer, o: number, v: number): void {
  buf.writeUInt32LE(v >>> 0, o);
}

export async function writeGraphBin(path: string, g: CompactGraph): Promise<void> {
  const headerSize = 4 + 4 + 4 + 4;
  const nc = g.nodeCount;
  const ec = g.edgeTo.length;
  const size =
    headerSize +
    nc * 8 * 2 +
    (nc + 1) * 4 +
    ec * 4 +
    ec * 8;
  const buf = Buffer.allocUnsafe(size);
  let o = 0;
  GRAPH_MAGIC.copy(buf, o);
  o += 4;
  writeU32(buf, o, GRAPH_VERSION);
  o += 4;
  writeU32(buf, o, nc);
  o += 4;
  writeU32(buf, o, ec);
  o += 4;
  for (let i = 0; i < nc; i++) {
    buf.writeDoubleLE(g.nodeX[i]!, o);
    o += 8;
  }
  for (let i = 0; i < nc; i++) {
    buf.writeDoubleLE(g.nodeY[i]!, o);
    o += 8;
  }
  for (let i = 0; i <= nc; i++) {
    writeU32(buf, o, g.rowOffsets[i]!);
    o += 4;
  }
  for (let i = 0; i < ec; i++) {
    writeU32(buf, o, g.edgeTo[i]!);
    o += 4;
  }
  for (let i = 0; i < ec; i++) {
    buf.writeDoubleLE(g.edgeTime[i]!, o);
    o += 8;
  }
  await writeFile(path, buf);
}

export async function readGraphBin(path: string): Promise<CompactGraph> {
  const buf = await readFile(path);
  if (buf.length < 16 || !buf.subarray(0, 4).equals(GRAPH_MAGIC)) {
    throw new Error(`Invalid graph file: ${path}`);
  }
  let o = 4;
  const ver = u32(buf, o);
  o += 4;
  if (ver !== GRAPH_VERSION) throw new Error(`Unsupported graph version ${ver}`);
  const nc = u32(buf, o);
  o += 4;
  const ec = u32(buf, o);
  o += 4;
  const nodeX = new Float64Array(nc);
  const nodeY = new Float64Array(nc);
  for (let i = 0; i < nc; i++) {
    nodeX[i] = buf.readDoubleLE(o);
    o += 8;
  }
  for (let i = 0; i < nc; i++) {
    nodeY[i] = buf.readDoubleLE(o);
    o += 8;
  }
  const rowOffsets = new Uint32Array(nc + 1);
  for (let i = 0; i <= nc; i++) {
    rowOffsets[i] = u32(buf, o);
    o += 4;
  }
  const edgeTo = new Uint32Array(ec);
  for (let i = 0; i < ec; i++) {
    edgeTo[i] = u32(buf, o);
    o += 4;
  }
  const edgeTime = new Float64Array(ec);
  for (let i = 0; i < ec; i++) {
    edgeTime[i] = buf.readDoubleLE(o);
    o += 8;
  }
  return { nodeCount: nc, nodeX, nodeY, rowOffsets, edgeTo, edgeTime };
}
