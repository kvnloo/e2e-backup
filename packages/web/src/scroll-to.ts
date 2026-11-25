/** `scrollTo`: scrolls a container to one of its edges with the page's own scroll API. */

import type { Page } from 'playwright-core';
import { Deadline, EngineError, type ScrollEdge } from '@e2e-dev/core/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import type { ConnectionBudget } from './operation-budget.ts';
import type { ActionTarget } from './support.ts';

/**
 * One jump: `none` when nothing scrolls along the axis, else whether the
 * container still sat at the end the jump reached after the next rendered
 * frame, with its scrollable extent unchanged.
 */
type JumpResult = { readonly container: 'none' } | { readonly container: 'found'; readonly settled: boolean };

/**
 * Scrolls the container of `target` (the node, or its nearest ancestor that
 * scrolls along the edge's axis), or with no target the page, else (an app
 * shell whose page does not scroll) the container under the viewport's
 * center, to `edge`. Each jump sets the offset past the end, which
 * the browser clamps, and waits for a rendered frame. Content that grows at the
 * end (an infinite list) moves the end, so it jumps again until the container
 * still holds the end a jump reached one frame later. The loop runs
 * here, one evaluate per jump, so a cancelled step leaves nothing running in
 * the page.
 */
export async function scrollToEdge(page: Page, target: ActionTarget | undefined, edge: ScrollEdge, operation: ConnectionBudget): Promise<void> {
  const deadline = new Deadline(operation.timeoutMs);
  // An action waits for its node as every other one does: a node with no box
  // yet (still arriving, or display: none) is waited on, not taken as at its edge.
  if (target?.kind === 'locator') await target.locator.waitFor({ state: 'visible', timeout: operation.timeoutMs });
  else if (target?.kind === 'element') await target.element.waitForElementState('visible', { timeout: operation.timeoutMs });
  const args = { edge, fromCenter: target === undefined, closedRootsKey: CLOSED_SHADOW_ROOTS_KEY } as const;
  for (let jumps = 1; ; jumps += 1) {
    operation.signal.throwIfAborted();
    const remaining = Math.max(1, deadline.remaining());
    const result = target === undefined
      ? await page.locator(':root').evaluate(jumpToEdge, args, { timeout: remaining })
      : target.kind === 'locator'
        ? await target.locator.evaluate(jumpToEdge, args, { timeout: remaining })
        : await target.element.evaluate(jumpToEdge, args);
    if (result.container === 'none' || result.settled) return;
    if (deadline.expired()) {
      throw new EngineError('OPERATION_TIMEOUT', `more content kept loading at the ${edge} edge after ${jumps} jumps, until the budget ran out`, {
        retryable: false,
      });
    }
  }
}

/**
 * Page-side: one jump toward `edge`, then the position after the next
 * rendered frame. A hidden document renders no frames, so it reads at once.
 */
function jumpToEdge(
  start: Element,
  args: { readonly edge: ScrollEdge; readonly fromCenter: boolean; readonly closedRootsKey: string },
): Promise<JumpResult> {
  const { edge } = args;
  const vertical = edge === 'top' || edge === 'bottom';
  const doc = start.ownerDocument;
  const view = doc.defaultView ?? window;
  const scrolling = doc.scrollingElement ?? doc.documentElement;
  const closedRoots = (globalThis as Record<symbol, unknown>)[Symbol.for(args.closedRootsKey)] as WeakMap<Element, ShadowRoot> | undefined;
  const overflowOf = (style: CSSStyleDeclaration): string => (vertical ? style.overflowY : style.overflowX);

  // The viewport takes the root element's overflow, or the body's when the
  // root's is visible on both axes; the body then does not scroll itself.
  const rootStyle = view.getComputedStyle(doc.documentElement);
  const bodyGivesOverflow = doc.body !== null && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible';
  const viewportScrolls = (): boolean => {
    const overflow = bodyGivesOverflow && doc.body !== null ? overflowOf(view.getComputedStyle(doc.body)) : overflowOf(rootStyle);
    return overflow !== 'hidden' && overflow !== 'clip';
  };
  const scrolls = (element: Element): boolean => {
    const room = vertical ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
    if (room < 1) return false;
    if (element === scrolling) return viewportScrolls();
    if (element === doc.body && bodyGivesOverflow) return false;
    const overflow = overflowOf(view.getComputedStyle(element));
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  };
  const parentOf = (element: Element): Element | null => {
    if (element.assignedSlot !== null) return element.assignedSlot;
    if (element.parentElement !== null) return element.parentElement;
    const parent = element.parentNode;
    return parent instanceof ShadowRoot ? parent.host : null;
  };

  let from: Element | null = start;
  // The screen is the page when the page scrolls along the axis, as a test
  // migrated from `cy.scrollTo` expects; an inner pane that happens to sit
  // under the center is scrolled only through a locator.
  if (args.fromCenter && scrolls(scrolling)) from = scrolling;
  else if (args.fromCenter) {
    // The element under the viewport's center, inside open and closed shadow roots.
    const x = view.innerWidth / 2;
    const y = view.innerHeight / 2;
    from = doc.elementFromPoint(x, y);
    while (from !== null) {
      const root: ShadowRoot | null | undefined = from.shadowRoot ?? closedRoots?.get(from);
      const inner = root?.elementFromPoint(x, y) ?? null;
      if (inner === null || inner === from) break;
      from = inner;
    }
  }
  let container: Element | null = null;
  for (let element = from; element !== null; element = parentOf(element)) {
    if (scrolls(element)) {
      container = element;
      break;
    }
    if (element === scrolling) break;
  }
  if (container === null && scrolls(scrolling)) container = scrolling;
  if (container === null) return Promise.resolve({ container: 'none' });

  // Past the end on purpose: the browser clamps the offset, and the sign
  // covers a container whose offsets run negative (right-to-left, column-reverse).
  const far = vertical ? container.scrollHeight : container.scrollWidth;
  const offset = edge === 'top' || edge === 'left' ? -far : far;
  // `instant` overrides `scroll-behavior: smooth`, so the offset is read where it landed.
  container.scrollTo(vertical ? { top: offset, behavior: 'instant' } : { left: offset, behavior: 'instant' });
  const found = container;
  const extentOf = (): number => (vertical ? found.scrollHeight : found.scrollWidth);
  const offsetOf = (): number => (vertical ? found.scrollTop : found.scrollLeft);
  const extent = extentOf();
  const landed = offsetOf();
  // Content that loads at the end grows the extent; a scroll handler that pulls
  // the container back moves the offset. Either means the end was not held.
  const read = (): JumpResult => ({ container: 'found', settled: extentOf() === extent && offsetOf() === landed });
  if (doc.visibilityState === 'hidden') return Promise.resolve(read());
  return new Promise((resolve) => view.requestAnimationFrame(() => view.setTimeout(() => resolve(read()), 0)));
}
