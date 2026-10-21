/** Wilson score interval: honest error bars for small samples, unlike the normal approximation. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface Rate {
  value: number | null;
  num: number;
  den: number;
  ci: [number, number];
}

export function rate(num: number, den: number): Rate {
  return { value: den === 0 ? null : num / den, num, den, ci: wilson(num, den) };
}

export interface BinaryCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function binaryRates(c: BinaryCounts) {
  return {
    precision: rate(c.tp, c.tp + c.fp),
    recall: rate(c.tp, c.tp + c.fn),
    falseAlarmRate: rate(c.fp, c.fp + c.tn),
  };
}
