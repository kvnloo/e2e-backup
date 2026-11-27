/**
 * Loads the addon: the checkout build next to this package when there is
 * one, else the platform package npm installed with `@e2e-dev/util`. Nothing
 * loads until the first call that needs it, so importing this package never
 * fails on a platform with no build.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const ownRequire = createRequire(import.meta.url);

/** An image's width and height. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** A box in image pixels: fractional, possibly negative, possibly past the image. */
export interface ImageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What `processPng` does to a decoded PNG, in this order: resample, crop (clipped to the image), paint. */
export interface ProcessSteps {
  readonly resize?: ImageSize;
  readonly crop?: ImageBox;
  readonly fill?: { readonly boxes: readonly ImageBox[]; readonly color: readonly [number, number, number] };
}

/** How far two images may differ and still match. */
export interface ImageTolerance {
  /** Per-pixel color distance, 0 to 1, below which two pixels are the same. */
  readonly threshold: number;
  readonly maxDiffPixels: number | undefined;
  readonly maxDiffPixelRatio: number | undefined;
}

/** The addon's comparison, before it is narrowed to `ImageComparison`. */
export interface RawComparison {
  readonly kind: 'match' | 'size' | 'pixels';
  readonly diffPixels?: number;
  readonly ratio?: number;
  readonly expected?: ImageSize;
  readonly actual?: ImageSize;
}

/** The addon's image class. */
export interface NativeImageHandle {
  readonly width: number;
  readonly height: number;
  pixels(): Buffer;
  encode(): Promise<Buffer>;
  compare(actual: NativeImageHandle, tolerance: ImageTolerance): Promise<RawComparison>;
  diff(actual: NativeImageHandle, threshold: number): Promise<NativeImageHandle>;
}

/** What the addon exports. */
export interface Binding {
  readonly NativeImage: { fromRgba(data: Uint8Array, width: number, height: number): NativeImageHandle };
  pngSize(bytes: Uint8Array): ImageSize | null;
  decodePng(bytes: Uint8Array): Promise<NativeImageHandle>;
  processPng(bytes: Uint8Array, steps: ProcessSteps): Promise<NativeImageHandle>;
  processPngToPng(bytes: Uint8Array, steps: ProcessSteps): Promise<Buffer>;
}

/** The addon could not be loaded on this machine. */
export class NativeUtilUnavailableError extends Error {
  override readonly name = 'NativeUtilUnavailableError';
  /** The platform package that holds this machine's build; undefined when no build exists for it. */
  readonly packageName: string | undefined;
  /** `<platform>-<arch>[-<abi>]`, as NAPI-RS names it. */
  readonly platform: string;

  constructor(message: string, packageName: string | undefined, platform: string, options?: ErrorOptions) {
    super(message, options);
    this.packageName = packageName;
    this.platform = platform;
  }
}

/** NAPI-RS's name for this machine's platform; undefined where no addon is built. */
function platformName(): string {
  const { platform, arch } = process;
  if (platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    return `linux-${arch}-${report.header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu'}`;
  }
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

/** The platform names a package is published for. */
const PLATFORMS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-x64-musl',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'win32-x64-msvc',
  'win32-arm64-msvc',
]);

let loaded: Binding | undefined;

/** The addon, loaded on first use. Throws `NativeUtilUnavailableError` when no build loads. */
export function binding(): Binding {
  if (loaded !== undefined) return loaded;
  const platform = platformName();
  const packageName = PLATFORMS.has(platform) ? `@e2e-dev/util-${platform}` : undefined;
  const failures: string[] = [];
  // A checkout build exists only in a checkout (the package ships `dist` alone), and is the one just built there.
  const candidates = [path.join(import.meta.dirname, '..', `util.${platform}.node`), ...(packageName === undefined ? [] : [packageName])];
  let cause: unknown;
  for (const specifier of candidates) {
    try {
      loaded = ownRequire(specifier) as Binding;
      return loaded;
    } catch (error) {
      cause ??= error;
      failures.push(`${specifier}: ${(error instanceof Error ? error.message : String(error)).split('\n', 1)[0] ?? ''}`);
    }
  }
  const message = packageName === undefined
    ? `@e2e-dev/util has no native build for ${platform}`
    : `@e2e-dev/util could not load its native build for ${platform}; install ${packageName}, which npm installs with @e2e-dev/util on this platform unless it runs with --omit=optional or from a lockfile written on another platform (npm/cli#4828)`;
  throw new NativeUtilUnavailableError(`${message} (${failures.join('; ')})`, packageName, platform, { cause });
}
