export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function speedLabel(rate: number) {
  return rate === 1 ? "Normal" : `${rate}×`;
}

/** The next preset up or down from `rate` (for the < and > keys). */
export function stepSpeed(rate: number, direction: -1 | 1) {
  if (direction === 1) return SPEEDS.find((speed) => speed > rate) ?? rate;
  return [...SPEEDS].reverse().find((speed) => speed < rate) ?? rate;
}
