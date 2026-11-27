/** Seeded inputs, so a failure reproduces. */

/** mulberry32: a uniform float in [0, 1) per call. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [0, limit). */
export function below(next: () => number, limit: number): number {
  return Math.floor(next() * limit);
}
