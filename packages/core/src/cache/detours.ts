/**
 * Detours in a recorded flow.
 *
 * A recording replays whatever the recording run did, a wrong turn
 * included: an agent that opened the wrong settings page, scrolled it, and
 * backed out before it took the right one passed, so its recording passes
 * on every replay too, and the wasted actions run each time without a word.
 * A detour here is the mechanical shape of that wrong turn: the flow left a
 * screen and came back to it, and nothing on the way typed, chose, or set
 * anything. Going back after a change (a detail page edited, then left) is
 * ordinary navigation and is not one.
 *
 * Routes compare as the cache compares them (`sameRoute`), so a record id in
 * the path is not a new screen. Each action carries the location it ran at
 * (`RecordedAction.at`) on entries recorded since that was added; for older
 * entries, which have none, the actions alone are read for the narrowest
 * shape of the same thing: a tap or a navigate, nothing but looking around
 * after it, then `back`.
 *
 * A detour is a hint, never a verdict: an instruction that asks to look at
 * a page and return is one by design. The report and `e2e cache check` name
 * it; neither replay nor recording treats it differently.
 */

import { bound } from '../internal/text.ts';
import { routeKey } from './route.ts';
import type { ActionTrace, RecordedAction } from './trace.ts';

/** What the detour check reads of a trace. */
type DetourInput = Pick<ActionTrace, 'actions' | 'startPath' | 'endPath' | 'truncated' | 'detours'>;

/** One stretch of a recording that left a screen and came back to it with nothing typed, chosen, or set on the way. */
export interface TraceDetour {
  /** Zero-based index of the first action of the detour: the one that left. */
  readonly from: number;
  /**
   * Zero-based index of the action the flow went on with once it was back,
   * or the number of actions when it came back at the end of the step.
   */
  readonly to: number;
  /** The location it left and came back to; absent when only the actions' shape shows the detour. */
  readonly at?: string;
  /** The first other location it went to; absent when only the actions' shape shows the detour. */
  readonly via?: string;
  /** `locations` when the recorded locations show it, `actions` when an entry without them is read by its actions alone. */
  readonly evidence: 'locations' | 'actions';
}

/** Verbs that put a value, a choice, or a state into the app, or that a replay cannot see into. */
const CHANGING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>([
  'type',
  'typeSecret',
  'typeText',
  'select',
  'check',
  'upload',
  'drag',
  'dragAt',
  'press',
  'pressKey',
  'tool',
]);

/** Roles whose tap sets a state, as `check` and `select` would. */
const STATE_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'switch',
  'radio',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
]);

/** Verbs that only look: what an agent does on a page it then backs out of. */
const LOOKING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>([
  'scroll',
  'scrollUntil',
  'scrollTo',
  'hover',
  'hoverAt',
]);

/** Verbs that leave a screen in the shape an entry without locations is read for. */
const LEAVING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>(['tap', 'doubleTap', 'tapAt', 'navigate']);

/**
 * Whether an action may have changed what the app holds, so a return after
 * it is not a detour. A tap counts when it landed on a control that holds a
 * state, by its target or, for a tap at a point, the node the point was in;
 * hovering over or scrolling to such a control sets nothing.
 */
function changesState(action: RecordedAction): boolean {
  if (CHANGING_ACTIONS.has(action.name)) return true;
  const role = tappedRole(action);
  return role !== undefined && STATE_ROLES.has(role);
}

/** The role of the control a tap landed on, or undefined for an action that taps nothing. */
function tappedRole(action: RecordedAction): string | undefined {
  switch (action.name) {
    case 'tap':
    case 'doubleTap':
    case 'longPress':
    case 'secondaryTap':
      return action.controlRole ?? action.target.role;
    case 'tapAt':
      return action.controlRole ?? action.within?.target.role;
    default:
      return undefined;
  }
}

/**
 * Every detour in a recording, in order and never overlapping: the ones the
 * recording run found, when the entry keeps them, since a stored location
 * spells each `unique()` value as a placeholder and no longer compares the
 * way the run's did; else read by locations when any action carries one,
 * else by the actions' shape alone.
 */
export function findDetours(trace: DetourInput): TraceDetour[] {
  if (trace.detours !== undefined) return recorded(trace);
  return trace.actions.some((action) => action.at !== undefined) ? byLocations(trace) : byActions(trace.actions);
}

/**
 * The spans the recording run kept, named by the locations as stored: the
 * screen the span started on, and the first other location it reached.
 */
function recorded(trace: DetourInput): TraceDetour[] {
  const where = places(trace);
  return (trace.detours ?? []).map(({ from, to }) => {
    const at = where[from];
    const via = where.slice(from + 1, to).find((place) => place !== undefined && place !== at);
    return { from, to, ...(at === undefined ? {} : { at }), ...(via === undefined ? {} : { via }), evidence: 'locations' as const };
  });
}

/**
 * Where the flow stood before each action, then where it ended: the first
 * action falls back to the step's start location, the last place is the
 * step's end location. An unknown place is undefined and matches nothing.
 * A recording cut at the action cap ran actions it did not keep, so its end
 * location is not where its last kept action led.
 */
function places(trace: DetourInput): (string | undefined)[] {
  const end = trace.truncated === true ? undefined : trace.endPath;
  return [...trace.actions.map((action, index) => action.at ?? (index === 0 ? trace.startPath : undefined)), end];
}

/**
 * For each action that stood on a known place, the last return to the same
 * route that followed a departure from it, with nothing typed, chosen, or set on the way.
 * The last, so a flow that tried two wrong pages from one menu reads as one
 * detour; a return, so actions that stay home after it are not part of it.
 */
function byLocations(trace: DetourInput): TraceDetour[] {
  const where = places(trace);
  // Each route read once: the scan compares every place with many others.
  const keys = new Map<string, string>();
  const route = (place: string): string => {
    let key = keys.get(place);
    if (key === undefined) {
      key = routeKey(place);
      keys.set(place, key);
    }
    return key;
  };
  const { actions } = trace;
  const detours: TraceDetour[] = [];
  let from = 0;
  while (from < actions.length) {
    const home = where[from];
    if (home === undefined) {
      from += 1;
      continue;
    }
    let via: string | undefined;
    let back: number | undefined;
    let away = false;
    // The action that left: the last one known to stand home before the first departure.
    let left = from;
    for (let to = from + 1; to <= actions.length; to += 1) {
      if (changesState(actions[to - 1]!)) break;
      const place = where[to];
      if (place === undefined) continue;
      if (route(home) !== route(place)) {
        via ??= place;
        away = true;
      } else if (via === undefined) {
        left = to;
      } else if (away) {
        // A return after another departure; staying home after it adds nothing.
        back = to;
        away = false;
      }
    }
    if (back === undefined || via === undefined) {
      from += 1;
      continue;
    }
    // Named by the place the leaving action stood on, as a stored span is (`recorded`): the same route, maybe spelled otherwise.
    detours.push({ from: left, to: back, at: where[left] ?? home, via, evidence: 'locations' });
    from = back;
  }
  return detours;
}

/** A tap or navigate, only looking after it, then `back`: an entry without locations, read by its actions. */
function byActions(actions: readonly RecordedAction[]): TraceDetour[] {
  const detours: TraceDetour[] = [];
  let from = 0;
  while (from < actions.length) {
    const leaving = actions[from]!;
    if (!LEAVING_ACTIONS.has(leaving.name) || changesState(leaving)) {
      from += 1;
      continue;
    }
    let next = from + 1;
    while (next < actions.length && LOOKING_ACTIONS.has(actions[next]!.name)) next += 1;
    if (actions[next]?.name !== 'back') {
      from += 1;
      continue;
    }
    detours.push({ from, to: next + 1, evidence: 'actions' });
    from = next + 1;
  }
  return detours;
}

/** Characters of `step.cache.detour` the report admits (report-1). */
const MAX_DETOUR_REPORT_CHARS = 600;

/**
 * A step's detour text once its attempt settled, masked by the ledger as it
 * is then: a secret a later step resolved may be in a location the text
 * names. Where the report's bound cut the text it ends in an ellipsis, so a
 * value the cut went through is what ends before it (`redactCut`). Bounded
 * again after, since a marker can be longer than the value it replaced.
 */
export function settledDetour(detour: string, ledger: { readonly redact: (text: string) => string; readonly redactCut: (text: string) => string }): string {
  const masked = detour.endsWith('…') ? `${ledger.redactCut(detour.slice(0, -1))}…` : ledger.redact(detour);
  return bound(masked, MAX_DETOUR_REPORT_CHARS);
}

/**
 * One detour as a line names it, actions numbered from 1 as the report
 * numbers them: `actions 2-4 left /settings for /settings/privacy and came
 * back with nothing typed, chosen, or set`. That is all the rule can show:
 * a plain button tap on the way may still have saved something.
 */
export function describeDetour(detour: TraceDetour): string {
  // Every detour spans two actions at least: one that left, one that came back.
  const span = `actions ${String(detour.from + 1)}-${String(detour.to)}`;
  if (detour.evidence === 'actions') return `${span} left a screen, only looked around, and went back`;
  return `${span} left ${detour.at ?? 'a screen'} for ${detour.via ?? 'another'} and came back with nothing typed, chosen, or set`;
}
