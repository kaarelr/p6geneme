import proj4 from "proj4";

/** EPSG:3301 (L-EST97 / Estonia TM) — false northing 6_375_000 m per epsg.io */
proj4.defs(
  "EPSG:3301",
  "+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 +lat_2=58 +x_0=500000 +y_0=6375000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);

export function wgs84ToEpsg3301(lon: number, lat: number): [number, number] {
  return proj4("WGS84", "EPSG:3301", [lon, lat]) as [number, number];
}

export function epsg3301ToWgs84(x: number, y: number): [number, number] {
  return proj4("EPSG:3301", "WGS84", [x, y]) as [number, number];
}
