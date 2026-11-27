/**
 * One `toHaveScreenshot` capture: the engine's observation pixels of the
 * viewport or the whole page at one image pixel per CSS pixel, so a
 * screenshot is the same size on every device density, cut to the subject's
 * box or the clip when there is one, the masks painted over.
 */

import type { LocatorExpression } from '@e2e-dev/core/lib/engine/surface';
import { ConfigurationError, isE2EError } from '@e2e-dev/core/lib/internal/errors';
import { clipBox, cropImage, decodePng, fillBoxes, resampleImage, type ImageBox, type RgbaImage } from '@e2e-dev/core/lib/internal/image';
import { clipOutsideViewport, describeClip, type ScreenshotRegion } from '@e2e-dev/core/lib/internal/screenshot-region';
import type { ReadWindow } from '@e2e-dev/core/lib/internal/time';
import { isNodeVisible } from '@e2e-dev/core/lib/locator/engine';
import { describeExpression } from '@e2e-dev/core/lib/locator/expression';
import type { ScreenContext } from '@e2e-dev/core/lib/locator/screen';
import type { ScreenshotTarget } from './screenshot-call.ts';

/** What one call captures. */
export interface CaptureRequest {
  readonly api: string;
  readonly target: ScreenshotTarget;
  readonly masks: readonly LocatorExpression[];
  readonly maskColor: readonly [number, number, number];
}

/** One capture, or why there is none yet. */
export type Capture = { readonly image: RgbaImage } | { readonly missing: string };

/** What one capture keeps: the viewport or the whole page, cut to a box when there is one. */
interface Cut {
  readonly fullPage: boolean;
  readonly keep: Keep | undefined;
}

/** A box to cut, in the image's CSS pixels, and what a box with nothing in the image comes to. */
interface Keep {
  readonly box: ImageBox;
  outside(image: RgbaImage): Capture;
}

/**
 * Captures for one call. A locator's match is scrolled into view once, the
 * first time it is found; a match that is not there yet is a capture still
 * missing, so the call's poll keeps waiting and fails as an assertion. A
 * capture the deadline cut short throws, and the poll judges it as it judges
 * any read it cut off.
 */
export function screenshotCapturer(context: ScreenContext, request: CaptureRequest, reads: ReadWindow): () => Promise<Capture> {
  const state = { scrolled: !context.engine.session.actions.has('scrollIntoView') };
  return () => captureOnce(context, request, reads, state);
}

/** One capture; `state.scrolled` records that a locator's match was scrolled into view. */
async function captureOnce(context: ScreenContext, request: CaptureRequest, reads: ReadWindow, state: { scrolled: boolean }): Promise<Capture> {
  const { engine } = context;
  const { target } = request;
  const cut = target.kind === 'locator' ? await matchCut(context, target.expression, reads, state) : regionCut(request.api, target.region);
  if ('missing' in cut) return cut;
  const observation = await reads.read((timeoutMs) => engine.session.observe(engine.readOperation(timeoutMs), {
    pixels: true,
    comparable: true,
    ...(cut.fullPage ? { fullPage: true } : {}),
  }));
  if (observation.kind === 'semantic' && observation.pixelsWithheld !== undefined) {
    throw new ConfigurationError('POLICY_DENIED', `${request.api} could not prove every secure field on screen was masked, so the screenshot is not kept`);
  }
  const { pixels } = observation;
  if (pixels === undefined) return { missing: 'the engine returned no screenshot' };
  const scale = pixels.scale > 0 ? pixels.scale : 1;
  const raw = decodePng(pixels.data);
  let image = resampleImage(raw, Math.max(1, Math.round(raw.width / scale)), Math.max(1, Math.round(raw.height / scale)));
  // How far the page is scrolled on a full page: where the viewport, and every node rect, sits in the image.
  const scroll = pixels.scroll ?? { x: 0, y: 0 };
  let corner = { x: 0, y: 0 };
  if (cut.keep !== undefined) {
    const kept = clipBox(image, cut.keep.box);
    if (kept === undefined) return cut.keep.outside(image);
    image = cropImage(image, kept);
    corner = kept;
  }
  if (request.masks.length === 0) return { image };
  const boxes: ImageBox[] = [];
  for (const mask of request.masks) {
    for (const node of await engine.readAllNow(mask, reads)) {
      if (isNodeVisible(node) && node.rect !== undefined) boxes.push({ ...node.rect, x: node.rect.x + scroll.x - corner.x, y: node.rect.y + scroll.y - corner.y });
    }
  }
  return { image: fillBoxes(image, boxes, request.maskColor) };
}

/**
 * The cut of a region of the screen. A clip with nothing of the viewport
 * inside it fails at once, since the viewport does not grow while the call
 * waits; one past the end of a page is missing, since the page may still.
 */
function regionCut(api: string, { fullPage, clip }: ScreenshotRegion): Cut {
  if (clip === undefined) return { fullPage, keep: undefined };
  return {
    fullPage,
    keep: {
      box: clip,
      outside: (image) => {
        if (!fullPage) throw clipOutsideViewport(api, clip, image);
        return { missing: `clip ${describeClip(clip)} is outside the ${image.width}x${image.height} page` };
      },
    },
  };
}

/** The cut of a locator's one match, scrolled into view the first time it is found; `missing` while it is not there or not visible. */
async function matchCut(context: ScreenContext, expression: LocatorExpression, reads: ReadWindow, state: { scrolled: boolean }): Promise<Cut | { readonly missing: string }> {
  const { engine } = context;
  const shown = describeExpression(expression);
  let { node } = await engine.tryRead(expression, reads);
  if (node !== null && !state.scrolled) {
    try {
      await engine.performUntil(expression, { kind: 'scrollIntoView' }, reads.deadline);
    } catch (cause) {
      if (!isE2EError(cause) || cause.code !== 'LOCATOR_NOT_FOUND') throw cause;
    }
    state.scrolled = true;
    ({ node } = await engine.tryRead(expression, reads));
  }
  if (node === null) return { missing: `no node matches ${shown}` };
  if (!isNodeVisible(node) || node.rect === undefined) return { missing: `${shown} is not visible` };
  return { fullPage: false, keep: { box: node.rect, outside: () => ({ missing: `${shown} is outside the viewport` }) } };
}
