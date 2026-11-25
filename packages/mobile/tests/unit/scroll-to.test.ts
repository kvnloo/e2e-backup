/** `scrollTo` on a device: the drag toward an edge, what a region shows, and the loop that stops when a drag moves nothing. */

import { describe, expect, it } from 'vitest';
import type { OperationContext, SemanticNode } from '@e2e-dev/core/engine';
import { ORIGIN_WARNING } from '../../src/errors.ts';
import { projectSnapshot, type RawNode } from '../../src/nodes.ts';
import { above, clipTo, edgeDrag, regionSignature } from '../../src/scroll-to.ts';
import { SETTINGS_NODES, SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';
import { boot, harness, type Harness } from '../helpers/harness.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const REGION = { x: 0, y: 100, width: 400, height: 800 };

function operation(timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'run-1', attemptId: 'a1', origin: 'test' };
}

/** The Settings screen with every row below the navigation bar moved up by `offset`, as a scroll leaves it. */
function scrolled(offset: number) {
  const nodes = SETTINGS_NODES.map((node) =>
    node.rect !== undefined && node.rect.y > 100 ? { ...node, rect: { ...node.rect, y: node.rect.y - offset } } : node,
  );
  return { ...SETTINGS_SNAPSHOT, viewport: { width: 390, height: 844 }, nodes };
}

/** Answers each snapshot with the next screen in `screens`, the last one from then on. */
function screens(h: Harness, list: readonly unknown[]): void {
  let taken = 0;
  h.fake.respond('capture.snapshot', () => list[Math.min(taken++, list.length - 1)]);
}

async function opened(): Promise<Harness> {
  const h = harness();
  await boot(h);
  await h.engine.startAttempt!({ attemptId: 'a1', artifactsDir: '', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  return h;
}

function named(root: SemanticNode, name: string): SemanticNode {
  const found = [root, ...(root.children ?? []).flatMap(function walk(node): SemanticNode[] {
    return [node, ...(node.children ?? []).flatMap(walk)];
  })].find((node) => node.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

describe('edgeDrag', () => {
  it.each([
    ['bottom', { x: 200, y: 700 }, { x: 200, y: 300 }],
    ['top', { x: 200, y: 300 }, { x: 200, y: 700 }],
    ['right', { x: 300, y: 500 }, { x: 100, y: 500 }],
    ['left', { x: 100, y: 500 }, { x: 300, y: 500 }],
  ] as const)('moves the finger away from the %s edge, a quarter in from each side of the region', (edge, from, to) => {
    expect(edgeDrag(REGION, edge)).toEqual({ from, to });
  });
});

describe('regionSignature', () => {
  const project = (raw: readonly RawNode[]) => {
    let id = 0;
    return projectSnapshot(raw, { mintId: () => `n${(id += 1)}`, viewport: { width: 390, height: 844 } }).index;
  };
  const row = (label: string, y: number, type = 'cell'): RawNode => ({ ref: `@${label}`, index: 0, depth: 0, type, label, rect: { x: 0, y, width: 390, height: 44 } });

  it('changes when a row in the region moves, and not when only a row outside it does', () => {
    const region = { x: 0, y: 100, width: 390, height: 400 };
    const before = regionSignature(project([row('A', 120), row('Outside', 600)]), region);
    expect(regionSignature(project([row('A', 120), row('Outside', 640)]), region)).toBe(before);
    expect(regionSignature(project([row('A', 90), row('Outside', 600)]), region)).not.toBe(before);
  });

  it('leaves out a spinner, which turns on its own, and rounds boxes to whole points', () => {
    const region = { x: 0, y: 0, width: 390, height: 844 };
    const base = regionSignature(project([row('A', 120)]), region);
    expect(regionSignature(project([row('A', 120.3), row('Loading', 300, 'progress-indicator')]), region)).toBe(base);
  });
});

describe('above', () => {
  it('cuts the region off at the keyboard, and leaves it whole with none or one below it', () => {
    expect(above(REGION, 500)).toEqual({ ...REGION, height: 400 });
    expect(above(REGION, undefined)).toBe(REGION);
    expect(above(REGION, 1_000)).toBe(REGION);
  });
});

describe('clipTo', () => {
  it('keeps the part of a box on the screen, and nothing of one off it', () => {
    expect(clipTo({ x: -10, y: 700, width: 420, height: 400 }, { width: 390, height: 844 })).toEqual({ x: 0, y: 700, width: 390, height: 144 });
    expect(clipTo({ x: 0, y: 900, width: 390, height: 40 }, { width: 390, height: 844 })).toMatchObject({ height: 0 });
  });
});

describe('scrollTo on the device surface', () => {
  it('drags the screen until a drag moves nothing, sending more drags per read while it moves', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    screens(h, [scrolled(0), scrolled(300), scrolled(600), scrolled(600)]);
    const before = h.fake.calls.length;
    await h.engine.perform!(root.ref, { kind: 'scrollTo', edge: 'bottom' }, operation());
    const calls = h.fake.calls.slice(before).filter((call) => call.method !== 'capture.screenshot');
    expect(calls.map((call) => call.method)).toEqual([
      'capture.snapshot',
      'interactions.swipe',
      'capture.snapshot',
      'interactions.swipe',
      'capture.snapshot',
      'interactions.swipe',
      'capture.snapshot',
    ]);
    // The whole 390x844 screen: a quarter in from the bottom to a quarter in from the top, one drag, then two, then three.
    const swipes = calls.filter((call) => call.method === 'interactions.swipe').map((call) => call.args);
    expect(swipes).toEqual([1, 2, 3].map((count) => ({ from: { x: 195, y: 633 }, to: { x: 195, y: 211 }, count, pauseMs: 0 })));
  });

  it('never reads a truncated capture as unchanged, so a capped tree does not end the scroll', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    const cut = { ...scrolled(0), truncated: true };
    screens(h, [scrolled(0), cut, cut, scrolled(0), scrolled(0)]);
    const before = h.fake.calls.length;
    await h.engine.perform!(root.ref, { kind: 'scrollTo', edge: 'bottom' }, operation());
    // Two truncated reads, then two whole ones that agree.
    expect(h.fake.calls.slice(before).filter((call) => call.method === 'interactions.swipe')).toHaveLength(4);
  });

  it('drags inside a node\'s own box, and stops after one drag when it is at its edge already', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    const scroller = named(root, 'Scroller');
    await h.engine.perform!(scroller.ref, { kind: 'scrollTo', edge: 'top' }, operation());
    const swipes = h.fake.calls.filter((call) => call.method === 'interactions.swipe').map((call) => call.args);
    // Scroller is 390x400 at y 320: the finger runs down, from y 420 to y 620.
    expect(swipes).toEqual([{ from: { x: 195, y: 420 }, to: { x: 195, y: 620 }, count: 1, pauseMs: 0 }]);
  });

  it('keeps dragging the box it measured when the node\'s own label changes as it scrolls', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    const scroller = named(root, 'Scroller');
    let reads = 0;
    // The list names itself after its first visible row, which a drag changes.
    h.fake.respond('capture.snapshot', () => {
      reads += 1;
      const base = scrolled(0);
      const label = reads <= 1 ? 'Scroller' : 'Scroller, row 20';
      return { ...base, nodes: base.nodes.map((node) => (node.label === 'Scroller' ? { ...node, label } : node)) };
    });
    await h.engine.perform!(scroller.ref, { kind: 'scrollTo', edge: 'bottom' }, operation());
    const swipes = h.fake.calls.filter((call) => call.method === 'interactions.swipe');
    expect(swipes.length).toBeGreaterThan(0);
    expect(swipes.every((call) => (call.args as { from: { y: number } }).from.y === 620)).toBe(true);
  });

  it.each([
    ['a keyboard that is up with no bounds', { keyboard: { kind: 'visibility-only', visible: true } }, /keyboard is up and its bounds are unknown/],
    ['bounds that may be window-local', { warnings: [ORIGIN_WARNING] }, /Nothing was sent/],
  ])('refuses %s before any drag', async (_name, extra, message) => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    const scroller = named(root, 'Scroller');
    h.fake.respond('capture.snapshot', () => ({ ...scrolled(0), ...extra }));
    await expect(h.engine.perform!(scroller.ref, { kind: 'scrollTo', edge: 'bottom' }, operation())).rejects.toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: expect.stringMatching(message),
    });
    expect(h.fake.calls.filter((call) => call.method === 'interactions.swipe')).toHaveLength(0);
  });

  it('refuses a node with no area on screen as having no bounds, not as covered by a keyboard', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    const hidden = named(root, 'Hidden');
    await expect(h.engine.perform!(hidden.ref, { kind: 'scrollTo', edge: 'bottom' }, operation())).rejects.toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: expect.stringContaining('has no bounds on screen'),
    });
  });

  it('fails within its budget when the content never stops moving', async () => {
    const h = await opened();
    const { root } = await h.engine.observe!(operation());
    let loaded = 0;
    // A feed that loads one more row on every drag: the region never reads the same twice.
    h.fake.respond('capture.snapshot', () => {
      const base = scrolled(0);
      return { ...base, nodes: base.nodes.map((node) => (node.label === 'About' ? { ...node, label: `About ${(loaded += 1)}` } : node)) };
    });
    await expect(h.engine.perform!(root.ref, { kind: 'scrollTo', edge: 'bottom' }, operation(200))).rejects.toMatchObject({
      code: expect.stringMatching(/^(OPERATION_TIMEOUT|ACTION_MAY_HAVE_COMMITTED)$/),
    });
  });
});
