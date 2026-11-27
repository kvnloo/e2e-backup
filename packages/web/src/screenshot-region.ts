/** The part of the page an artifact screenshot keeps, as Playwright takes it, and Playwright's refusal of a clip that keeps nothing. */

import type { PageScreenshotOptions } from 'playwright-core';
import { TestError, type EngineScreenshotOptions } from '@e2e-dev/core/engine';

/** How Playwright refuses a clip with nothing of the page inside it; the testbed's full-page clip test fails if an upgrade rewords it. */
const CLIP_OUTSIDE = 'Clipped area is either empty or outside';

/** Playwright's options for `options`: the viewport when there are none, else the whole page, cut to the clip when there is one. */
export function regionOptions(options: EngineScreenshotOptions | undefined): Pick<PageScreenshotOptions, 'fullPage' | 'clip'> {
  if (options === undefined) return {};
  return { fullPage: true, ...(options.clip === undefined ? {} : { clip: { ...options.clip } }) };
}

/** Playwright's refusal of a clip with nothing of the page inside it, as the contract's `INVALID_ARGUMENT`; undefined for any other failure. */
export function clipOutsidePage(cause: unknown, options: EngineScreenshotOptions | undefined): TestError | undefined {
  const clip = options?.clip;
  if (clip === undefined || !(cause instanceof Error) || !cause.message.includes(CLIP_OUTSIDE)) return undefined;
  return new TestError('INVALID_ARGUMENT', `screenshot clip { x: ${clip.x}, y: ${clip.y}, width: ${clip.width}, height: ${clip.height} } is outside the page`, { cause });
}
