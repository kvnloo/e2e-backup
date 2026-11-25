/**
 * A target's `locators.visible` is the `visible` default of every query
 * except `getByRole`. A `visible` passed to a query takes precedence.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type LocatorExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import type { Locator, Screen } from '@e2e-dev/core/lib/types';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** An email field: the one on screen, or its twin in a closed drawer. */
function emailField(id: string, hidden: boolean): SemanticNode {
  return {
    ref: { id, revision: '' },
    role: 'textbox',
    name: 'Email',
    value: 'ada@example.com',
    testId: 'email',
    attributes: { placeholder: 'you@example.com' },
    states: { hidden },
  };
}

const NODES: readonly SemanticNode[] = [emailField('shown', false), emailField('drawer', true)];

function screenWith(visible: boolean, nodes: readonly SemanticNode[] = NODES): Screen {
  return screenOver({
    observe: () => snapshot(nodes),
    locate: (expression) => resolveExpression(expression, nodes),
    timeoutMs: 300,
    locators: { visible },
  }).screen;
}

const QUERIES: readonly [string, (screen: Screen, options?: { visible?: boolean }) => Locator][] = [
  ['getByText', (screen, options) => screen.getByText('Email', options)],
  ['getByLabel', (screen, options) => screen.getByLabel('Email', options)],
  ['getByPlaceholder', (screen, options) => screen.getByPlaceholder('you@example.com', options)],
  ['getByDisplayValue', (screen, options) => screen.getByDisplayValue('ada@example.com', options)],
  ['getByTestId', (screen, options) => screen.getByTestId('email', options)],
];

describe('locators.visible', () => {
  it.each(QUERIES)('%s skips hidden nodes when visible is true on the target', async (_name, query) => {
    expect(await query(screenWith(true)).count()).toBe(1);
  });

  it.each(QUERIES)('%s keeps hidden nodes when visible: false is passed to the query', async (_name, query) => {
    expect(await query(screenWith(true), { visible: false }).count()).toBe(2);
  });

  it.each(QUERIES)('%s keeps hidden nodes by default, unless visible: true is passed to the query', async (_name, query) => {
    const screen = screenWith(false);

    expect(await query(screen).count()).toBe(2);
    expect(await query(screen, { visible: true }).count()).toBe(1);
  });

  it("doesn't add visible to a role query", async () => {
    const seen: LocatorExpression[] = [];
    const { screen } = screenOver({
      observe: () => snapshot(NODES),
      locate: (expression) => {
        seen.push(expression);

        return resolveExpression(expression, NODES);
      },
      timeoutMs: 300,
      locators: { visible: true },
    });

    await screen.getByRole('textbox', 'Email').count();

    expect(seen.at(-1)).not.toHaveProperty('query.visible');
  });

  it('applies to a query chained under another locator', async () => {
    const form: SemanticNode = { ref: { id: 'form', revision: '' }, role: 'form', name: 'Sign in', children: NODES };

    expect(await screenWith(true, [form]).getByRole('form').getByTestId('email').count()).toBe(1);
    expect(await screenWith(false, [form]).getByRole('form').getByTestId('email').count()).toBe(2);
  });
});
