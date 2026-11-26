/**
 * Shared `TestInfo` lifecycle for one test attempt, used by both the runner's
 * `TargetExecutor` (`execute.ts`) and standalone test runs (`standalone-test.ts`)
 * so status, expectedStatus, errors, duration, and annotation seeding never drift.
 */

import path from 'node:path';
import type { E2EError, SerializedError } from '@e2e-dev/core/lib/internal/errors';
import { createTestInfo, sanitizeAnnotations, toTestInfoError } from '@e2e-dev/core/lib/internal/test-info';
import type { AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import { classifyAttemptStatus } from '@e2e-dev/core/lib/run/engine-sessions';
import type { TestAnnotation, TestInfo, TestInfoError, TestInfoStatus, WorkerInfo } from '@e2e-dev/core/lib/types';
import type { TestTargetPair } from '../collect/select.ts';

/** Live attempt state read lazily when user code inspects `testInfo`. */
export interface AttemptInfoState {
  readonly failure: () => E2EError | undefined;
  readonly skipped: () => boolean;
  readonly settled: () => boolean;
  readonly timedOut: () => boolean;
  readonly interrupted: () => boolean;
  readonly expectedFailure: () => string | undefined;
  readonly secondaryErrors: readonly SerializedError[];
  readonly serializeFailure: (failure: E2EError) => SerializedError;
}

export interface AttemptTestInfoOptions {
  readonly workerInfo: WorkerInfo;
  readonly projectRoot: string;
  readonly pair: TestTargetPair;
  readonly retry: number;
  readonly outputDir: string;
  readonly startedMs: number;
  readonly timeout: AttemptTimeout;
  readonly state: AttemptInfoState;
}

export interface AttemptTestInfoHandle {
  readonly testInfo: TestInfo;
  /** Freezes `testInfo.duration` to the attempt's recorded `durationMs`. */
  finish(durationMs: number): void;
  /** Redacts, sanitizes, and bounds the attempt's annotations for reporting. */
  recordAnnotations(redact: (text: string) => string): TestAnnotation[];
}

/** Creates the live `TestInfo` and finalization handle for one running attempt. */
export function createAttemptTestInfo(options: AttemptTestInfoOptions): AttemptTestInfoHandle {
  const { pair, state, startedMs, timeout } = options;
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
    getExpectedStatus: () => (state.expectedFailure() !== undefined ? 'failed' : 'passed'),
    getStatus: (): TestInfoStatus | undefined => {
      const currentFailure = state.failure();
      if (!state.settled() && currentFailure === undefined && !state.skipped()) return undefined;
      if (currentFailure !== undefined) return classifyAttemptStatus(currentFailure, state.timedOut(), state.interrupted());
      if (state.skipped()) return 'skipped';
      return 'passed';
    },
    getErrors: (): readonly TestInfoError[] => {
      const all: TestInfoError[] = [];
      const currentFailure = state.failure();
      if (currentFailure !== undefined) all.push(toTestInfoError(state.serializeFailure(currentFailure)));
      for (const secondary of state.secondaryErrors) all.push(toTestInfoError(secondary));
      return all;
    },
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
