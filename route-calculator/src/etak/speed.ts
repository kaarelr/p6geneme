import { Teekate } from "./types.js";

/** Base walking speed in m/s by teekate code */
const TEEKATE_MPS: Record<number, number> = {
  [Teekate.Pusikate]: 5.0 / 3.6,
  [Teekate.Kruuskate]: 4.0 / 3.6,
  [Teekate.Pinnatud]: 4.5 / 3.6,
  [Teekate.Pinnas]: 3.5 / 3.6,
};

const DEFAULT_MPS = TEEKATE_MPS[Teekate.Kruuskate]!;

export function speedMpsFromTeekate(
  teekate: number | null | undefined,
  multiplier: number,
): number {
  const base =
    teekate != null && TEEKATE_MPS[teekate] != null
      ? TEEKATE_MPS[teekate]!
      : DEFAULT_MPS;
  return base * multiplier;
}
