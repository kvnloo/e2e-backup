/** Detours in a recorded flow: a screen left and come back to with nothing changed on the way. */

import { describe, expect, it } from 'vitest';
import { describeDetour, findDetours } from '@e2e-dev/core/lib/cache/detours';
import type { ActionTrace, RecordedAction } from '@e2e-dev/core/lib/cache/trace';

function tap(name: string, at?: string, role = 'button'): RecordedAction {
  return { name: 'tap', summary: `tap ${role} "${name}"`, target: { role, name }, ...(at === undefined ? {} : { at }) };
}

function scroll(at?: string): RecordedAction {
  return { name: 'scroll', summary: 'scroll down', direction: 'down', ...(at === undefined ? {} : { at }) };
}

function back(at?: string): RecordedAction {
  return { name: 'back', summary: 'go back', ...(at === undefined ? {} : { at }) };
}

function type(name: string, value: string, at?: string): RecordedAction {
  return { name: 'type', summary: `type "${value}" into textbox "${name}"`, target: { role: 'textbox', name }, value, ...(at === undefined ? {} : { at }) };
}

function flow(actions: readonly RecordedAction[], ends: { startPath?: string; endPath?: string } = {}): Pick<ActionTrace, 'actions' | 'startPath' | 'endPath'> {
  return { actions, ...ends };
}

describe('findDetours by recorded locations', () => {
  it('finds the wrong settings page that was scrolled and backed out of', () => {
    // The iOS case: Settings, the wrong page, back, then the right page.
    const detours = findDetours(
      flow(
        [
          tap('Notifications', 'com.example / Settings'),
          scroll('com.example / Notifications'),
          back('com.example / Notifications'),
          tap('Privacy', 'com.example / Settings'),
          tap('Clear history', 'com.example / Privacy'),
        ],
        { endPath: 'com.example / Privacy' },
      ),
    );
    expect(detours).toEqual([{ from: 0, to: 3, at: 'com.example / Settings', via: 'com.example / Notifications', evidence: 'locations' }]);
    expect(describeDetour(detours[0]!)).toBe('actions 1-3 left com.example / Settings for com.example / Notifications and came back with nothing changed');
  });

  it('finds a return at the end of the step, against the end location', () => {
    const detours = findDetours(flow([tap('Reports', '/home'), back('/reports')], { startPath: '/home', endPath: '/home' }));
    expect(detours).toEqual([{ from: 0, to: 2, at: '/home', via: '/reports', evidence: 'locations' }]);
  });

  it('reads two wrong turns from one menu as one detour', () => {
    const detours = findDetours(
      flow([tap('A', '/menu'), back('/a'), tap('B', '/menu'), back('/b'), tap('C', '/menu')], { endPath: '/c' }),
    );
    expect(detours).toEqual([{ from: 0, to: 4, at: '/menu', via: '/a', evidence: 'locations' }]);
  });

  it('is no detour when something was typed or set before going back', () => {
    expect(findDetours(flow([tap('Edit', '/items'), type('Name', 'Ada', '/items/42/edit'), back('/items/42/edit')], { endPath: '/items' }))).toEqual([]);
    expect(findDetours(flow([tap('Display', '/settings'), tap('Dark mode', '/settings/display', 'switch'), back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
  });

  it('is no detour for a flow that stays on one screen or only moves forward', () => {
    expect(findDetours(flow([tap('Open', '/'), tap('Close', '/'), tap('Open', '/')], { endPath: '/' }))).toEqual([]);
    expect(findDetours(flow([tap('Next', '/one'), tap('Next', '/two'), tap('Done', '/three')], { endPath: '/done' }))).toEqual([]);
  });

  it('compares routes, so a record id in the path is the same screen', () => {
    const detours = findDetours(flow([tap('Order', '/orders/123'), back('/invoices'), tap('Ship', '/orders/123')], { endPath: '/orders/123' }));
    expect(detours).toEqual([{ from: 0, to: 2, at: '/orders/123', via: '/invoices', evidence: 'locations' }]);
  });

  it('skips actions whose location is unknown without matching them', () => {
    const detours = findDetours(flow([tap('Help', '/settings'), scroll(), back(), tap('Privacy', '/settings')], { endPath: '/privacy' }));
    // Nothing known stood between the two visits to /settings, so nothing shows the flow left.
    expect(detours).toEqual([]);
  });
});

describe('findDetours on an entry recorded without locations', () => {
  it('reads a tap, looking around, then back as a detour', () => {
    const detours = findDetours(flow([tap('Notifications'), scroll(), scroll(), back(), tap('Privacy')]));
    expect(detours).toEqual([{ from: 0, to: 4, evidence: 'actions' }]);
    expect(describeDetour(detours[0]!)).toBe('actions 1-4 left a screen, only looked around, and went back');
  });

  it('is no detour when the step typed before going back, or never went back', () => {
    expect(findDetours(flow([tap('Edit'), type('Name', 'Ada'), back()]))).toEqual([]);
    expect(findDetours(flow([tap('Next'), scroll(), tap('Done')]))).toEqual([]);
  });

  it('reads locations once any action has one, never mixing in the action shape', () => {
    expect(findDetours(flow([tap('Help', '/settings'), back()], { endPath: '/help' }))).toEqual([]);
  });
});
