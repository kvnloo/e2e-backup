/** Detours in a recorded flow: a screen left and come back to with nothing typed, chosen, or set on the way. */

import { describe, expect, it } from 'vitest';
import { describeDetour, findDetours, settledDetour } from '@e2e-dev/core/lib/cache/detours';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { bound } from '@e2e-dev/core/lib/internal/text';
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

function flow(actions: readonly RecordedAction[], ends: { startPath?: string; endPath?: string; truncated?: boolean } = {}): Pick<ActionTrace, 'actions' | 'startPath' | 'endPath' | 'truncated' | 'detours'> {
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
    expect(describeDetour(detours[0]!)).toBe('actions 1-3 left com.example / Settings for com.example / Notifications and came back with nothing typed, chosen, or set');
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

  it('counts a tap at a point inside a switch as a change, and a hover over one as none', () => {
    const toggled: RecordedAction = {
      name: 'tapAt',
      summary: 'tap the point (40, 80)',
      point: { x: 40, y: 80 },
      viewport: { width: 390, height: 844 },
      within: { target: { role: 'switch', name: 'Dark mode' }, fx: 0.5, fy: 0.5 },
      at: '/settings/display',
    };
    expect(findDetours(flow([tap('Display', '/settings'), toggled, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    // A node tap on the icon inside the switch sets the switch too.
    const iconTap: RecordedAction = { ...tap('Moon', '/settings/display', 'img'), controlRole: 'switch' } as RecordedAction;
    expect(findDetours(flow([tap('Display', '/settings'), iconTap, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    // The icon inside the switch held the point; the switch is the control it set.
    const onIcon: RecordedAction = { ...toggled, within: { target: { role: 'img', name: 'Moon' }, fx: 0.5, fy: 0.5 }, controlRole: 'switch' } as RecordedAction;
    expect(findDetours(flow([tap('Display', '/settings'), onIcon, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    const hovered: RecordedAction = { name: 'hover', summary: 'hover checkbox "Beta"', target: { role: 'checkbox', name: 'Beta' }, at: '/settings/labs' };
    expect(findDetours(flow([tap('Labs', '/settings'), hovered, back('/settings/labs')], { endPath: '/settings' }))).toEqual([
      { from: 0, to: 3, at: '/settings', via: '/settings/labs', evidence: 'locations' },
    ]);
  });

  it('is no detour for a flow that stays on one screen or only moves forward', () => {
    expect(findDetours(flow([tap('Open', '/'), tap('Close', '/'), tap('Open', '/')], { endPath: '/' }))).toEqual([]);
    expect(findDetours(flow([tap('Next', '/one'), tap('Next', '/two'), tap('Done', '/three')], { endPath: '/done' }))).toEqual([]);
  });

  it('finds the trip before a fill recorded as a gap, from where the gap ran', () => {
    const gap: RecordedAction = { name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token', at: '/' };
    expect(findDetours(flow([tap('About', '/'), back('/about'), gap, tap('Increment', '/')], { endPath: '/' }))).toEqual([
      { from: 0, to: 2, at: '/', via: '/about', evidence: 'locations' },
    ]);
  });

  it('finds the trip that ended before a project tool ran, from where the tool ran', () => {
    const tool: RecordedAction = { name: 'tool', summary: 'tool open_billing', at: '/settings' };
    expect(findDetours(flow([tap('Privacy', '/settings'), back('/privacy'), tool], { endPath: '/billing' }))).toEqual([
      { from: 0, to: 2, at: '/settings', via: '/privacy', evidence: 'locations' },
    ]);
  });

  it('names the screen the leaving action stood on, as a stored span does', () => {
    const trip = flow([tap('Top', '/a'), tap('Leave', '/a#top'), back('/b'), tap('Stay', '/a')], { endPath: '/a' });
    const fresh = findDetours(trip);
    expect(fresh).toEqual([{ from: 1, to: 3, at: '/a#top', via: '/b', evidence: 'locations' }]);
    expect(findDetours({ ...trip, detours: fresh.map(({ from, to }) => ({ from, to })) })).toEqual(fresh);
  });

  it('starts at the action that left, not at the looking around before it', () => {
    const detours = findDetours(flow([scroll('/home'), tap('Reports', '/home'), back('/reports'), tap('Billing', '/home')], { endPath: '/billing' }));
    expect(detours).toEqual([{ from: 1, to: 3, at: '/home', via: '/reports', evidence: 'locations' }]);
  });

  it('compares routes, so a record id in the path is the same screen', () => {
    const detours = findDetours(flow([tap('Order', '/orders/123'), back('/invoices'), tap('Ship', '/orders/123')], { endPath: '/orders/123' }));
    expect(detours).toEqual([{ from: 0, to: 2, at: '/orders/123', via: '/invoices', evidence: 'locations' }]);
  });

  it('uses the detours the recording run found, since stored placeholders no longer compare like their values', () => {
    // Recorded as /items/456 -> /items/123 -> /items/456 with 123 a unique() id: one route to the run, no detour.
    const stored = flow([tap('Next', '/items/456'), tap('Back', '/items/{{param:/id}}'), tap('Save', '/items/456')], { endPath: '/items/456' });
    expect(findDetours({ ...stored, detours: [] })).toEqual([]);
    // A slug and a record id: two routes to the run, a detour it kept.
    const kept = flow([tap('Open', '/records/{{param:/slug}}'), back('/records/123'), tap('Save', '/records/{{param:/slug}}')], { endPath: '/done' });
    expect(findDetours({ ...kept, detours: [{ from: 0, to: 2 }] })).toEqual([
      { from: 0, to: 2, at: '/records/{{param:/slug}}', via: '/records/123', evidence: 'locations' },
    ]);
  });

  it('does not read a cut recording\'s end location as where its last kept action led', () => {
    // Actions past the cap (typing, then the way back) ran but were not kept.
    expect(findDetours(flow([tap('Edit', '/'), scroll('/edit')], { endPath: '/', truncated: true }))).toEqual([]);
    expect(findDetours(flow([tap('Edit', '/'), scroll('/edit')], { endPath: '/' }))).toHaveLength(1);
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

  it('reads a point tap on a link as leaving, and one on a switch as setting it', () => {
    const pointOn = (role: string, name: string): RecordedAction => ({
      name: 'tapAt',
      summary: `tap the point (10, 10) on ${role} "${name}"`,
      point: { x: 10, y: 10 },
      viewport: { width: 1280, height: 720 },
      within: { target: { role, name }, fx: 0.5, fy: 0.5 },
    });
    expect(findDetours(flow([pointOn('link', 'Reports'), scroll(), back()]))).toEqual([{ from: 0, to: 3, evidence: 'actions' }]);
    expect(findDetours(flow([pointOn('switch', 'Dark mode'), back()]))).toEqual([]);
  });

  it('is no detour when the step typed before going back, or never went back', () => {
    expect(findDetours(flow([tap('Edit'), type('Name', 'Ada'), back()]))).toEqual([]);
    expect(findDetours(flow([tap('Next'), scroll(), tap('Done')]))).toEqual([]);
  });

  it('reads locations once any action has one, never mixing in the action shape', () => {
    expect(findDetours(flow([tap('Help', '/settings'), back()], { endPath: '/help' }))).toEqual([]);
  });
});

describe('settledDetour', () => {
  const ledger = () => {
    const known = new SecretLedger();
    known.register('token', 'tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    return known;
  };

  it('masks a secret the report bound cut through, ending at the ellipsis', () => {
    const text = bound(`actions 1-2 left / for /${'a'.repeat(560)}?t=tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and came back with nothing typed, chosen, or set`, 600);
    expect(text).toContain('tok-ABCDEFGH…');
    const settled = settledDetour(text, ledger());
    expect(settled).not.toContain('tok-ABC');
    expect(settled.length).toBeLessThanOrEqual(600);
  });

  it('masks a whole secret and keeps the text within the report bound', () => {
    const settled = settledDetour(`actions 1-2 left / for /x?t=tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and came back with nothing typed, chosen, or set`, ledger());
    expect(settled).toBe('actions 1-2 left / for /x?t=<secret:token> and came back with nothing typed, chosen, or set');
    const long = settledDetour(`${'x'.repeat(590)}tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.slice(0, 600), { redact: (text) => text.replaceAll('x', 'xx'), redactCut: (text) => text });
    expect(long.length).toBe(600);
  });
});
