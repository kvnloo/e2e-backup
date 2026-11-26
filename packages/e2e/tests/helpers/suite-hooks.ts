/** Suite hooks for a `RealmManager` with no executor behind it: each hook gets `platform` alone, as on an engine that isolates every attempt. */

import type { TestInfo, WorkerInfo } from '@e2e-dev/core/lib/types';
import { runHook, type SuiteHookSession } from '../../src/run/realm.ts';

export function toyWorkerInfo(platform = 'web'): WorkerInfo {
  const target = Object.freeze({ name: platform, platform, url: undefined, environment: 'test' as const, fullyParallel: false });
  return Object.freeze({
    workerIndex: 0,
    parallelIndex: 0,
    target,
    config: Object.freeze({
      projectId: 'test',
      projectRoot: '/tmp/test',
      outputDir: '/tmp/test/.e2e',
      timeout: 120_000,
      launchTimeout: 60_000,
      actionTimeout: 30_000,
      assertionTimeout: 5_000,
      cleanupTimeout: 30_000,
      retries: 0,
      workers: 1,
      headed: false,
      targets: Object.freeze([target]),
    }),
  });
}

export function toyTestInfo(platform = 'web'): TestInfo {
  const worker = toyWorkerInfo(platform);
  return {
    ...worker,
    testId: 'tests/example.e2e.ts::example',
    title: 'example',
    titlePath: ['example'],
    file: '/tmp/test/tests/example.e2e.ts',
    line: 1,
    column: 1,
    tags: [],
    agent: 'default',
    retry: 0,
    repeatEachIndex: 0,
    timeout: 120_000,
    duration: 0,
    expectedStatus: 'passed',
    status: undefined,
    error: undefined,
    errors: [],
    annotations: [],
    outputDir: '/tmp/test/.e2e/results/example/attempt-1',
    outputPath: (...segments: string[]) => ['/tmp/test/.e2e/results/example/attempt-1', ...segments].join('/'),
  };
}

export function plainSuiteHooks(platform = 'web'): () => SuiteHookSession {
  const workerInfo = toyWorkerInfo(platform);
  return () => ({
    run: (hook, timeoutMs) => runHook(`${hook.kind} hook`, () => hook.fn({ platform }, workerInfo), timeoutMs),
    close: async () => {},
  });
}
