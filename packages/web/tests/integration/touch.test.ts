/** Touch emulation in a real Chromium. A tap sends touch events when `web({ hasTouch: true })` is set. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LocatorAction, OperationContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const LISTEN = `<script>
  window.events = [];
  for (const type of ['touchstart', 'touchend', 'click']) {
    document.addEventListener(type, (event) => window.events.push(event.shiftKey ? type + '+shift' : type));
  }
</script>`;

const PAGE = `<button style="width:200px;height:100px">Go</button>${LISTEN}`;

/** A checkbox that doesn't show a box, so it's tapped through its label. */
const LABELLED = `<label><input type="checkbox" style="position:absolute;opacity:0;width:0;height:0;margin:0">Accept</label>${LISTEN}`;

const signal = new AbortController().signal;
const operation = (): OperationContext => ({ signal, timeoutMs: 10_000, runId: 'touch', attemptId: 'a', origin: 'test' });
const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-touch-'));

afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Runs `act` on a page of a surface built with `hasTouch`, and returns the types of the events dispatched on the page `act` leaves. */
async function eventsOf(hasTouch: boolean, act: (surface: PlaywrightSurface) => Promise<void>, content = PAGE): Promise<string[]> {
  const surface = new PlaywrightSurface({ hasTouch });
  try {
    await surface.init({ runId: 'touch', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'a', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await (await surface.ensurePage()).setContent(content);
    await act(surface);
    return await (await surface.ensurePage()).evaluate(() => (window as unknown as { events: string[] }).events);
  } finally {
    await surface.endAttempt({ signal, timeoutMs: 10_000 });
    await surface.dispose({ signal, timeoutMs: 10_000 });
  }
}

/** Performs `action` on the first node of `role` the surface locates. */
async function performOn(surface: PlaywrightSurface, role: string, action: LocatorAction = { kind: 'tap' }): Promise<void> {
  const [node] = await surface.locate({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: role, exact: true } } }, operation());
  if (node === undefined) throw new Error(`no ${role} was located`);
  await surface.perform(node.ref, action, operation());
}

const tapButton = (surface: PlaywrightSurface) => performOn(surface, 'button');

describe('web({ hasTouch })', () => {
  it('taps a node with touch events followed by a click', async () => {
    expect(await eventsOf(true, tapButton)).toEqual(['touchstart', 'touchend', 'click']);
  });

  it("taps a checkbox that doesn't show a box through its label with touch events", async () => {
    const events = await eventsOf(true, async (surface) => {
      await performOn(surface, 'checkbox');
      expect(await (await surface.ensurePage()).isChecked('input')).toBe(true);
    }, LABELLED);
    expect(events.slice(0, 3)).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('holds the modifiers of a touch tap for the click that follows it', async () => {
    const events = await eventsOf(true, (surface) => performOn(surface, 'button', { kind: 'tap', modifiers: ['Shift'] }));
    expect(events.at(-1)).toBe('click+shift');
  });

  it('taps a point with touch events', async () => {
    const events = await eventsOf(true, async (surface) => {
      await surface.observe(operation());
      await surface.performAt({ x: 50, y: 50 }, { kind: 'tap' }, operation());
    });
    expect(events).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('keeps tapping with touch events after the context is replaced', async () => {
    const events = await eventsOf(true, async (surface) => {
      await surface.reset(operation());
      await (await surface.ensurePage()).setContent(PAGE);
      await tapButton(surface);
    });
    expect(events).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('clicks without touch events by default', async () => {
    expect(await eventsOf(false, tapButton)).toEqual(['click']);
  });
});
