/** Validation and inheritance helpers for `test`, `test.setup`, and `describe` options. */

import { describeValue } from '@e2e-dev/core/lib/config/validate';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { expectedFailureOption } from '@e2e-dev/core/lib/internal/expected-failure';
import { isPlainObject, unknownKeyMessage } from '@e2e-dev/core/lib/internal/options';
import { isRecordingMode, legacyTraceSpelling, RECORDING_MODES } from '@e2e-dev/core/lib/internal/recording-modes';
import { sanitizeAnnotations } from '@e2e-dev/core/lib/internal/test-info';
import { MAX_TIMER_MS } from '@e2e-dev/core/lib/internal/time';
import type { DescribeOptions, SetupOptions, TestAnnotation, TestOptions } from '@e2e-dev/core/lib/types';

/** Structural slice of `GroupNode` option validation inspects. */
export interface OptionGroup {
  readonly options: DescribeOptions;
  readonly serial: boolean;
}

/** The option a `describe` variant sets on its group: `describe.fail` sets `fail`, `describe.only` sets `only`. */
export type GroupMark = 'fail' | 'only';

/** The keys `test()` takes. */
const TEST_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  skip: true,
  fail: true,
  only: true,
  platforms: true,
  session: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
  annotation: true,
} satisfies Record<keyof TestOptions, true>);

/** The keys `test.setup()` takes beside `sessions`, which registration lifts out first. */
const SETUP_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  platforms: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
  annotation: true,
} satisfies Record<Exclude<keyof SetupOptions, 'sessions'>, true>);

/** The keys `test.describe()` takes. */
const DESCRIBE_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  skip: true,
  fail: true,
  platforms: true,
  session: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
  annotation: true,
  serial: true,
  parallel: true,
  only: true,
} satisfies Record<keyof DescribeOptions, true>);

/** The tags along the describe chain and the test's own, outermost first, each once. */
export function declaredTags(chain: readonly OptionGroup[], options: TestOptions): string[] {
  const layers = [...chain.map((node) => node.options), options];
  return [...new Set(layers.flatMap((layer) => layer.tags ?? []))];
}

/** The annotations along the describe chain and the test's own, outermost first, redacted. */
export function declaredAnnotations(
  chain: readonly OptionGroup[],
  options: TestOptions,
  redact: (text: string) => string,
): TestAnnotation[] {
  const layers = [...chain.map((node) => node.options), options];
  const raw: TestAnnotation[] = [];
  for (const { annotation } of layers) {
    if (annotation === undefined) continue;
    raw.push(...(isAnnotationList(annotation) ? annotation : [annotation]));
  }
  return sanitizeAnnotations(raw, redact);
}

/** `Array.isArray` does not narrow a readonly array out of a union. */
function isAnnotationList(value: TestAnnotation | readonly TestAnnotation[]): value is readonly TestAnnotation[] {
  return Array.isArray(value);
}

/**
 * The checks tests and groups share: only the option `keys` the call takes,
 * so a misspelled `timout` fails instead of leaving the default in place,
 * and each known option's value.
 */
function validateCommonOptions(options: TestOptions | DescribeOptions, label: string, keys: readonly string[]): void {
  if (Object.hasOwn(options, 'requires')) {
    throw new CollectionError(`${label}: requires was removed; scope the test to targets with platforms, e.g. platforms: ['web']`);
  }
  const unknown = unknownKeyMessage(label, options, keys);
  if (unknown !== undefined) throw new CollectionError(unknown);
  if (options.only !== undefined && typeof options.only !== 'boolean') {
    throw new CollectionError(`${label}: only must be true or false, got ${describeValue(options.only)}`);
  }
  if (options.timeout !== undefined) {
    if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
      throw new CollectionError(`${label}: timeout must be a positive safe integer`);
    }
    if (options.timeout > MAX_TIMER_MS) {
      throw new CollectionError(`${label}: timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${options.timeout}`);
    }
  }
  if (options.retries !== undefined) {
    if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10) {
      throw new CollectionError(`${label}: retries must be an integer from 0 through 10`);
    }
  }
  if (options.agent !== undefined) validateAgentOption(options.agent, label);
  if (options.tags !== undefined) validateTagsOption(options.tags, label);
  if (options.annotation !== undefined) validateAnnotationOption(options.annotation, label);
  for (const kind of ['trace', 'video'] as const) {
    const mode = options[kind];
    if (mode !== undefined && !isRecordingMode(mode)) {
      const legacy = kind === 'trace' ? legacyTraceSpelling(mode) : undefined;
      throw new CollectionError(
        legacy === undefined
          ? `${label}: ${kind} must be one of ${RECORDING_MODES.join(', ')}, got ${describeValue(mode)}`
          : `${label}: trace ${legacy.was} is the old spelling of trace: '${legacy.mode}'; the modes are ${RECORDING_MODES.join(', ')}`,
      );
    }
  }
}

/**
 * `tags` lists distinct tag names, checked here beside `timeout`, `retries`,
 * and `agent`. Unchecked, the mistake is silent: a bare string is iterable,
 * so `tags: 'smoke'` would register the tags `s`, `m`, `o`, `k`, `e` and
 * `--tag smoke` would never select the test.
 */
function validateTagsOption(tags: unknown, label: string): void {
  if (!Array.isArray(tags)) {
    throw new CollectionError(
      `${label}: tags must be a list of tag names, e.g. tags: ['smoke'], got ${describeValue(tags)}`,
    );
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!isTagName(tag)) {
      throw new CollectionError(
        `${label}: every tag must be a non-blank string with no comma and no leading or trailing whitespace, got ${describeValue(tag)}`,
      );
    }
    if (seen.has(tag)) throw new CollectionError(`${label}: tags lists ${JSON.stringify(tag)} twice`);
    seen.add(tag);
  }
}

/**
 * A tag name is whatever `--tag` can spell back: the flag splits its values
 * on commas and trims them, so a name holds no comma and no leading or
 * trailing whitespace. Inner spaces are fine (`'Login Form'`, quoted).
 */
function isTagName(tag: unknown): tag is string {
  return typeof tag === 'string' && tag !== '' && tag.trim() === tag && !tag.includes(',');
}

/** Validates `{ type, description? }` or a list of annotations. */
function validateAnnotationOption(annotation: unknown, label: string): void {
  const list = Array.isArray(annotation) ? annotation : [annotation];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      throw new CollectionError(
        `${label}: annotation must be { type, description? } or a list of annotations, got ${describeValue(entry)}`,
      );
    }
    const unknown = unknownKeyMessage(`${label}: annotation`, entry, ['type', 'description']);
    if (unknown !== undefined) throw new CollectionError(unknown);
    const { type, description } = entry as { type?: unknown; description?: unknown };
    if (typeof type !== 'string' || type.trim() === '') {
      throw new CollectionError(`${label}: annotation.type must be a non-blank string, got ${describeValue(type)}`);
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new CollectionError(`${label}: annotation.description must be a string, got ${describeValue(description)}`);
    }
  }
}

/** `agent` names one configured agent, or lists several distinct ones to run the test once each. */
function validateAgentOption(agent: unknown, label: string): void {
  if (typeof agent === 'string') {
    if (agent === '') throw new CollectionError(`${label}: agent must be the name of a configured agent`);
    return;
  }
  if (!Array.isArray(agent) || agent.length === 0) {
    throw new CollectionError(
      `${label}: agent must be the name of a configured agent, or a non-empty list of names`,
    );
  }
  for (const name of agent) {
    if (typeof name !== 'string' || name === '') {
      throw new CollectionError(`${label}: every entry of agent must be the name of a configured agent`);
    }
  }
  if (new Set(agent).size !== agent.length) {
    throw new CollectionError(`${label}: agent lists each name once`);
  }
}

function validateFailOption(fail: unknown, label: string): void {
  if (fail !== undefined && typeof fail !== 'boolean' && typeof fail !== 'string') {
    throw new CollectionError(`${label}: fail must be true, false, or a reason string, got ${describeValue(fail)}`);
  }
}

/** Validates options passed to `test()` or `test.setup()`. */
export function validateTestOptions(options: TestOptions, chain: readonly OptionGroup[], kind: 'test' | 'setup'): void {
  if (kind === 'setup') validateCommonOptions(options, 'setup options', SETUP_OPTION_KEYS);
  else validateCommonOptions(options, 'test options', TEST_OPTION_KEYS);
  validateFailOption(options.fail, 'test options');
  if (chain.some((node) => node.serial)) {
    const forbidden: (keyof TestOptions)[] = [
      'retries',
      'trace',
      'video',
      'session',
      'platforms',
      'skip',
      'fail',
      'only',
    ];
    for (const key of forbidden) {
      if (options[key] !== undefined) {
        throw new CollectionError(
          `test option "${key}" cannot be overridden inside a serial group; it belongs to the unit`,
        );
      }
    }
  }
}

/** Validates options passed to `describe()`, `describe.fail()`, or `describe.only()`. */
export function validateDescribeOptions(options: DescribeOptions, chain: readonly OptionGroup[], mark: GroupMark | undefined): void {
  validateCommonOptions(options, 'describe options', DESCRIBE_OPTION_KEYS);
  validateFailOption(options.fail, 'describe options');
  const inSerial = chain.some((node) => node.serial);
  if (options.serial === true && inSerial) {
    throw new CollectionError('nested serial groups are collection errors');
  }
  // Focus inside a serial group would run part of a unit; the serial group itself can be focused.
  if ((mark === 'only' || options.only !== undefined) && inSerial) {
    throw new CollectionError('describe option "only" cannot be set inside a serial group, which runs as one unit; focus the serial group instead');
  }
  // A serial group's members cannot be marked expected to fail, so neither can the group.
  if ((mark === 'fail' || options.fail !== undefined) && (options.serial === true || inSerial)) {
    throw new CollectionError('describe option "fail" cannot be set on or inside a serial group, which runs as one unit');
  }
  if (options.serial === true && chain.some((group) => expectedFailureOption(group.options.fail) !== undefined)) {
    throw new CollectionError('a serial group cannot sit inside a group marked fail; its members cannot be expected to fail');
  }
  // The serial group records as one unit, so a describe inside it cannot choose its own recordings.
  for (const kind of ['trace', 'video'] as const) {
    if (options[kind] !== undefined && inSerial) {
      throw new CollectionError(`describe option "${kind}" cannot be set inside a serial group; set it on the serial group or a group around it`);
    }
  }
}
