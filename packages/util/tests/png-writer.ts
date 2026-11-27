/**
 * A PNG writer for test inputs in every color type and bit depth, with a
 * palette, a transparent color, or Adam7 interlacing. `@napi-rs/image` writes
 * 8-bit RGBA only, and the decoders must agree on everything else too.
 */

import { crc32, deflateSync } from 'node:zlib';

/** A PNG's header fields and its raw samples, packed the way the color type and depth say. */
export interface PngSpec {
  readonly width: number;
  readonly height: number;
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  readonly bitDepth: 1 | 2 | 4 | 8 | 16;
  /** One sample value per channel per pixel, rows top to bottom; for color type 3, palette indexes. */
  readonly samples: readonly number[];
  readonly palette?: readonly (readonly [number, number, number])[];
  /** `tRNS`: per-palette-entry alpha for type 3, one gray level for type 0, one RGB triple for type 2. */
  readonly transparent?: readonly number[];
  readonly interlaced?: boolean;
}

const CHANNELS: Record<PngSpec['colorType'], number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Packs rows of samples (each row starting a fresh byte) with filter byte 0. */
function packRows(spec: PngSpec, pixels: readonly number[][]): number[] {
  const out: number[] = [];
  for (const row of pixels) {
    out.push(0);
    if (spec.bitDepth === 16) {
      for (const sample of row) out.push(sample >> 8, sample & 255);
      continue;
    }
    if (spec.bitDepth === 8) {
      out.push(...row);
      continue;
    }
    let byte = 0;
    let used = 0;
    for (const sample of row) {
      byte = (byte << spec.bitDepth) | sample;
      used += spec.bitDepth;
      if (used === 8) {
        out.push(byte);
        byte = 0;
        used = 0;
      }
    }
    if (used > 0) out.push(byte << (8 - used));
  }
  return out;
}

const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** Encodes `spec` as PNG bytes. */
export function writePng(spec: PngSpec): Uint8Array {
  const channels = CHANNELS[spec.colorType];
  const rowOf = (y: number, xs: readonly number[]): number[] => xs.flatMap((x) => spec.samples.slice((y * spec.width + x) * channels, (y * spec.width + x + 1) * channels));
  let raw: number[] = [];
  if (spec.interlaced === true) {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const xs: number[] = [];
      for (let x = x0; x < spec.width; x += dx) xs.push(x);
      if (xs.length === 0) continue;
      const rows: number[][] = [];
      for (let y = y0; y < spec.height; y += dy) rows.push(rowOf(y, xs));
      raw = raw.concat(packRows(spec, rows));
    }
  } else {
    const xs = Array.from({ length: spec.width }, (_, x) => x);
    raw = packRows(spec, Array.from({ length: spec.height }, (_, y) => rowOf(y, xs)));
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, spec.width);
  view.setUint32(4, spec.height);
  header.set([spec.bitDepth, spec.colorType, 0, 0, spec.interlaced === true ? 1 : 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header)];
  if (spec.palette !== undefined) parts.push(chunk('PLTE', new Uint8Array(spec.palette.flat())));
  if (spec.transparent !== undefined) {
    const values = spec.colorType === 3 ? spec.transparent : spec.transparent.flatMap((value) => [value >> 8, value & 255]);
    parts.push(chunk('tRNS', new Uint8Array(values)));
  }
  parts.push(chunk('IDAT', deflateSync(new Uint8Array(raw))), chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}
