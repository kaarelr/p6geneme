import { pointToSegmentDistanceM } from "./distance.js";

export type Segment2D = { ax: number; ay: number; bx: number; by: number };

export type HighwayProximityWarning = {
  /** Index of the first leg in this merged run */
  leg: number;
  midX: number;
  midY: number;
};

/** True if midpoint of segment AB is within `bufferM` of any põhimaantee segment */
export function midpointNearAnySegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  obstacles: Segment2D[],
  bufferM: number,
): boolean {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  for (const s of obstacles) {
    if (pointToSegmentDistanceM(mx, my, s.ax, s.ay, s.bx, s.by) <= bufferM) {
      return true;
    }
  }
  return false;
}

/**
 * One marker per contiguous run of path legs whose midpoint lies within `bufferM` of a põhimaantee
 * segment. Avoids dozens of stacked warnings when the route runs parallel to a highway.
 */
export function highwayProximityWarningsMerged(
  pathXy: [number, number][],
  pohi: Segment2D[],
  bufferM: number,
): HighwayProximityWarning[] {
  if (pathXy.length < 2 || pohi.length === 0) return [];

  const merged: HighwayProximityWarning[] = [];
  let runFirstLeg = 0;
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  function flush(): void {
    if (count === 0) return;
    merged.push({
      leg: runFirstLeg,
      midX: sumX / count,
      midY: sumY / count,
    });
    sumX = 0;
    sumY = 0;
    count = 0;
  }

  for (let i = 0; i < pathXy.length - 1; i++) {
    const [ax, ay] = pathXy[i]!;
    const [bx, by] = pathXy[i + 1]!;
    const near = midpointNearAnySegment(ax, ay, bx, by, pohi, bufferM);
    if (near) {
      if (count === 0) runFirstLeg = i;
      sumX += (ax + bx) / 2;
      sumY += (ay + by) / 2;
      count += 1;
    } else {
      flush();
    }
  }
  flush();
  return merged;
}
