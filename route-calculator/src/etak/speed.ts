import { Teekate } from "./types.js";

/** Base walking speed in km/h by teekate code (ETAK surface type). */
export const DEFAULT_GROUND_SPEEDS_KMH: Record<number, number> = {
  [Teekate.Pusikate]: 5.0,
  [Teekate.Kruuskate]: 4.0,
  [Teekate.Pinnatud]: 4.5,
  [Teekate.Pinnas]: 3.5,
};

/**
 * @param groundSpeedsKmh Optional partial overrides (km/h); merged with {@link DEFAULT_GROUND_SPEEDS_KMH}.
 */
export function speedMpsFromTeekate(
  teekate: number | null | undefined,
  multiplier: number,
  groundSpeedsKmh?: Record<number, number>,
): number {
  const speeds = groundSpeedsKmh
    ? { ...DEFAULT_GROUND_SPEEDS_KMH, ...groundSpeedsKmh }
    : DEFAULT_GROUND_SPEEDS_KMH;
  const defaultMps = (speeds[Teekate.Kruuskate] ?? 4.0) / 3.6;
  const base =
    teekate != null && speeds[teekate] != null
      ? speeds[teekate]! / 3.6
      : defaultMps;
  return base * multiplier;
}
