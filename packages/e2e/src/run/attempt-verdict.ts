/**
 * The verdict of one test attempt as it forms, and the live `TestInfo` that
 * reads it. The runner's `TargetExecutor` (`execute.ts`) and a standalone
 * test run (`standalone-test.ts`) both record into an `AttemptVerdict`, so
 * the attempt's record and what `testInfo.status` says in `afterEach` come
 * from one place.
 */

import path from 'node:path';
import { classifyError, type E2EError, type ErrorPhase, type SerializedError } from '@e2e-dev/core/lib/internal/errors';
import { createTestInfo, sanitizeAnnotations, toTestInfoError } from '@e2e-dev/core/lib/internal/test-info';
import type { AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import { classifyAttemptStatus } from '@e2e-dev/core/lib/run/engine-sessions';
import type { AttemptStatus } from '@e2e-dev/core/lib/run/records';
import type { TestAnnotation, TestInfo, TestInfoError, WorkerInfo } from '@e2e-dev/core/lib/types';
import type { TestTargetPair } from '../collect/select.ts';
import type { CaughtRuntimeSkip } from '../internal/skip.ts';

export interface AttemptVerdictOptions {
  /** Why the attempt is expected to fail before its code runs: the `fail` option. */
  readonly expectedFailure: string | undefined;
  readonly interrupted: () => boolean;
  readonly serialize: (error: E2EError, phase: ErrorPhase) => SerializedError;
}

/** The first failure is the verdict; whatever lands after it is kept beside it. */
export class AttemptVerdict {
  readonly secondaryErrors: SerializedError[] = [];
  readonly #options: AttemptVerdictOptions;
  #failure: { readonly error: E2EError; readonly phase: ErrorPhase } | undefined;
  #skipped: CaughtRuntimeSkip | undefined;
  #expectedFailure: string | undefined;
  #timedOut = false;
  #settled = false;

  constructor(options: AttemptVerdictOptions) {
    this.#options = options;
    this.#expectedFailure = options.expectedFailure;
  }

  get failure(): E2EError | undefined {
    return this.#failure?.error;
  }

  get skipped(): CaughtRuntimeSkip | undefined {
    return this.#skipped;
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  /** Why the attempt is expected to fail: the `fail` option, else the first `test.fail(...)` that marked it. */
  get expectedFailure(): string | undefined {
    return this.#expectedFailure;
  }

  /** Records `cause` in `phase`; `primary` says whether it became the verdict. */
  fail(cause: unknown, phase: ErrorPhase): { readonly error: E2EError; readonly primary: boolean } {
    const error = classifyError(cause);
    if (this.#failure !== undefined) {
      this.secondaryErrors.push(this.#options.serialize(error, phase));
      return { error, primary: false };
    }
    this.#failure = { error, phase };
    return { error, primary: true };
  }

  /** Keeps `cause` beside the verdict without making it one. */
  note(cause: unknown, phase: ErrorPhase): SerializedError {
    const serialized = this.#options.serialize(classifyError(cause), phase);
    this.secondaryErrors.push(serialized);
    return serialized;
  }

  skip(cause: CaughtRuntimeSkip): void {
    this.#skipped = cause;
  }

  timeOut(): void {
    this.#timedOut = true;
  }

  expectFailure(reason: string): void {
    this.#expectedFailure ??= reason;
  }

  /** Ends the body and returns the status it settled on; teardown failures can still turn a pass into a failure. */
  settle(): AttemptStatus {
    this.#settled = true;
    return this.#statusNow();
  }

  /** What `testInfo.status` reads: unknown while the body runs, unless it already failed or skipped. */
  status(): AttemptStatus | undefined {
    if (!this.#settled && this.#failure === undefined && this.#skipped === undefined) return undefined;
    return this.#statusNow();
  }

  serializedFailure(): SerializedError | undefined {
    return this.#failure === undefined ? undefined : this.#options.serialize(this.#failure.error, this.#failure.phase);
  }

  /** The verdict's error first, then every one beside it. */
  errors(): TestInfoError[] {
    const primary = this.serializedFailure();
    return [...(primary === undefined ? [] : [primary]), ...this.secondaryErrors].map(toTestInfoError);
  }

  #statusNow(): AttemptStatus {
    if (this.#failure !== undefined) return classifyAttemptStatus(this.#failure.error, this.#timedOut, this.#options.interrupted());
    return this.#skipped === undefined ? 'passed' : 'skipped';
  }
}

export interface AttemptTestInfoOptions {
  readonly workerInfo: WorkerInfo;
  readonly projectRoot: string;
  readonly pair: TestTargetPair;
  readonly retry: number;
  readonly outputDir: string;
  readonly startedMs: number;
  readonly timeout: AttemptTimeout;
  readonly verdict: AttemptVerdict;
}

export interface AttemptTestInfoHandle {
  readonly testInfo: TestInfo;
  /** Freezes `testInfo.duration` once the attempt is over. */
  finish(durationMs: number): void;
  /** Redacts, sanitizes, and bounds the attempt's annotations for reporting. */
  recordAnnotations(redact: (text: string) => string): TestAnnotation[];
}

/** Creates the live `TestInfo` for one running attempt, reading `verdict` as it forms. */
export function createAttemptTestInfo(options: AttemptTestInfoOptions): AttemptTestInfoHandle {
  const { pair, verdict, startedMs, timeout } = options;
  const annotations: TestAnnotation[] = pair.test.annotations.map((entry) => ({ ...entry }));
  let finalDurationMs: number | undefined;

  const testInfo = createTestInfo({
    workerInfo: options.workerInfo,
    testId: pair.test.id,
    title: pair.test.title,
    titlePath: pair.test.titlePath,
    file: path.resolve(options.projectRoot, pair.test.file),
    line: pair.test.source?.line ?? 1,
    column: pair.test.source?.column ?? 1,
    tags: pair.test.tags,
    agent: pair.agent,
    retry: options.retry,
    repeatEachIndex: pair.repeat,
    outputDir: options.outputDir,
    annotations,
    getTimeout: () => timeout.timeoutMs,
    getDuration: () => finalDurationMs ?? Math.max(0, Date.now() - startedMs),
    getExpectedStatus: () => (verdict.expectedFailure === undefined ? 'passed' : 'failed'),
    getStatus: () => verdict.status(),
    getErrors: () => verdict.errors(),
  });

  return {
    testInfo,
    finish(durationMs: number): void {
      finalDurationMs = durationMs;
    },
    recordAnnotations(redact: (text: string) => string): TestAnnotation[] {
      return sanitizeAnnotations(annotations, redact);
    },
  };
}
