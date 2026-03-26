import { euclideanSq } from "../geo/distance.js";
import type { CompactGraph } from "./types.js";

export interface DijkstraResult {
  dist: Float64Array;
  parent: Int32Array;
}

/**
 * Single-source shortest paths. Edge weights must be non-negative; infinite weights are skipped.
 */
export function dijkstra(g: CompactGraph, start: number): DijkstraResult {
  const n = g.nodeCount;
  const dist = new Float64Array(n);
  const parent = new Int32Array(n);
  dist.fill(Number.POSITIVE_INFINITY);
  parent.fill(-1);
  dist[start] = 0;

  const heap: number[] = [];
  const pos = new Int32Array(n);
  pos.fill(-1);

  function swap(i: number, j: number): void {
    const ai = heap[i]!;
    const aj = heap[j]!;
    heap[i] = aj;
    heap[j] = ai;
    pos[ai] = j;
    pos[aj] = i;
  }

  function siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (dist[heap[i]!]! >= dist[heap[p]!]!) break;
      swap(i, p);
      i = p;
    }
  }

  function siftDown(i: number): void {
    const len = heap.length;
    for (;;) {
      let m = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < len && dist[heap[l]!]! < dist[heap[m]!]!) m = l;
      if (r < len && dist[heap[r]!]! < dist[heap[m]!]!) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  }

  function push(node: number): void {
    const i = heap.length;
    heap.push(node);
    pos[node] = i;
    siftUp(i);
  }

  function pop(): number {
    const top = heap[0]!;
    const last = heap.pop()!;
    pos[top] = -1;
    if (heap.length > 0) {
      heap[0] = last;
      pos[last] = 0;
      siftDown(0);
    }
    return top;
  }

  push(start);

  while (heap.length > 0) {
    const u = pop();
    const du = dist[u]!;
    const beg = g.rowOffsets[u]!;
    const end = g.rowOffsets[u + 1]!;
    for (let e = beg; e < end; e++) {
      const v = g.edgeTo[e]!;
      const w = g.edgeTime[e]!;
      if (!Number.isFinite(w) || w === Number.POSITIVE_INFINITY) continue;
      const nd = du + w;
      if (nd < dist[v]!) {
        dist[v] = nd;
        parent[v] = u;
        const pi = pos[v]!;
        if (pi >= 0) siftUp(pi);
        else push(v);
      }
    }
  }

  return { dist, parent };
}

export function findNearestNode(
  g: CompactGraph,
  x: number,
  y: number,
): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < g.nodeCount; i++) {
    const d = euclideanSq(x, y, g.nodeX[i]!, g.nodeY[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function bestNodeWithinBudget(
  g: CompactGraph,
  dist: Float64Array,
  budget: number,
  startX: number,
  startY: number,
): number {
  let best = -1;
  let bestR = -1;
  for (let i = 0; i < g.nodeCount; i++) {
    if (dist[i]! > budget) continue;
    const r = euclideanSq(startX, startY, g.nodeX[i]!, g.nodeY[i]!);
    if (r > bestR) {
      bestR = r;
      best = i;
    }
  }
  return best;
}

export function reconstructPath(parent: Int32Array, end: number): number[] {
  const out: number[] = [];
  let cur = end;
  while (cur >= 0) {
    out.push(cur);
    cur = parent[cur]!;
  }
  out.reverse();
  return out;
}
