/** GPX 1.1 track for GPS devices and apps */

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Seconds since 2000-01-01T00:00:00.000Z (pseudo-epoch for cumulative walk time on track points). */
const GPX_TIME_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0, 0);

function cumulativeSecondsToGpxTime(offsetS: number): string {
  const d = new Date(GPX_TIME_EPOCH_MS + offsetS * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface RouteGpxRoadCrossing {
  lon: number;
  lat: number;
  name: string;
  sym: string;
}

export interface RouteGpxOptions {
  name: string;
  description?: string;
  /** App name for <gpx creator="..."> */
  creator?: string;
  /** WGS84 points in order [lon, lat] */
  coordinates: [number, number][];
  /** Cumulative travel time from route start (seconds), parallel to coordinates — emits <time> per trkpt */
  cumulativeTimeS?: number[];
  /** Road proximity / warning points as GPX waypoints */
  roadCrossings?: RouteGpxRoadCrossing[];
}

export function buildRouteGpx(options: RouteGpxOptions): string {
  const name = escXml(options.name);
  const desc = options.description ? escXml(options.description) : "";
  const creator = options.creator
    ? escXml(options.creator)
    : "p6geneme-route-calculator";

  const times = options.cumulativeTimeS;
  const hasTimes =
    Array.isArray(times) &&
    times.length === options.coordinates.length;

  const trkpts = options.coordinates
    .map(([lon, lat], i) => {
      const lo = Number(lon.toFixed(7));
      const la = Number(lat.toFixed(7));
      const timeEl =
        hasTimes && Number.isFinite(times[i]!)
          ? `\n        <time>${cumulativeSecondsToGpxTime(times[i]!)}</time>`
          : "";
      return `      <trkpt lat="${la}" lon="${lo}">${timeEl}\n      </trkpt>`;
    })
    .join("\n");

  const wpts = (options.roadCrossings ?? [])
    .map((w) => {
      const lo = Number(w.lon.toFixed(7));
      const la = Number(w.lat.toFixed(7));
      const wname = escXml(w.name);
      const wsym = escXml(w.sym);
      return `  <wpt lat="${la}" lon="${lo}">
    <name>${wname}</name>
    <sym>${wsym}</sym>
  </wpt>`;
    })
    .join("\n");

  const descBlock = desc
    ? `    <desc>${desc}</desc>\n`
    : "";

  const wptBlock = wpts ? `${wpts}\n` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
${descBlock}  </metadata>
${wptBlock}  <trk>
    <name>${name}</name>
${descBlock}    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}
