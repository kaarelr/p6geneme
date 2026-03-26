export interface CompactGraph {
  nodeCount: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  rowOffsets: Uint32Array;
  edgeTo: Uint32Array;
  edgeTime: Float64Array;
}

export const GRAPH_VERSION = 1;
