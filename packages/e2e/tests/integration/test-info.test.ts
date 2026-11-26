/**
 * End-to-end tests for `test.info()`, the `testInfo` / `workerInfo` arguments
 * of tests, hooks, and fixtures, `TEST_WORKER_INDEX` / `TEST_PARALLEL_INDEX`,
 * `outputDir` / `outputPath`, live `status` / `error` / `errors` /
 * `expectedStatus` in `afterEach` and fixture teardown, `retry` /
 * `repeatEachIndex`, and static + runtime `annotations` across reports.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject, runProjectWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

describe('test.info() and testInfo / workerInfo integration', () => {
  it('exposes metadata, timeout, duration, outputDir/outputPath, and annotations across tests, hooks, fixtures, and reports', async () => {
    const outFile = 'captured.json';
    const testSource = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test as base } from 'e2e';

const seen = [];
const test = base.extend({
  logPath: async ({}, use, testInfo) => {
    expect(test.info()).toBe(testInfo);
    const file = testInfo.outputPath('fixture-logs', 'run.txt');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'setup:' + testInfo.title + ':' + testInfo.timeout);
    await use(file);
    writeFileSync(file, readFileSync(file, 'utf8') + '|teardown:' + testInfo.status + ':' + testInfo.expectedStatus);
  },
  workerTag: [async ({}, use, workerInfo) => {
    let infoErr = null;
    try {
      test.info();
    } catch (err) {
      infoErr = err.code;
    }
    await use({
      workerIndex: workerInfo.workerIndex,
      parallelIndex: workerInfo.parallelIndex,
      targetName: workerInfo.target.name,
      platform: workerInfo.target.platform,
      projectId: workerInfo.config.projectId,
      infoErr,
    });
  }, { scope: 'worker' }],
});

describe('outer', { tags: ['suite-tag'], annotation: { type: 'area', description: 'checkout' } }, () => {
  let beforeAllInfo = null;
  let afterAllInfo = null;

  test.beforeAll(async ({}, workerInfo) => {
    let infoErr = null;
    try {
      test.info();
    } catch (err) {
      infoErr = err.code;
    }
    beforeAllInfo = {
      workerIndex: workerInfo.workerIndex,
      parallelIndex: workerInfo.parallelIndex,
      target: workerInfo.target.name,
      infoErr,
    };
  });

  test.afterAll(async ({}, workerInfo) => {
    afterAllInfo = { workerIndex: workerInfo.workerIndex, parallelIndex: workerInfo.parallelIndex };
    writeFileSync(path.join(workerInfo.config.projectRoot, '${outFile}'), JSON.stringify({ seen, beforeAllInfo, afterAllInfo }));
  });

  test.beforeEach(async ({}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    expect(testInfo.status).toBeUndefined();
    testInfo.annotations.push({ type: 'hook', description: 'from-beforeEach' });
  });

  test.afterEach(async ({}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    seen.push({
      title: testInfo.title,
      afterStatus: testInfo.status,
      afterExpectedStatus: testInfo.expectedStatus,
      afterErrors: testInfo.errors.map((e) => ({ code: e.code, phase: e.phase })),
      duration: testInfo.duration,
    });
  });

  test(
    'inspects all fields',
    { tags: ['case-tag'], timeout: 10_000, annotation: { type: 'issue', description: 'https://example.com/1233' } },
    async ({ logPath, workerTag }, testInfo) => {
      expect(test.info()).toBe(testInfo);
      expect(testInfo.title).toBe('inspects all fields');
      expect(testInfo.titlePath).toEqual(['outer', 'inspects all fields']);
      expect(testInfo.testId).toBe('tests/info.e2e.ts::outer::inspects%20all%20fields');
      expect(path.isAbsolute(testInfo.file)).toBe(true);
      expect(testInfo.file.endsWith('info.e2e.ts')).toBe(true);
      expect(testInfo.line).toBeGreaterThan(1);
      expect(testInfo.column).toBeGreaterThanOrEqual(1);
      expect(testInfo.tags).toEqual(['suite-tag', 'case-tag']);
      expect(testInfo.agent).toBe('default');
      expect(testInfo.retry).toBe(0);
      expect(testInfo.repeatEachIndex).toBe(0);
      expect(testInfo.target.name).toBe('fake');
      expect(testInfo.target.platform).toBe('fake');
      expect(testInfo.config.projectId).toBeTruthy();
      expect(path.isAbsolute(testInfo.config.projectRoot)).toBe(true);
      expect(path.isAbsolute(testInfo.config.outputDir)).toBe(true);
      expect(testInfo.workerIndex).toBe(Number(process.env.TEST_WORKER_INDEX));
      expect(testInfo.parallelIndex).toBe(Number(process.env.TEST_PARALLEL_INDEX));
      expect(testInfo.timeout).toBe(10_000);
      test.setTimeout(15_000);
      expect(testInfo.timeout).toBe(15_000);
      test.slow();
      expect(testInfo.timeout).toBe(45_000);
      expect(testInfo.duration).toBeGreaterThanOrEqual(0);
      expect(testInfo.expectedStatus).toBe('passed');
      expect(testInfo.status).toBeUndefined();
      expect(testInfo.error).toBeUndefined();
      expect(testInfo.errors).toEqual([]);
      expect(existsSync(testInfo.outputDir)).toBe(true);
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toBe('setup:inspects all fields:10000');
      let escapeCode = null;
      try {
        testInfo.outputPath('..', 'outside.txt');
      } catch (err) {
        escapeCode = err.code;
      }
      expect(escapeCode).toBe('INVALID_ARGUMENT');
      // Secret value pushed into runtime annotation must be redacted in report.
      testInfo.annotations.push({ type: 'runtime', description: 'leaked MY_TOP_SECRET_VALUE here' });
      seen.push({ workerTag, logPath });
    },
  );

  test.each([{ label: 'alpha' }])('each $label', async ({ label }, {}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    expect(testInfo.title).toBe('each ' + label);
  });

  test.for([['x', 'y']])('for %j', async (row, {}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    expect(row).toEqual(['x', 'y']);
    expect(testInfo.title).toContain('for');
  });
});
`;

    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/info.e2e.ts': testSource },
      {
        configSource: workerFakeConfigSource(
          1,
          "\n  reporters: ['list', 'junit', 'ctrf', 'markdown'],\n  trace: 'on',\n  secrets: { token: 'MY_TOP_SECRET_VALUE' },",
        ),
      },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);

      const captured = JSON.parse(readFileSync(path.join(project.dir, outFile), 'utf8')) as {
        seen: Record<string, unknown>[];
        beforeAllInfo: Record<string, unknown>;
        afterAllInfo: Record<string, unknown>;
      };
      expect(captured.beforeAllInfo).toMatchObject({ workerIndex: 0, parallelIndex: 0, target: 'fake', infoErr: 'INVALID_ARGUMENT' });
      expect(captured.afterAllInfo).toEqual({ workerIndex: 0, parallelIndex: 0 });

      const firstBody = captured.seen[0] as { workerTag: Record<string, unknown>; logPath: string };
      expect(firstBody.workerTag).toMatchObject({ workerIndex: 0, parallelIndex: 0, targetName: 'fake', platform: 'fake', infoErr: 'INVALID_ARGUMENT' });
      expect(readFileSync(firstBody.logPath, 'utf8')).toBe('setup:inspects all fields:10000|teardown:passed:passed');

      const afterMain = captured.seen.find((entry) => entry['title'] === 'inspects all fields');
      expect(afterMain).toMatchObject({
        afterStatus: 'passed',
        afterExpectedStatus: 'passed',
        afterErrors: [],
      });

      // Report carries static + runtime annotations with secrets redacted.
      const reportResult = outcome.report.run.results.find((r) => r.titlePath.at(-1) === 'inspects all fields')!;
      expect(reportResult.annotations).toEqual([
        { type: 'area', description: 'checkout' },
        { type: 'issue', description: 'https://example.com/1233' },
        { type: 'hook', description: 'from-beforeEach' },
        { type: 'runtime', description: 'leaked <secret:token> here' },
      ]);
      expect(JSON.stringify(outcome.report)).not.toContain('MY_TOP_SECRET_VALUE');

      // JUnit, CTRF, markdown, and trace.md all include annotations (and never the secret).
      const junitXml = readFileSync(path.join(project.dir, '.e2e/junit.xml'), 'utf8');
      expect(junitXml).toContain('<property name="issue" value="https://example.com/1233"/>');
      expect(junitXml).not.toContain('MY_TOP_SECRET_VALUE');

      const ctrfJson = readFileSync(path.join(project.dir, '.e2e/ctrf.json'), 'utf8');
      expect(ctrfJson).toContain('"https://example.com/1233"');
      expect(ctrfJson).not.toContain('MY_TOP_SECRET_VALUE');

      const summaryMd = readFileSync(path.join(project.dir, '.e2e/summary.md'), 'utf8');
      expect(summaryMd).toContain('issue: `https://example.com/1233`');
      expect(summaryMd).not.toContain('MY_TOP_SECRET_VALUE');
    } finally {
      project.cleanup();
    }
  });

  it('reports status, expectedStatus, error, and errors accurately in afterEach and fixture teardown across outcomes', async () => {
    const logPath = 'outcomes.jsonl';
    const { engine } = createFakeEngine();
    const testSource = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test as base } from 'e2e';

const record = (info, tag) => {
  appendFileSync(
    path.join(info.config.projectRoot, '${logPath}'),
    JSON.stringify({
      tag,
      title: info.title,
      status: info.status,
      expectedStatus: info.expectedStatus,
      errorCode: info.error?.code,
      errorCodes: info.errors.map((e) => e.code),
      errorPhases: info.errors.map((e) => e.phase),
    }) + '\\n',
  );
};

const test = base.extend({
  watcher: [async ({}, use, testInfo) => {
    await use('ok');
    record(testInfo, 'fixture-teardown');
  }, { auto: true }],
});

describe('outcomes', () => {
  test.afterEach(async ({}, testInfo) => {
    record(testInfo, 'afterEach');
  });

  test('passes normally', async () => {
    expect(1).toBe(1);
  });

  test('fails assertion', async () => {
    expect(1).toBe(2);
  });

  test('times out', { timeout: 150 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  test('skips at runtime', async () => {
    test.skip('not applicable');
  });

  test('fails softly', async () => {
    expect.soft(1).toBe(2);
  });

  test.fail('expected to fail and fails', async () => {
    expect(1).toBe(2);
  });

  test.fail('expected to fail but passes', async () => {
    expect(1).toBe(1);
  });
});

describe('multiple errors in teardown', () => {
  test.afterEach(async ({}, testInfo) => {
    record(testInfo, 'afterEach-first');
  });

  test.afterEach(async () => {
    throw new Error('afterEach boom');
  });

  test('body fails then afterEach fails', async () => {
    expect('a').toBe('b');
  });
});

describe('passes then afterEach fails', () => {
  test.afterEach(async ({}, testInfo) => {
    record(testInfo, 'afterEach-later');
  });

  test.afterEach(async () => {
    throw new Error('afterEach boom');
  });

  test('passes before a failing afterEach', async () => {
    expect(1).toBe(1);
  });
});

describe('steps', () => {
  test('reads info in a step', async ({}, testInfo) => {
    await test.step('read info', async () => {
      expect(test.info()).toBe(testInfo);
      record(test.info(), 'in-step');
    });
  });
});
`;

    const { outcome, project } = await runProject(
      { 'tests/outcomes.e2e.ts': testSource },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      assertValidReport(outcome.report);
      const lines = readFileSync(path.join(project.dir, logPath), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const byTitleAndTag = (title: string, tag: string) =>
        lines.find((entry) => entry['title'] === title && entry['tag'] === tag);

      for (const tag of ['afterEach', 'fixture-teardown']) {
        expect(byTitleAndTag('passes normally', tag)).toMatchObject({
          status: 'passed',
          expectedStatus: 'passed',
          errorCodes: [],
        });
        expect(byTitleAndTag('fails assertion', tag)).toMatchObject({
          status: 'failed',
          expectedStatus: 'passed',
          errorCode: 'ASSERTION_FAILED',
          errorCodes: ['ASSERTION_FAILED'],
        });
        expect(byTitleAndTag('times out', tag)).toMatchObject({
          status: 'timed-out',
          expectedStatus: 'passed',
          errorCode: 'TEST_TIMEOUT',
        });
        expect(byTitleAndTag('skips at runtime', tag)).toMatchObject({
          status: 'skipped',
          expectedStatus: 'passed',
          errorCodes: [],
        });
        expect(byTitleAndTag('fails softly', tag)).toMatchObject({
          status: 'failed',
          expectedStatus: 'passed',
          errorCode: 'ASSERTION_FAILED',
        });
        expect(byTitleAndTag('expected to fail and fails', tag)).toMatchObject({
          status: 'failed',
          expectedStatus: 'failed',
          errorCode: 'ASSERTION_FAILED',
        });
        expect(byTitleAndTag('expected to fail but passes', tag)).toMatchObject({
          status: 'passed',
          expectedStatus: 'failed',
          errorCodes: [],
        });
      }

      // afterEach hooks run in reverse declaration order: the later one sees the earlier one's failure.
      for (const tag of ['afterEach-later', 'fixture-teardown']) {
        expect(byTitleAndTag('passes before a failing afterEach', tag)).toMatchObject({
          status: 'failed',
          errorCode: 'ERROR',
          errorCodes: ['ERROR'],
          errorPhases: ['afterEach'],
        });
      }

      const inStep = byTitleAndTag('reads info in a step', 'in-step');
      expect(inStep).toMatchObject({ title: 'reads info in a step', expectedStatus: 'passed', errorCodes: [] });
      expect(inStep?.['status']).toBeUndefined();

      // Fixture teardown runs after both afterEach hooks and sees both errors (body + afterEach).
      const multiTeardown = byTitleAndTag('body fails then afterEach fails', 'fixture-teardown');
      expect(multiTeardown).toMatchObject({
        status: 'failed',
        errorCode: 'ASSERTION_FAILED',
        errorCodes: ['ASSERTION_FAILED', 'ERROR'],
        errorPhases: ['body', 'afterEach'],
      });
    } finally {
      project.cleanup();
    }
  });

  it('tracks retry, repeatEachIndex, workerIndex (monotonic on respawn), parallelIndex (reused), and env vars', async () => {
    const logPath = 'workers.jsonl';
    const fileA = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'e2e';

test('flaky on retry', { retries: 1 }, async ({}, testInfo) => {
  appendFileSync(
    path.join(testInfo.config.projectRoot, '${logPath}'),
    JSON.stringify({
      title: testInfo.title,
      retry: testInfo.retry,
      repeatEachIndex: testInfo.repeatEachIndex,
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      envWorker: process.env.TEST_WORKER_INDEX,
      envParallel: process.env.TEST_PARALLEL_INDEX,
    }) + '\\n',
  );
  if (testInfo.retry === 0) {
    testInfo.annotations.push({ type: 'attempt', description: 'first' });
    expect(1).toBe(2);
  }
  testInfo.annotations.push({ type: 'attempt', description: 'second' });
});
`;
    const fileB = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

test('always fails', { retries: 0 }, async ({}, testInfo) => {
  appendFileSync(
    path.join(testInfo.config.projectRoot, '${logPath}'),
    JSON.stringify({
      title: testInfo.title,
      retry: testInfo.retry,
      repeatEachIndex: testInfo.repeatEachIndex,
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      envWorker: process.env.TEST_WORKER_INDEX,
      envParallel: process.env.TEST_PARALLEL_INDEX,
    }) + '\\n',
  );
  throw new Error('force worker respawn');
});
`;
    const fileC = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

test('runs after respawn', async ({}, testInfo) => {
  appendFileSync(
    path.join(testInfo.config.projectRoot, '${logPath}'),
    JSON.stringify({
      title: testInfo.title,
      retry: testInfo.retry,
      repeatEachIndex: testInfo.repeatEachIndex,
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      envWorker: process.env.TEST_WORKER_INDEX,
      envParallel: process.env.TEST_PARALLEL_INDEX,
    }) + '\\n',
  );
});
`;

    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/a.e2e.ts': fileA,
        'tests/b.e2e.ts': fileB,
        'tests/c.e2e.ts': fileC,
      },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: { repeatEach: 2 },
      },
    );
    try {
      assertValidReport(outcome.report);
      const entries = readFileSync(path.join(project.dir, logPath), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as {
          title: string;
          retry: number;
          repeatEachIndex: number;
          workerIndex: number;
          parallelIndex: number;
          envWorker: string;
          envParallel: string;
        });

      // Every entry's env vars match its TestInfo worker/parallel index.
      for (const entry of entries) {
        expect(entry.envWorker).toBe(String(entry.workerIndex));
        expect(entry.envParallel).toBe(String(entry.parallelIndex));
        expect(entry.parallelIndex).toBe(0);
      }

      // Flaky test ran retry 0 and retry 1 for each repeat (0 and 1).
      const flakyRuns = entries.filter((entry) => entry.title === 'flaky on retry');
      expect(flakyRuns.map((e) => [e.repeatEachIndex, e.retry])).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]);

      // After 'always fails' kills its worker, a replacement spawns with a higher workerIndex while parallelIndex stays 0.
      const uniqueWorkerIndices = [...new Set(entries.map((e) => e.workerIndex))];
      expect(uniqueWorkerIndices.length).toBeGreaterThanOrEqual(2);
      expect(uniqueWorkerIndices[0]).toBe(0);
      expect(uniqueWorkerIndices[1]).toBe(1);

      // Flaky test's attempt 0 and attempt 1 keep their own annotations in the report, and the result carries the final attempt's.
      const flakyResult = outcome.report.run.results.find((r) => r.titlePath.at(-1) === 'flaky on retry' && r.repeat === 0)!;
      expect(flakyResult.attempts[0]!.annotations).toEqual([{ type: 'attempt', description: 'first' }]);
      expect(flakyResult.attempts[1]!.annotations).toEqual([{ type: 'attempt', description: 'second' }]);
      expect(flakyResult.annotations).toEqual([{ type: 'attempt', description: 'second' }]);
    } finally {
      project.cleanup();
    }
  });

  it('passes WorkerInfo to a worker fixture override and TestInfo to a test-scoped one', async () => {
    const { engine } = createFakeEngine();
    const testSource = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test as base } from 'e2e';

const test = base
  .extend({
    account: [async ({}, use) => {
      await use('acct');
    }, { scope: 'worker' }],
  })
  .extend({
    account: [async ({ account }, use, workerInfo) => {
      await use(account + ':w' + workerInfo.workerIndex + ':' + ('title' in workerInfo ? 'test' : 'worker'));
    }, { scope: 'worker' }],
  })
  .extend({
    account: [async ({ account }, use, info) => {
      await use(account + ':' + ('title' in info ? String(info.title) : 'worker'));
    }, { scope: 'test' }],
  });

test('reads its account', async ({ account }, testInfo) => {
  appendFileSync(path.join(testInfo.config.projectRoot, 'accounts.txt'), account);
});
`;
    const { outcome, project } = await runProject(
      { 'tests/overrides.e2e.ts': testSource },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      expect(outcome.report.run.results.map((result) => result.status)).toEqual(['passed']);
      expect(readFileSync(path.join(project.dir, 'accounts.txt'), 'utf8')).toMatch(/^acct:w\d+:worker:reads its account$/);
    } finally {
      project.cleanup();
    }
  });

  it('supports testInfo and annotations inside serial groups and setup tests', async () => {
    const { engine } = createFakeEngine({ state: true });
    const { outcome, project } = await runProject(
      {
        'tests/auth.setup.e2e.ts': `import { expect, test } from 'e2e';
test.setup('login', { sessions: ['user'], annotation: { type: 'phase', description: 'setup' } }, async ({ session }, testInfo) => {
  expect(test.info()).toBe(testInfo);
  expect(testInfo.title).toBe('login');
  testInfo.annotations.push({ type: 'runtime', description: 'saved-session' });
  await session.save('user');
});
`,
        'tests/serial.e2e.ts': `import { describe, expect, test } from 'e2e';
describe('serial flow', { serial: true, session: 'user', annotation: { type: 'flow', description: 'serial' } }, () => {
  test('step one', { annotation: { type: 'step', description: '1' } }, async ({}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    expect(testInfo.title).toBe('step one');
    testInfo.annotations.push({ type: 'extra', description: 'one' });
  });
  test('step two', async ({}, testInfo) => {
    expect(test.info()).toBe(testInfo);
    expect(testInfo.title).toBe('step two');
    testInfo.annotations.push({ type: 'extra', description: 'two' });
  });
});
`,
      },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);
      const byTitle = (title: string) => outcome.report.run.results.find((r) => r.titlePath.at(-1) === title)!;
      expect(byTitle('login').annotations).toEqual([
        { type: 'phase', description: 'setup' },
        { type: 'runtime', description: 'saved-session' },
      ]);
      expect(byTitle('step one').annotations).toEqual([
        { type: 'flow', description: 'serial' },
        { type: 'step', description: '1' },
        { type: 'extra', description: 'one' },
      ]);
      expect(byTitle('step two').annotations).toEqual([
        { type: 'flow', description: 'serial' },
        { type: 'extra', description: 'two' },
      ]);
    } finally {
      project.cleanup();
    }
  });

  it('fails collection when test.info() is called at file top level', async () => {
    const { engine } = createFakeEngine();
    const { outcome, project } = await runProject(
      {
        'tests/outside.e2e.ts': `import { test } from 'e2e';
test.info();
test('never reached', async () => {});
`,
      },
      { config: engineConfig(engine) },
    );
    try {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors[0]?.code).toBe('COLLECTION_ERROR');
    } finally {
      project.cleanup();
    }
  });
});
