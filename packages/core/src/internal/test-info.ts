/** Runtime `TestInfo` and `WorkerInfo` builders, `test.info()` lookup, and annotation sanitization. */

import path from 'node:path';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { currentAttempt } from '../expect/attempt.ts';
import { outlivesTest } from '../expect/poll-scope.ts';
import type {
  TestAnnotation,
  TestConfigInfo,
  TestInfo,
  TestInfoError,
  TestInfoStatus,
  TestTargetInfo,
  WorkerInfo,
} from '../types.ts';
import { CollectionError, sanitizeRecordedText, TestError, truncateUtf8, type SerializedError } from './errors.ts';
import { isPlainObject } from './options.ts';
import { runningSuiteHook } from './test-timeout.ts';

/** Max UTF-8 bytes kept for an annotation's `type` in reports. */
export const MAX_ANNOTATION_TYPE_BYTES = 256;
/** Max UTF-8 bytes kept for an annotation's `description` in reports. */
export const MAX_ANNOTATION_DESCRIPTION_BYTES = 8192;
/** Max annotations kept per attempt or result in reports. */
export const MAX_ANNOTATIONS = 256;

type TestInfoErrorPhase = NonNullable<TestInfoError['phase']>;

/** Every phase `TestInfoError` names; the record type fails to compile when the union and this list part. */
const TEST_INFO_ERROR_PHASES: Readonly<Record<TestInfoErrorPhase, true>> = {
  launch: true,
  beforeEach: true,
  body: true,
  afterEach: true,
  cleanup: true,
};

function isTestInfoErrorPhase(value: string): value is TestInfoErrorPhase {
  return Object.hasOwn(TEST_INFO_ERROR_PHASES, value);
}

/**
 * Returns `TestInfo` for the currently running test attempt. Refuses calls
 * outside a running test, in a suite hook (`beforeAll`/`afterAll`), in a
 * worker-scoped fixture, or in a hosted session that runs no e2e test.
 */
export function currentTestInfo(): TestInfo {
  if (outlivesTest()) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'test.info() is not available inside a worker-scoped fixture: a worker fixture outlives any single test; use its third parameter (workerInfo) instead',
    );
  }
  if (runningSuiteHook() !== undefined) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'test.info() is not available inside a beforeAll or afterAll hook; use its second parameter (workerInfo) instead',
    );
  }
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError(
      'test.info() can only be called inside a running test, beforeEach, afterEach, or test-scoped fixture',
    );
  }
  if (attempt.testInfo === undefined) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'test.info() is not available in a hosted session without a running e2e test',
    );
  }
  return attempt.testInfo;
}

/** Builds a frozen read-only summary of one resolved target. */
export function buildTargetInfo(target: ResolvedTarget): TestTargetInfo {
  return Object.freeze({
    name: target.name,
    platform: target.platform,
    url: target.app.base?.href,
    environment: target.app.environment,
    fullyParallel: target.fullyParallel,
  });
}

/** Builds a frozen read-only summary of the resolved run config, without secrets or live handles. */
export function buildConfigInfo(config: ResolvedConfig, headed: boolean): TestConfigInfo {
  return Object.freeze({
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    outputDir: config.output,
    timeout: config.timeout,
    launchTimeout: config.launchTimeout,
    actionTimeout: config.actionTimeout,
    assertionTimeout: config.assertionTimeout,
    cleanupTimeout: config.cleanupTimeout,
    retries: config.retries,
    workers: config.workers,
    headed,
    targets: Object.freeze(config.targets.map(buildTargetInfo)),
  });
}

/** Builds a frozen `WorkerInfo` for one worker and target. */
export function buildWorkerInfo(options: {
  readonly workerIndex: number;
  readonly parallelIndex: number;
  readonly target: ResolvedTarget;
  readonly config: ResolvedConfig;
  readonly headed: boolean;
}): WorkerInfo {
  return Object.freeze({
    workerIndex: options.workerIndex,
    parallelIndex: options.parallelIndex,
    target: buildTargetInfo(options.target),
    config: buildConfigInfo(options.config, options.headed),
  });
}

/**
 * Resolves `pathSegments` inside `outputDir`, refusing non-string segments
 * and any path that escapes `outputDir`.
 */
export function resolveOutputPath(outputDir: string, pathSegments: readonly string[]): string {
  for (const segment of pathSegments) {
    if (typeof segment !== 'string') {
      throw new TestError('INVALID_ARGUMENT', `testInfo.outputPath() path segments must be strings, got ${typeof segment}`);
    }
  }
  const base = path.resolve(outputDir);
  const resolved = path.resolve(base, ...pathSegments);
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TestError('INVALID_ARGUMENT', 'testInfo.outputPath() must stay inside testInfo.outputDir');
  }
  return resolved;
}

/**
 * Normalizes, redacts, sanitizes, and bounds annotations before they enter a
 * record or report. Invalid entries pushed at runtime are ignored rather than
 * breaking report schema validation, and an empty description is dropped.
 */
export function sanitizeAnnotations(
  annotations: readonly unknown[],
  redact: (text: string) => string,
): TestAnnotation[] {
  const result: TestAnnotation[] = [];
  for (const entry of annotations) {
    if (result.length >= MAX_ANNOTATIONS) break;
    if (!isPlainObject(entry)) continue;
    const rawType = entry['type'];
    if (typeof rawType !== 'string' || rawType.trim() === '') continue;
    const type = truncateUtf8(sanitizeRecordedText(redact(rawType)), MAX_ANNOTATION_TYPE_BYTES);
    if (type.trim() === '') continue;
    const rawDescription = entry['description'];
    const description =
      typeof rawDescription === 'string'
        ? truncateUtf8(sanitizeRecordedText(redact(rawDescription)), MAX_ANNOTATION_DESCRIPTION_BYTES)
        : '';
    // An empty description is no description, so reports test one thing.
    result.push(description === '' ? { type } : { type, description });
  }
  return result;
}

/** Narrows a redacted `SerializedError` to the public `TestInfoError` shape. */
export function toTestInfoError(error: SerializedError): TestInfoError {
  const phase = error.phase !== undefined && isTestInfoErrorPhase(error.phase) ? error.phase : undefined;
  return Object.freeze({
    code: error.code,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(phase === undefined ? {} : { phase }),
  });
}

export interface CreateTestInfoOptions {
  readonly workerInfo: WorkerInfo;
  readonly testId: string;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly tags: readonly string[];
  readonly agent: string;
  readonly retry: number;
  readonly repeatEachIndex: number;
  readonly outputDir: string;
  readonly annotations: TestAnnotation[];
  readonly getTimeout: () => number;
  readonly getDuration: () => number;
  readonly getExpectedStatus: () => 'passed' | 'failed';
  readonly getStatus: () => TestInfoStatus | undefined;
  readonly getErrors: () => readonly TestInfoError[];
}

/** Creates the live `TestInfo` object for one running test attempt. */
export function createTestInfo(options: CreateTestInfoOptions): TestInfo {
  const titlePath = Object.freeze([...options.titlePath]);
  const tags = Object.freeze([...options.tags]);
  const outputDir = options.outputDir;
  return {
    workerIndex: options.workerInfo.workerIndex,
    parallelIndex: options.workerInfo.parallelIndex,
    target: options.workerInfo.target,
    config: options.workerInfo.config,
    testId: options.testId,
    title: options.title,
    titlePath,
    file: options.file,
    line: options.line,
    column: options.column,
    tags,
    agent: options.agent,
    retry: options.retry,
    repeatEachIndex: options.repeatEachIndex,
    outputDir,
    annotations: options.annotations,
    get timeout(): number {
      return options.getTimeout();
    },
    get duration(): number {
      return options.getDuration();
    },
    get expectedStatus(): 'passed' | 'failed' {
      return options.getExpectedStatus();
    },
    get status(): TestInfoStatus | undefined {
      return options.getStatus();
    },
    get error(): TestInfoError | undefined {
      return options.getErrors()[0];
    },
    get errors(): readonly TestInfoError[] {
      return Object.freeze([...options.getErrors()]);
    },
    outputPath(...pathSegments: string[]): string {
      return resolveOutputPath(outputDir, pathSegments);
    },
  };
}
