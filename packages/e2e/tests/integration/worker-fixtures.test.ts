/** Worker-scoped fixtures and the suite hooks that receive them, on an engine that isolates each attempt and on one whose state outlives it. */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { hookLog, LOG_MODULE } from '../helpers/hook-log.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, resultByTitle, runProject, workerFakeConfigSource } from '../helpers/run-project.ts';

function runFixtureCLI(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const cli = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'run'], {
    cwd,
    env: { ...process.env, ...env, CI: '', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(readFileSync(path.join(cwd, '.e2e/report.json'), 'utf8')) as Report1Document;
}

describe('worker fixtures', () => {
  it('keeps a forwarded import separate from an explicit user freshness query', () => {
    const imports = [
      ['../support.mjs?variant=base', '?variant=base'],
      ['../forward.mjs?e2e=blue', '?variant=base'],
      ['../support.mjs?variant=base&e2e=blue', '?variant=base&e2e=blue'],
    ];
    const tests = Object.fromEntries(imports.map(([specifier, search], index) => [
      `tests/${index}.e2e.ts`,
      `import { expect } from 'e2e';
import { test } from ${JSON.stringify(specifier)};
test('gets the fixture for its import', ({ value }) => {
  expect(new URL(value).search).toBe(${JSON.stringify(search)});
});
`,
    ]));
    const project = createProject({
      ...tests,
      'e2e.config.ts': workerFakeConfigSource(1),
      'forward.mjs': "export { test } from './support.mjs?variant=base';",
      'support.mjs': `import { test as base } from 'e2e';
import { appendFileSync } from 'node:fs';
export const test = base.extend({
  value: [async ({}, use) => {
    appendFileSync('setups.txt', new URL(import.meta.url).search + '\\n');
    await use(import.meta.url);
  }, { scope: 'worker' }],
});
test.beforeEach(() => {});
`,
    });
    try {
      runFixtureCLI(project.dir);
      expect(readFileSync(path.join(project.dir, 'setups.txt'), 'utf8')).toBe('?variant=base\n?variant=base&e2e=blue\n');
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it('reuses a fixed-port fixture declared in the test file when a test retries', () => {
    const project = createProject({
      'e2e.config.ts': workerFakeConfigSource(1, 'retries: 1,'),
      'tests/retry.e2e.ts': `import { test as base, expect } from 'e2e';
import { createServer } from 'node:net';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const test = base.extend<{}, { port: number }>({
  port: [async ({}, use) => {
    const portFile = 'fixture-port.txt';
    const port = existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : 0;
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
    const boundPort = server.address().port;
    writeFileSync(portFile, String(boundPort));
    appendFileSync('events.txt', 'setup\\n');
    try {
      await use(boundPort);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      appendFileSync('events.txt', 'teardown\\n');
    }
  }, { scope: 'worker' }],
});
test('retries after the first attempt fails', ({ port }) => {
  expect(port).toBeGreaterThan(0);
  if (existsSync('first-attempt.txt')) return;
  writeFileSync('first-attempt.txt', '');
  throw new Error('intentional first-attempt failure');
});
`,
    });
    try {
      const report = runFixtureCLI(project.dir);
      assertValidReport(report);
      expect(report.run.results[0]).toMatchObject({
        status: 'flaky',
        attempts: [{ status: 'failed', error: { message: 'intentional first-attempt failure' } }, { status: 'passed' }],
      });
      expect(readFileSync(path.join(project.dir, 'events.txt'), 'utf8')).toBe('setup\nteardown\n');
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it.each([
    ['before', false],
    ['after', false],
    ['before', true],
    ['after', true],
  ] as const)('tracks instrumented retries with a resolver registered %s and changing fragments set to %s', (order, changes) => {
    const config = workerFakeConfigSource(1, 'retries: 1,');
    const project = createProject({
      'e2e.config.ts': order === 'after' ? `import './instrument.mjs';\n${config}` : config,
      'instrument.mjs': `
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:') && new URL(result.url).pathname.endsWith('/retry.e2e.ts')) {
    const fragment = ${changes} && existsSync('retried') ? '#second' : '#first';
    return { ...result, url: result.url + fragment };
  }
  return result;
} });
`,
      'tests/retry.e2e.ts': `
import { test as base, expect } from 'e2e';
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
const fragment = new URL(import.meta.url).hash;
const test = base.extend<{}, { value: string }>({
  value: [async ({}, use) => {
    const lock = 'worker' + fragment;
    appendFileSync('events.txt', 'setup ' + fragment + '\\n');
    writeFileSync(lock, '', { flag: 'wx' });
    try {
      await use(fragment);
    } finally {
      rmSync(lock);
      appendFileSync('events.txt', 'teardown ' + fragment + '\\n');
    }
  }, { scope: 'worker' }],
});
test('retries with the resolved fragment', ({ value }) => {
  expect(value).toBe(fragment);
  if (existsSync('retried')) return;
  writeFileSync('retried', '');
  throw new Error('intentional first-attempt failure');
});
`,
    });
    try {
      const env = order === 'before'
        ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=./instrument.mjs`.trim() }
        : {};
      const report = runFixtureCLI(project.dir, env);
      expect(report.run.results[0]).toMatchObject({
        status: 'flaky',
        attempts: [{ status: 'failed', error: { message: 'intentional first-attempt failure' } }, { status: 'passed' }],
      });
      const events = readFileSync(path.join(project.dir, 'events.txt'), 'utf8').trim().split('\n');
      const expected = ['setup #first', 'teardown #first'];
      if (changes) expected.push('setup #second', 'teardown #second');
      expect(events.toSorted()).toEqual(expected.toSorted());
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it.each(['before', 'after'])('reuses each user-fragment helper on retry with a resolver registered %s the loader', (order) => {
    const config = workerFakeConfigSource(1, 'retries: 1,');
    const project = createProject({
      'e2e.config.ts': order === 'after' ? `import './instrument.mjs';\n${config}` : config,
      'instrument.mjs': `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:') && new URL(result.url).pathname.endsWith('/support.ts')) {
    return { ...result, url: result.url + '#instrumented' };
  }
  return result;
} });
`,
      'tests/support.ts': `
import { test as base } from 'e2e';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
const fragment = new URL(import.meta.url).hash;
export const test = base.extend<{}, { value: string }>({
  value: [async ({}, use) => {
    const lock = 'worker' + fragment;
    appendFileSync('events.txt', 'setup ' + fragment + '\\n');
    writeFileSync(lock, '', { flag: 'wx' });
    try {
      await use(fragment);
    } finally {
      rmSync(lock);
      appendFileSync('events.txt', 'teardown ' + fragment + '\\n');
    }
  }, { scope: 'worker' }],
});
test.beforeEach(() => {});
`,
      'tests/retry.e2e.ts': `
import { expect } from 'e2e';
import { existsSync, writeFileSync } from 'node:fs';
import { test as one } from './support.ts?variant=app#one';
import { test as inner } from './support.ts?variant=app#one#inner';

for (const [test, expected] of [[one, '#one#instrumented'], [inner, '#one#inner#instrumented']] as const) {
  test('retries ' + expected, ({ value }) => {
    expect(value).toBe(expected);
    const marker = 'retried' + expected;
    if (existsSync(marker)) return;
    writeFileSync(marker, '');
    throw new Error('intentional first-attempt failure');
  });
}
`,
    });
    try {
      const env = order === 'before'
        ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=./instrument.mjs`.trim() }
        : {};
      const report = runFixtureCLI(project.dir, env);
      expect(report.run.results.map((test) => test.attempts.map((attempt) => attempt.status))).toEqual([
        ['failed', 'passed'],
        ['failed', 'passed'],
      ]);
      const events = readFileSync(path.join(project.dir, 'events.txt'), 'utf8').trim().split('\n');
      expect(events.toSorted()).toEqual([
        'setup #one#inner#instrumented',
        'setup #one#instrumented',
        'teardown #one#inner#instrumented',
        'teardown #one#instrumented',
      ]);
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it('separates user import URLs and reuses the fixture when the loader reloads the same URL', () => {
    const imports = [
      '?a=1&b=2#one',
      '?b=2&a=1#one',
      '?a=1&b=2#two',
      '?e2e=user-a&e2e-graph=user-a',
      '?e2e=user-b&e2e-graph=user-a',
      '?e2e=user-a&e2e-graph=user-b',
      '?a=a%20b',
      '?a=a+b',
      '?a=1&b=2#one',
    ];
    const tests = Object.fromEntries(imports.map((suffix, index) => {
      const { search, hash } = new URL(suffix, 'file:///support.ts');
      return [`tests/${index}.e2e.ts`, `
import { expect } from 'e2e';
import { test } from './support.ts${suffix}';
test(${JSON.stringify('uses fixture for ' + suffix)}, ({ fixtureURL }) => {
  const url = new URL(fixtureURL);
  expect(url.search.split('&').slice(0, ${search.split('&').length}).join('&')).toBe(${JSON.stringify(search)});
  expect(url.hash).toBe(${JSON.stringify(hash)});
});
`];
    }));
    const log = hookLog('worker-fixture-urls');
    const project = createProject({
      ...tests,
      'e2e.config.ts': workerFakeConfigSource(1),
      'tests/log.ts': LOG_MODULE,
      'tests/support.ts': `import { test as base } from 'e2e';
import { log } from './log.ts';
export const test = base.extend<{}, { fixtureURL: string }>({
  fixtureURL: [async ({}, use) => {
    log('setup');
    await use(import.meta.url);
    log('teardown');
  }, { scope: 'worker' }],
});
test.beforeEach(() => {});
`,
    });
    try {
      runFixtureCLI(project.dir);
      const instances = new Set(imports).size;
      expect(log.lines()).toEqual([...Array<string>(instances).fill('setup'), ...Array<string>(instances).fill('teardown')]);
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it(
    'sets a worker fixture up once per worker, shares it with the suite hooks, and tears it down after the last test',
    async () => {
      // Declared in a module the test file imports, so the instance outlives the re-import after a failure.
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';

let starts = 0;
export const test = base
  .extend<{}, { database: { id: number } }>({
    database: [async ({ platform }, use) => {
      starts += 1;
      log('setup:database:' + platform + ':' + starts);
      await use({ id: starts });
      log('teardown:database');
    }, { scope: 'worker' }],
  })
  .extend<{ page: string }>({
    page: async ({ database }, use) => {
      log('setup:page:' + database.id);
      await use('page-' + database.id);
      log('teardown:page');
    },
  });
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('suite', () => {
  test.beforeAll(({ database, platform }) => log('beforeAll:' + platform + ':' + database.id));
  test.afterAll(({ database }) => log('afterAll:' + database.id));
  test('first', ({ page, database }) => log('body:first:' + page + ':' + database.id));
  test('fails', () => {
    log('body:fails');
    throw new Error('boom');
  });
  test('after the failure', ({ database }) => log('body:after:' + database.id));
});
`;
      const log = hookLog('worker-fixtures');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/worker.e2e.ts': file },
        { config: engineConfig(createFakeEngine({ fixtures: true }).engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(resultByTitle(outcome, 'first').status).toBe('passed');
        expect(resultByTitle(outcome, 'fails').status).toBe('failed');
        expect(resultByTitle(outcome, 'after the failure').status).toBe('passed');
        expect(outcome.report.run.errors).toEqual([]);
        expect(log.lines()).toEqual([
          'setup:database:fake:1',
          'beforeAll:fake:1',
          'setup:page:1',
          'body:first:page-1:1',
          'teardown:page',
          // `page` is set up for the test that names it, and for no other.
          'body:fails',
          // The failure discards the suite instance; the next test enters a fresh one, on the same database.
          'afterAll:1',
          'beforeAll:fake:1',
          'body:after:1',
          'afterAll:1',
          'teardown:database',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    "hands suite hooks and worker fixtures the engine's fixtures when its state outlives an attempt",
    async () => {
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';

type Gadget = { poke(what: string): Promise<string> };
export const test = base.extend<{}, { gadget: Gadget }>().extend<{}, { keeper: string }>({
  keeper: [async ({ gadget }, use) => {
    log('setup:keeper:' + await gadget.poke('keeper-setup'));
    await use('kept');
    log('teardown:keeper:' + await gadget.poke('keeper-teardown'));
  }, { scope: 'worker' }],
});
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('device suite', () => {
  test.beforeAll(async ({ gadget, app, screen, keeper }) => {
    log('beforeAll:' + await gadget.poke('beforeAll') + ':' + keeper + ':' + typeof app.open + ':' + typeof screen.getByRole);
  });
  test.afterAll(async ({ gadget }) => log('afterAll:' + await gadget.poke('afterAll')));
  test('one', async ({ gadget }) => log('body:' + await gadget.poke('one')));
  test('two', async ({ gadget, keeper }) => log('body:' + await gadget.poke('two') + ':' + keeper));
});

test.describe('serial', { serial: true }, () => {
  test.beforeAll(async ({ gadget }) => log('serial:beforeAll:' + await gadget.poke('serial')));
  test('s1', async ({ gadget }) => log('body:' + await gadget.poke('s1')));
  test('s2', async ({ gadget }) => log('body:' + await gadget.poke('s2')));
});
`;
      const log = hookLog('device-hooks');
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        for (const title of ['one', 'two', 's1', 's2']) expect(resultByTitle(outcome, title).status).toBe('passed');
        expect(log.lines()).toEqual([
          'setup:keeper:poked keeper-setup',
          'beforeAll:poked beforeAll:kept:function:function',
          'body:poked one',
          'body:poked two:kept',
          'afterAll:poked afterAll',
          'serial:beforeAll:poked serial',
          'body:poked s1',
          'body:poked s2',
          'teardown:keeper:poked keeper-teardown',
        ]);
        // Each pass of suite hooks outside a serial group runs in a short attempt
        // of its own; the serial group's hook runs on the group's attempt, and the
        // worker fixture's teardown in one more before the engine is disposed.
        expect(fake.events).toEqual([
          'init',
          'startAttempt:0',
          'endAttempt:0',
          'startAttempt:1',
          'endAttempt:1',
          'startAttempt:2',
          'endAttempt:2',
          'startAttempt:3',
          'endAttempt:3',
          'startAttempt:4',
          'endAttempt:4',
          'startAttempt:5',
          'endAttempt:5',
          'dispose',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'fails a suite hook that left an engine step running, as that hook, and charges no test with it',
    async () => {
      const file = `import { test as base } from 'e2e';
import { log } from './log.ts';

const test = base.extend<{}, { gadget: { hang(options: { timeout: number }): Promise<void> } }>();

test.describe('left running', () => {
  test.beforeAll(({ gadget }) => {
    // Not awaited: it fails 150 ms later, long after the hook returned.
    void gadget.hang({ timeout: 150 });
  });
  test('skipped by its hook', () => log('unreachable'));
});

test('after the hook', async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  log('body:after');
});
`;
      const log = hookLog('suite-hook-step-not-awaited');
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine, { retries: 0 }) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }))).toEqual([
          { code: 'HOOK_FAILED', phase: 'beforeAll', message: 'beforeAll failed: the beforeAll hook returned before gadget.hang finished; put `await` in front of every step call' },
        ]);
        expect(resultByTitle(outcome, 'skipped by its hook').skip?.cause).toBe('hook-failed');
        // The step's own failure, arriving once the hook's attempt has closed, is no later test's.
        expect(resultByTitle(outcome, 'after the hook').status).toBe('passed');
        expect(log.lines()).toEqual(['body:after']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'names the hook or the fixture that left an engine step running, not the test body',
    async () => {
      const file = `import { test as base } from 'e2e';

type Gadget = { hang(options: { timeout: number }): Promise<void> };
const test = base.extend<{}, { gadget: Gadget }>().extend<{ armed: string }, { warmed: string }>({
  armed: async ({ gadget }, use) => {
    void gadget.hang({ timeout: 150 });
    await use('armed');
  },
  warmed: [async ({ gadget }, use) => {
    void gadget.hang({ timeout: 150 });
    await use('warmed');
  }, { scope: 'worker' }],
});

test.describe('in beforeEach', () => {
  test.beforeEach(({ gadget }) => {
    void gadget.hang({ timeout: 150 });
  });
  test('hook', () => {});
});

test('test fixture', ({ armed }) => void armed);

test('worker fixture', ({ warmed }) => void warmed);

test.describe('in afterAll', () => {
  test.afterAll(({ gadget }) => {
    void gadget.hang({ timeout: 150 });
  });
  test('passes', () => {});
});
`;
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject({ 'tests/device.e2e.ts': file }, { config: engineConfig(fake.engine, { retries: 0, workers: 1 }) });
      const notAwaited = (owner: string): string => `${owner} returned before gadget.hang finished; put \`await\` in front of every step call`;
      try {
        assertValidReport(outcome.report);
        const failure = (title: string): unknown => {
          const error = resultByTitle(outcome, title).attempts[0]?.error;
          return { code: error?.code, message: error?.message };
        };
        expect(failure('hook')).toEqual({ code: 'STEP_NOT_AWAITED', message: notAwaited('the beforeEach hook') });
        expect(failure('test fixture')).toEqual({ code: 'STEP_NOT_AWAITED', message: notAwaited('the fixture "armed" setup') });
        expect(failure('worker fixture')).toEqual({ code: 'STEP_NOT_AWAITED', message: notAwaited('the fixture "warmed" setup') });
        expect(resultByTitle(outcome, 'passes').status).toBe('passed');
        expect(outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }))).toEqual([
          { code: 'HOOK_FAILED', phase: 'afterAll', message: `afterAll failed: ${notAwaited('the afterAll hook')}` },
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  // The support module for the two cases below: a worker fixture whose
  // teardown tries the engine's fixture and logs what happened.
  const keeperSupport = `import { test as base } from 'e2e';
import { log } from './log.ts';

type Gadget = { poke(what: string): Promise<string> };
export const test = base.extend<{}, { gadget: Gadget }>().extend<{}, { keeper: string }>({
  keeper: [async ({ gadget }, use) => {
    await use('kept');
    log('teardown:keeper');
    try {
      log(await gadget.poke('teardown'));
    } catch (error) {
      log('teardown:gadget:' + (error as { code: string }).code + ':' + (error as Error).message);
    }
  }, { scope: 'worker' }],
});
`;

  it(
    'still runs afterAll and the worker teardown when the attempt they run in cannot open',
    async () => {
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('device suite', () => {
  test.afterAll(({ keeper }) => log('afterAll:' + keeper));
  test.afterAll(async ({ gadget }) => log('afterAll:gadget:' + await gadget.poke('afterAll')));
  test('one', async ({ keeper }) => log('body:' + keeper));
});
`;
      const log = hookLog('device-gone');
      // The test's attempt opens; every attempt after it fails, the way a device that went away does.
      const fake = createFakeEngine({
        fixtures: true,
        isolation: 'worker',
        onStartAttempt: (_, index) => {
          if (index > 0) throw new Error('device went away');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': keeperSupport, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(resultByTitle(outcome, 'one').status).toBe('passed');
        expect(log.lines()).toEqual([
          'body:kept',
          'afterAll:kept',
          'teardown:keeper',
          'teardown:gadget:ENGINE_FAILURE:"gadget" is not available to the fixture "keeper" teardown: the attempt suite hooks run in could not open: device went away',
        ]);
        // One launch failure for the afterAll pass and one for the teardowns, never one per hook.
        const errors = outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }));
        expect(errors).toEqual([
          { code: 'ENGINE_FAILURE', phase: 'launch', message: expect.stringContaining('device went away') },
          {
            code: 'HOOK_FAILED',
            phase: 'afterAll',
            message: expect.stringContaining('"gadget" is not available to the afterAll hook: the attempt suite hooks run in could not open: device went away'),
          },
          { code: 'ENGINE_FAILURE', phase: 'launch', message: expect.stringContaining('device went away') },
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'opens no attempt for afterAll or the worker teardown after an interrupt',
    async () => {
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('device suite', () => {
  test.afterAll(({ keeper }) => log('afterAll:' + keeper));
  test('fails', ({ keeper }) => {
    log('body:' + keeper);
    throw new Error('boom');
  });
  test('never runs', () => log('unreachable'));
});
`;
      const log = hookLog('device-interrupted');
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': keeperSupport, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine, { retries: 0 }), runOptions: { maxFailures: 1 } },
      );
      try {
        assertValidReport(outcome.report);
        expect(resultByTitle(outcome, 'fails').status).toBe('failed');
        expect(log.lines()).toEqual([
          'body:kept',
          'afterAll:kept',
          'teardown:keeper',
          'teardown:gadget:INTERRUPTED:"gadget" is not available to the fixture "keeper" teardown: the run was interrupted, so no attempt opens for it',
        ]);
        // The failed test leaves its suite instance, so afterAll runs in a
        // short attempt before the limit stops the run; the teardown, after
        // the stop, opens none.
        expect(fake.events).toEqual(['init', 'startAttempt:0', 'endAttempt:0', 'startAttempt:1', 'endAttempt:1', 'dispose']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
