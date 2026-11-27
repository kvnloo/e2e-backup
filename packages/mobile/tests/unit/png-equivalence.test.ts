/** The masking `@e2e-dev/util` does against the JavaScript it replaced: the same PNG bytes for every layout and every rectangle, fractional, negative, and past the edge. */

import { describe, expect, it } from 'vitest';
import { maskPng } from '../../src/png.ts';
import { rawPng } from '../helpers/png.ts';
import { previousMaskPng } from '../helpers/previous-mask.ts';

/** mulberry32: a uniform float in [0, 1) per call. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('maskPng', () => {
  it('writes the bytes the previous masking wrote', async () => {
    const next = random(3);
    const layouts = [[8, 0, 1], [8, 4, 2], [8, 2, 3], [8, 6, 4], [16, 2, 3], [16, 6, 4]] as const;
    for (let round = 0; round < 120; round += 1) {
      const [depth, colorType, channels] = layouts[round % layouts.length]!;
      const width = 1 + Math.floor(next() * 40);
      const height = 1 + Math.floor(next() * 40);
      const rows = Array.from({ length: height }, () => Array.from({ length: width * channels * (depth / 8) }, () => Math.floor(next() * 256)));
      const bytes = rawPng(width, height, depth, colorType, rows);
      const coordinate = (limit: number): number => (next() * 1.4 - 0.2) * limit;
      const rects = Array.from({ length: 1 + Math.floor(next() * 4) }, () => ({ x: coordinate(width), y: coordinate(height), width: next() * width, height: next() * height }));
      expect(Buffer.from(await maskPng(bytes, rects)).equals(Buffer.from(previousMaskPng(bytes, rects))), `round ${round}`).toBe(true);
    }
  });
});
