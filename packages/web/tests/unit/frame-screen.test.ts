/**
 * `browser.frameLocator` returns a frame-scoped screen that keeps the web-only
 * escape hatches: `locator` for an unnamed control inside the frame and
 * `frameLocator` for a frame nested in it. Both compose the same `frame`
 * expression every query in that scope compiles through. `browser.locator`
 * with `within` scopes its selector under another locator's expression.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, LocatorExpression } from '@e2e-dev/core/engine';
import type { Locator, Screen } from 'e2e';
import type { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture } from '../../src/browser.ts';

function browserWithRecordingContext() {
  const minted: LocatorExpression[] = [];
  const context = {
    expressionOf: (_api: string, locator: Locator) => (locator as unknown as { minted: LocatorExpression }).minted,
    operation: () => ({ signal: new AbortController().signal, timeoutMs: 1_000, runId: 'r', attemptId: 'a', origin: 'test' }),
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
    locator: (expression: LocatorExpression) => {
      minted.push(expression);
      return { minted: expression } as unknown as Locator;
    },
    screen: (scope: (expression: LocatorExpression) => LocatorExpression) => {
      return {
        getByRole: (role: string) =>
          ({
            minted: scope({
              kind: 'query',
              query: { kind: 'role', value: { kind: 'string', value: role, exact: true } },
            }),
          }) as unknown as Locator,
      } as unknown as Screen;
    },
  } as unknown as EngineFixtureContext;
  const browser = createBrowserFixture({ browserIdentity: () => undefined } as unknown as PlaywrightSurface, context);
  return { browser, minted };
}

const minted = (locator: Locator): LocatorExpression => (locator as unknown as { minted: LocatorExpression }).minted;

describe('frame screen', () => {
  it('frameLocator nests outermost-first', () => {
    const { browser } = browserWithRecordingContext();
    const inner = browser.frameLocator('#outer').frameLocator('#inner');
    expect(minted(inner.locator('#drag1'))).toEqual({
      kind: 'frame',
      selector: '#outer',
      source: { kind: 'frame', selector: '#inner', source: { kind: 'selector', selector: '#drag1' } },
    });
    expect(minted(inner.getByRole('button'))).toEqual({
      kind: 'frame',
      selector: '#outer',
      source: {
        kind: 'frame',
        selector: '#inner',
        source: { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      },
    });
  });

  it('rejects an empty selector at every level', () => {
    const { browser } = browserWithRecordingContext();
    const frame = browser.frameLocator('#result');
    expect(() => browser.frameLocator('')).toThrow(/browser\.frameLocator\(\) requires a nonempty selector/);
    expect(() => frame.locator('')).toThrow(/^locator\(\) requires a nonempty selector/);
    expect(() => frame.frameLocator('')).toThrow(/^frameLocator\(\) requires a nonempty selector/);
  });

  it('scopes browser.locator within another locator, keeping that locator\'s frame', () => {
    const { browser } = browserWithRecordingContext();
    const row = browser.frameLocator('#grid').getByRole('row');
    expect(minted(browser.locator('td.price', { within: row }))).toEqual({
      kind: 'selector',
      selector: 'td.price',
      scope: { kind: 'frame', selector: '#grid', source: { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'row', exact: true } } } },
    });
    expect(minted(browser.locator('td', { within: undefined } as never))).toEqual({ kind: 'selector', selector: 'td' });
  });

  it('refuses an unknown option and a locator passed as the options', () => {
    const { browser } = browserWithRecordingContext();
    const row = browser.locator('tr');
    expect(() => browser.locator('td', { scope: row } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_LOCATOR' }));
    // A real locator is a class instance, not a plain options object.
    const instance = Object.assign(Object.create({ tap() {} }) as object, row);
    expect(() => browser.locator('td', instance as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_LOCATOR', message: 'browser.locator options must be a plain object' }),
    );
  });
});
