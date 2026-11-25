/** The pure half of `scrollTo` on a device: the drag toward an edge, and what a container shows between drags. */

import type { ScrollEdge } from '@e2e-dev/core/engine';
import type { ProjectedNode } from './nodes.ts';
import type { Point, Rect } from './support.ts';

/**
 * Roles left out of what a container shows: a spinner (a pull-to-refresh
 * indicator, a loading row) changes on its own, so counting it would read a
 * container at its edge as still moving.
 */
const RESTLESS_ROLES: ReadonlySet<string> = new Set(['progressbar', 'status']);

/**
 * The finger's path that moves a container's content toward `edge`: to reach
 * the bottom the finger travels up. It runs from a quarter in from one side
 * of the region to a quarter in from the other, along its middle, released
 * without a hold so the content keeps going: an edge needs no row seen on the
 * way. The quarter keeps the start off a sticky footer or a tab bar.
 */
export function edgeDrag(region: Rect, edge: ScrollEdge): { from: Point; to: Point } {
  const x = region.x + region.width / 2;
  const y = region.y + region.height / 2;
  const near = (start: number, extent: number): number => start + extent * 0.25;
  const far = (start: number, extent: number): number => start + extent * 0.75;
  switch (edge) {
    case 'bottom':
      return { from: { x, y: far(region.y, region.height) }, to: { x, y: near(region.y, region.height) } };
    case 'top':
      return { from: { x, y: near(region.y, region.height) }, to: { x, y: far(region.y, region.height) } };
    case 'right':
      return { from: { x: far(region.x, region.width), y }, to: { x: near(region.x, region.width), y } };
    case 'left':
      return { from: { x: near(region.x, region.width), y }, to: { x: far(region.x, region.width), y } };
  }
}

/**
 * What a region of the screen shows, as one comparable string: every node
 * whose box meets the region, by role, name, text, value, and box rounded to
 * whole points. Two equal signatures around a drag mean the drag moved
 * nothing, so the container is at its edge.
 */
export function regionSignature(index: readonly ProjectedNode[], region: Rect): string {
  const lines: string[] = [];
  for (const { node } of index) {
    const rect = node.rect;
    if (rect === undefined || (node.role !== undefined && RESTLESS_ROLES.has(node.role))) continue;
    if (rect.x >= region.x + region.width || rect.x + rect.width <= region.x) continue;
    if (rect.y >= region.y + region.height || rect.y + rect.height <= region.y) continue;
    const box = [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(',');
    lines.push([node.role ?? '', node.name ?? '', node.text ?? '', node.value ?? '', box].join('\u0000'));
  }
  return lines.join('\n');
}

/** The part of `rect` on a screen of `size`; a box wholly off it has no area. */
export function clipTo(rect: Rect, size: { readonly width: number; readonly height: number }): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(size.width, rect.x + rect.width) - x),
    height: Math.max(0, Math.min(size.height, rect.y + rect.height) - y),
  };
}

/** A region cut off above `top` (the soft keyboard's edge), so a drag never starts on a key. */
export function above(region: Rect, top: number | undefined): Rect {
  if (top === undefined || top >= region.y + region.height) return region;
  return { ...region, height: Math.max(0, top - region.y) };
}
