export interface CompactGraph {
  nodeCount: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  rowOffsets: Uint32Array;
  edgeTo: Uint32Array;
  edgeTime: Float64Array;
}

/** v2 adds edgeDist + edgeTeekate after edgeTime for fast reweighting */
export const GRAPH_VERSION = 2;
