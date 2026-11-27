/** `@e2e-dev/util`'s addon loads when the first PNG is read, decoded, or encoded, and an addon that cannot load fails that call, and only that, as IMAGE_CODEC_UNAVAILABLE. */

import { registerHooks } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { downscalePixels } from '@e2e-dev/core/lib/agent/pixels';
import { InfrastructureError } from '@e2e-dev/core/lib/internal/errors';
import { clipBox, decodePng, pngSize, processPng } from '@e2e-dev/core/lib/internal/image';

/** What Node reports for a platform package npm left out. This file imports nothing that loads the addon, so no earlier test in the process has. */
function notFound(): Error {
  return Object.assign(new Error("Cannot find module '@e2e-dev/util-x'"), { code: 'MODULE_NOT_FOUND' });
}
let loaderFailure: Error = notFound();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/[\\/]util\.[^\\/]+\.node$/.test(specifier) || specifier.startsWith('@e2e-dev/util-')) throw loaderFailure;
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

/** The error `run` throws or rejects with; the test fails when there is none. */
async function failure(run: () => unknown): Promise<InfrastructureError> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof InfrastructureError) return cause;
    throw cause;
  }
  throw new Error('expected a throw');
}

const PLATFORM_PACKAGE = /@e2e-dev\/util-(darwin|linux|win32)-/;

describe('without the @e2e-dev/util addon', () => {
  it('fails a header read, a decode, and a pipeline as IMAGE_CODEC_UNAVAILABLE, naming the platform package and the way back', async () => {
    for (const read of [() => pngSize(new Uint8Array(8)), () => decodePng(new Uint8Array(8)), () => processPng(new Uint8Array(8), { output: 'png' })]) {
      const error = await failure(read);
      expect(error.code).toBe('IMAGE_CODEC_UNAVAILABLE');
      expect(error.category).toBe('infrastructure');
      expect(error.message).toMatch(PLATFORM_PACKAGE);
      expect(error.message).toContain('npm/cli#4828');
      expect((error.cause as Error).cause).toBe(loaderFailure);
    }
  });

  it('gives the loader error for an addon that fails to load for another reason', async () => {
    loaderFailure = new Error('dlopen failed: bad ELF header\n    at Module._extensions');
    const error = await failure(() => decodePng(new Uint8Array(8)));
    expect(error.message).toContain('it could not be loaded (dlopen failed: bad ELF header)');
    expect(error.message).not.toContain('--omit=optional');
    loaderFailure = notFound();
  });

  it('fails a model-sized screenshot instead of passing the capture on', async () => {
    const pixels = { data: new Uint8Array(8), mediaType: 'image/png', width: 2000, height: 1000, scale: 1 } as const;
    expect((await failure(() => downscalePixels(pixels, 768))).code).toBe('IMAGE_CODEC_UNAVAILABLE');
    expect(await downscalePixels(pixels, 2000)).toBe(pixels);
  });

  it('still clips a box, which needs no addon', () => {
    expect(clipBox({ width: 8, height: 8 }, { x: 2, y: 2, width: 3, height: 3 })).toEqual({ x: 2, y: 2, width: 3, height: 3 });
  });
});
