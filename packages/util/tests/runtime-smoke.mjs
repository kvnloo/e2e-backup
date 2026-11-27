/**
 * A PNG round trip and a comparison through the built package and its addon,
 * for a runtime the vitest suites do not run under: `bun packages/util/tests/runtime-smoke.mjs`.
 */
const util = await import(new URL('../dist/index.js', import.meta.url).href);
const image = util.NativeImage.fromRgba(new Uint8Array(16).fill(200), 2, 2);
const png = await image.encode();
const back = await util.decodePng(png);
const pixel = back.pixels();
if (back.width !== 2 || back.height !== 2 || pixel[0] !== 200) throw new Error('the PNG round trip under Bun changed the image');
const comparison = await image.compare(back, { threshold: 0, maxDiffPixels: undefined, maxDiffPixelRatio: undefined });
if (comparison.kind !== 'match') throw new Error(`a round-tripped image does not match itself: ${JSON.stringify(comparison)}`);
console.log(`@e2e-dev/util under ${typeof Bun === 'undefined' ? 'Node' : `Bun ${Bun.version}`}: ${png.length}-byte PNG round trip, compare ${comparison.kind}`);
