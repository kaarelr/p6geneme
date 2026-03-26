/** ETAK road type codes (tyyp) */
export const Tyyp = {
  Pohimaantee: 10,
  Ramp: 15,
  Tugimaantee: 20,
  Korvalmaantee: 30,
  Uhendustee: 40,
  Tanav: 50,
  MuuTee: 60,
  Rada: 70,
  Kergliiklustee: 80,
} as const;

/** ETAK surface codes (teekate) */
export const Teekate = {
  Pusikate: 10,
  Kruuskate: 20,
  Pinnatud: 30,
  Pinnas: 40,
} as const;

export function isRestrictedTyyp(tyyp: number | null | undefined): boolean {
  return tyyp === Tyyp.Pohimaantee || tyyp === Tyyp.Kergliiklustee;
}
