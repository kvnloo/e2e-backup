/**
 * `@e2e-dev/util`: work that would block the JavaScript thread, done in Rust
 * (`crates/e2e-util`) on a native worker pool. Every pixel call returns a
 * Promise. A decoded image stays on the native side as a `NativeImage`, so a
 * caller that compares one image many times decodes it once and never copies
 * its pixels into JavaScript.
 */

import { binding, type ImageBox, type ImageSize, type ImageTolerance, type NativeImageHandle, type ProcessSteps, type RawComparison } from './native.ts';

export { NativeUtilUnavailableError, type ImageBox, type ImageSize, type ImageTolerance, type ProcessSteps } from './native.ts';

/** What comparing two images found. */
export type ImageComparison =
  | { readonly kind: 'match'; readonly diffPixels: number }
  | { readonly kind: 'size'; readonly expected: ImageBox; readonly actual: ImageBox }
  | { readonly kind: 'pixels'; readonly diffPixels: number; readonly ratio: number };

/** A native buffer's bytes as a plain `Uint8Array`, whose `slice` copies where a `Buffer`'s shares memory. */
function plain(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** An RGBA image held on the native side, 8 bits per channel. */
export class NativeImage {
  readonly #handle: NativeImageHandle;

  /** @internal Wraps the addon's image; use `decodePng`, `processPng`, or `NativeImage.fromRgba`. */
  constructor(handle: NativeImageHandle) {
    this.#handle = handle;
  }

  /** An image over a copy of `data`, `width * height` RGBA pixels. */
  static fromRgba(data: Uint8Array, width: number, height: number): NativeImage {
    return new NativeImage(binding().NativeImage.fromRgba(data, width, height));
  }

  get width(): number {
    return this.#handle.width;
  }

  get height(): number {
    return this.#handle.height;
  }

  /** A copy of the pixels, RGBA, rows top to bottom, for the rare caller that needs them in JavaScript. */
  pixels(): Uint8Array {
    return plain(this.#handle.pixels());
  }

  /** The image as PNG bytes, each row adaptively filtered. */
  async encode(): Promise<Uint8Array> {
    const png = await this.#handle.encode();
    keepAlive(this);
    return plain(png);
  }

  /**
   * Compares `actual` against this image, the one expected. They match when
   * they have one size and at most the tolerated number of pixels differ, as
   * pixelmatch 8 counts them: `maxDiffPixels`, a `maxDiffPixelRatio` share of
   * the image, the smaller of the two when both are set, and none when
   * neither is.
   */
  async compare(actual: NativeImage, tolerance: ImageTolerance): Promise<ImageComparison> {
    const raw = await this.#handle.compare(actual.#handle, tolerance);
    keepAlive(this, actual);
    return narrow(raw);
  }

  /** The picture of how `actual`, of this image's size, differs: this image faded, each counted pixel red. */
  async diff(actual: NativeImage, threshold: number): Promise<NativeImage> {
    const drawn = await this.#handle.diff(actual.#handle, threshold);
    keepAlive(this, actual);
    return new NativeImage(drawn);
  }
}

/**
 * Holds images until the call that reads them has finished. The worker
 * thread shares their pixels, and V8 stops counting those pixels as memory
 * once the images are collected; a reference after the `await` keeps them
 * reachable until then.
 */
function keepAlive(...images: readonly NativeImage[]): void {
  void images;
}

function narrow(raw: RawComparison): ImageComparison {
  if (raw.kind === 'size') {
    const box = (size: ImageSize | undefined): ImageBox => ({ x: 0, y: 0, width: size?.width ?? 0, height: size?.height ?? 0 });
    return { kind: 'size', expected: box(raw.expected), actual: box(raw.actual) };
  }
  if (raw.kind === 'match') return { kind: 'match', diffPixels: raw.diffPixels ?? 0 };
  return { kind: 'pixels', diffPixels: raw.diffPixels ?? 0, ratio: raw.ratio ?? 0 };
}

/** Loads the addon now, so a caller that must not fail later can fail at import. */
export function loadNativeUtil(): void {
  binding();
}

/** The width and height a PNG's header states, without decoding it; undefined when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): ImageSize | undefined {
  return binding().pngSize(bytes) ?? undefined;
}

/** Decodes PNG bytes (any color type, 1 to 16 bits, or a palette) to 8-bit RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<NativeImage> {
  return new NativeImage(await binding().decodePng(bytes));
}

/**
 * Decodes a PNG and applies `steps` in one call, so no pixels cross into
 * JavaScript between them: `output: 'png'` encodes the result again,
 * `output: 'image'` keeps it on the native side.
 */
export function processPng(bytes: Uint8Array, steps: ProcessSteps & { readonly output: 'png' }): Promise<Uint8Array>;
export function processPng(bytes: Uint8Array, steps: ProcessSteps & { readonly output: 'image' }): Promise<NativeImage>;
export async function processPng(bytes: Uint8Array, steps: ProcessSteps & { readonly output: 'png' | 'image' }): Promise<Uint8Array | NativeImage> {
  const { output, ...rest } = steps;
  if (output === 'png') return plain(await binding().processPngToPng(bytes, rest));
  return new NativeImage(await binding().processPng(bytes, rest));
}
