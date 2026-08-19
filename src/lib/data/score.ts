import type { FlameCount } from "./types";

/**
 * Score bands, defined once.
 *
 * The badge, the flames and the "hot opportunity" count all draw the same two
 * lines through the score. Keeping them here means a lead cannot show three
 * flames in the table and a cold badge in its drawer.
 */
export const SCORE_BANDS = {
  /** Worth a message now. */
  hot: 70,
  /** Worth watching. */
  warm: 40,
} as const;

export function flamesFor(score: number): FlameCount {
  if (score >= SCORE_BANDS.hot) return 3;
  if (score >= SCORE_BANDS.warm) return 2;
  return 1;
}

export function bandFor(score: number): "hot" | "warm" | "cold" {
  if (score >= SCORE_BANDS.hot) return "hot";
  if (score >= SCORE_BANDS.warm) return "warm";
  return "cold";
}
