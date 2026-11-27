/**
 * A `selector` expression with a `scope` (`browser.locator(css, { within })`)
 * matches what Playwright's own `within.locator(css)` matches on the same
 * page: every element the selector reaches from any scope match, each once,
 * in Playwright's order (scope match by scope match, so not always document
 * order), with XPath, `:scope`, and `..` read from the scope element. Each case runs the engine and Playwright side by side and compares
 * the `data-testid` of every match.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator as PwLocator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticQuery } from '@e2e-dev/core/engine';
import { surfaceOf, web } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGE = `
<ul id="a" aria-label="Fruits" data-testid="a">
  <li class="x" data-testid="a1">apple</li>
  <li class="x" data-testid="a2">banana<ul data-testid="a2-list"><li class="x" data-testid="a2-inner">plantain</li></ul></li>
</ul>
<ul id="b" aria-label="Greens" data-testid="b"><li class="x" data-testid="b1">kale</li></ul>
<div class="x" data-testid="outside">outside</div>
<div role="group" aria-label="Billing" data-testid="billing"><span class="v" data-testid="billing-v">9.99</span></div>
<div role="group" aria-label="Billing" data-testid="billing-2"><span class="v" data-testid="billing-2-v">19.99</span></div>
<div role="group" aria-label="Billing address" data-testid="address"><span class="v" data-testid="address-v">Main St</span></div>
<input value="draft" aria-label="Note" data-testid="note">
<iframe id="frame" srcdoc="<ul aria-label='Framed'><li class='x' data-testid='f1'>fig</li></ul>"></iframe>
<iframe id="hidden" style="visibility: hidden" srcdoc="<ul aria-label='Hidden'><li class='x' data-testid='h1'>hidden</li></ul>"></iframe>
<article data-testid="outer"><article data-testid="inner"><p class="direct" data-testid="early">early</p></article><p class="direct" data-testid="late">late</p></article>
<div id="host" data-testid="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'closed' });
  root.innerHTML = '<ul aria-label="Shadow"><li class="x" data-testid="s1">shade</li></ul>';
</script>
`;

const exact = (value: string) => ({ kind: 'string', value, exact: true }) as const;
const query = (semantic: SemanticQuery): LocatorExpression => ({ kind: 'query', query: semantic });
const byRole = (role: string, name?: string): LocatorExpression =>
  query({ kind: 'role', value: exact(role), ...(name === undefined ? {} : { name: exact(name) }) });
const css = (selector: string, scope?: LocatorExpression): LocatorExpression => ({
  kind: 'selector',
  selector,
  ...(scope === undefined ? {} : { scope }),
});

describe('a selector scoped inside a locator', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-scoped-selectors-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'scoped', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let page: Page;

  /** The test ids of what the engine locates for `expression`. */
  const located = async (expression: LocatorExpression) =>
    (await engine.locate!(expression, operation)).map((node) => node.testId);
  /** The test ids of what Playwright's own locator matches. */
  const playwright = (locator: PwLocator) => locator.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));

  beforeAll(async () => {
    await engine.init!({ runId: 'scoped', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    page = surfaceOf(engine)!.page();
    await page.setContent(PAGE);
    await page.frameLocator('#frame').locator('li').waitFor();
    await page.frameLocator('#hidden').locator('li').waitFor({ state: 'attached' });
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it.each([
    ['CSS under nested and repeated scope matches', 'ul', 'li.x', ['a1', 'a2', 'a2-inner', 'b1']],
    ['a leading // XPath, read from the scope', '#b', '//li', ['b1']],
    [':scope, the scope element itself', '#a', ':scope > li', ['a1', 'a2']],
    ['an XPath parent step, which leaves the scope', '[data-testid="a1"]', 'xpath=..', ['a']],
    ['a >> chain', '#a', 'li >> nth=1 >> li', ['a2-inner']],
    ['nested scope matches, in scope order rather than document order', 'article', ':scope > .direct', ['late', 'early']],
  ])('matches Playwright for %s', async (_case, scope, selector, expected) => {
    expect(await playwright(page.locator(scope).locator(selector))).toEqual(expected);
    expect(await located(css(selector, css(scope)))).toEqual(expected);
  });

  it('scopes under semantic, filtered, positioned, and union locators the way Playwright does', async () => {
    const fruits = byRole('list', 'Fruits');
    expect(await located(css('li', fruits))).toEqual(await playwright(page.getByRole('list', { name: 'Fruits' }).locator('li')));
    const banana: LocatorExpression = { kind: 'filter', source: byRole('listitem'), hasText: exact('banana') };
    expect(await located(css('li', banana))).toEqual(['a2-inner']);
    expect(await located(css('li', { kind: 'index', source: css('ul'), index: 'last' }))).toEqual(['b1']);
    const both: LocatorExpression = { kind: 'union', left: byRole('list', 'Greens'), right: fruits };
    expect(await located(css(':scope > li', both))).toEqual(['a1', 'a2', 'b1']);
    // An exact label scope composes through the reader's own label engine, so `Billing address` is no match.
    const billing = query({ kind: 'label', value: exact('Billing') });
    expect(await located(css('.v', billing))).toEqual(['billing-v', 'billing-2-v']);
    // A filter after a position still narrows that scope: the first Billing group does not hold 19.99.
    const firstBilling: LocatorExpression = { kind: 'index', source: billing, index: 'first' };
    expect(await located(css('.v', { kind: 'filter', source: firstBilling, hasText: exact('9.99') }))).toEqual(['billing-v']);
    expect(await located(css('.v', { kind: 'filter', source: firstBilling, hasText: exact('19.99') }))).toEqual([]);
  });

  it('scopes a screen query under it, and nests inside a frame, as Playwright does', async () => {
    const underSelector: LocatorExpression = { kind: 'query', query: { kind: 'role', value: exact('listitem') }, scope: css('ul', css('#a > li')) };
    expect(await located(underSelector)).toEqual(await playwright(page.locator('#a > li').locator('ul').getByRole('listitem')));
    expect(await located(underSelector)).toEqual(['a2-inner']);
    const nested = css('li', css('ul', { kind: 'frame', selector: '#frame', source: css('body') }));
    expect(await located(nested)).toEqual(await playwright(page.frameLocator('#frame').locator('body').locator('ul').locator('li')));
    expect(await located(nested)).toEqual(['f1']);
  });

  it('serves as a has filter, read under each candidate', async () => {
    const withInner: LocatorExpression = { kind: 'filter', source: css('#a > li'), has: css('li', css('ul')) };
    expect(await located(withInner)).toEqual(await playwright(page.locator('#a > li').filter({ has: page.locator('ul').locator('li') })));
    expect(await located(withInner)).toEqual(['a2']);
  });

  it('follows its scope into a frame, and finds nothing under a scope a hidden frame hides', async () => {
    const framed: LocatorExpression = { kind: 'frame', selector: '#frame', source: byRole('list', 'Framed') };
    const [fig] = await engine.locate!(css('li', framed), operation);
    expect(fig?.testId).toBe('f1');
    // The match's box is in the top-level viewport, like any node in a frame.
    const box = (await page.frameLocator('#frame').locator('li').boundingBox())!;
    expect(fig?.rect?.y).toBeCloseTo(box.y, 3);
    // A role query never matches inside a hidden frame, so nothing is under it; a selector scope still reaches.
    expect(await located(css('li', { kind: 'frame', selector: '#hidden', source: byRole('list', 'Hidden') }))).toEqual([]);
    expect(await located(css('li', { kind: 'frame', selector: '#hidden', source: css('ul') }))).toEqual(['h1']);
    await expect(engine.locate!(css('li', { kind: 'frame', selector: '#missing', source: css('ul') }), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
    });
  });

  it('reaches under a scope inside a closed shadow root, as Playwright does from that element', async () => {
    expect(await located(css('li', byRole('list', 'Shadow')))).toEqual(['s1']);
    expect(await located(css('xpath=./li', byRole('list', 'Shadow')))).toEqual(['s1']);
    // Playwright's :scope combinators climb through the root's host, which a closed root does not give back (docs/reference/web.mdx).
    expect(await located(css(':scope > li', byRole('list', 'Shadow')))).toEqual([]);
  });

  it('refuses a display-value scope, whose predicate lives outside Playwright', async () => {
    await expect(engine.locate!(css('span', query({ kind: 'displayValue', value: exact('draft') })), operation)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});
