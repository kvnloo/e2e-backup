/**
 * Services through the built runner: they start in key order before the app
 * commands and stop in reverse after them, a failed start stops the ones
 * already started, the start and stop limits abort their signal, the yielded
 * value is checked, tests in worker processes and in the runner process call
 * service functions and get copies back, an `env` function reads the
 * services, and `e2e list`, the config digest, `e2e mcp`, and `openHost`
 * start none.
 */

import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineService } from '../../src/index.ts';
import type { E2EConfig, Service } from '../../src/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createProject, listProject, runExisting, runExistingWithConfigFile, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { startupLog, writeStartupScripts } from '../helpers/startup-scripts.ts';

const resolveModule = new URL('../../dist/config/resolve-run.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve-run.ts');
const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');

/** An app that logs its start, with `PORT` and `ALPHA_URL`, and its stop, then serves on `PORT`. */
const SERVER = `const { appendFileSync } = require('node:fs');
appendFileSync('events.log', 'app start ' + process.env.PORT + ' ' + process.env.ALPHA_URL + '\\n');
process.on('SIGTERM', () => {
  appendFileSync('events.log', 'app stop\\n');
  process.exit(0);
});
require('node:http').createServer((_request, response) => response.end('ready')).listen(Number(process.env.PORT), '127.0.0.1');
`;

/** A service module for file-backed configs: each service logs its start, its calls, and its stop to `events.log`. */
const SERVICES = `import { appendFileSync } from 'node:fs';
import { defineService } from 'e2e';

const log = (line: string) => appendFileSync(new URL('./events.log', import.meta.url), line + '\\n');

export const logged = (name: string) =>
  defineService({
    async *start() {
      log('start ' + name);
      yield {
        url: 'http://' + name + '.test',
        record: (what: string) => {
          log(name + ' record ' + what);
          return what.length;
        },
        fail: () => {
          throw new TypeError(name + ' is down');
        },
      };
      log('stop ' + name);
    },
  });
`;

const CONFIG = `import { appendFileSync } from 'node:fs';
import { defineConfig } from 'e2e';
import { createFakeEngine } from '../../helpers/fake-engine.ts';
import { logged } from './services.ts';

export default defineConfig({
  workers: 2,
  services: { alpha: logged('alpha'), beta: logged('beta') },
  targets: [
    {
      name: 'fake',
      platform: 'fake',
      engine: createFakeEngine().engine,
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: ${JSON.stringify(process.execPath)},
          args: ['server.cjs'],
          shutdownTimeout: 2000,
          env: ({ services }) => {
            appendFileSync(new URL('./events.log', import.meta.url), 'env\\n');
            return { PORT: '{port}', ALPHA_URL: services.alpha.url };
          },
        },
      },
    },
  ],
});
`;

/** A test file whose test records its worker's pid through `services.alpha`. */
const recordingTest = (title: string): string => `import { test } from 'e2e';
test('${title}', async ({ services }) => {
  const alpha = services['alpha'] as { record(what: string): Promise<number> };
  const length = await alpha.record(String(process.pid));
  if (length !== String(process.pid).length) throw new Error('record returned ' + length);
});
`;

/** The run's errors as code and message. */
const runErrors = (outcome: RunOutcome) => outcome.report.run.errors.map(({ code, message }) => ({ code, message }));

/** The last attempt's error message of the test titled `title`. */
const failureOf = (outcome: RunOutcome, title: string): string | undefined =>
  outcome.results.find((result) => result.test.title === title)?.attempts.at(-1)?.error?.message;

/** A fake target whose app command runs `server.cjs` on a free port, with `env` as its env. */
function commandTarget(env: NonNullable<NonNullable<NonNullable<E2EConfig['targets'][number]['app']>['command']>['env']>) {
  return {
    name: 'fake',
    platform: 'fake',
    engine: createFakeEngine().engine,
    app: { url: 'http://127.0.0.1:0', command: { executable: process.execPath, args: ['server.cjs'], shutdownTimeout: 2000, env } },
  };
}

const PASSING_TEST = `import { test } from 'e2e';
test('passes', async () => {});
`;

describe('services', { timeout: 60_000 }, () => {
  const projects: FixtureProject[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) project.cleanup();
  });

  /** Runs `files` in-process with `config` on top of the fake target. */
  async function runInProcess(files: Readonly<Record<string, string>>, config: Partial<E2EConfig>, runOptions = {}): Promise<RunOutcome> {
    const { outcome, project } = await runProject(files, { config, runOptions });
    projects.push(project);
    return outcome;
  }

  it('starts services in key order before the app commands, stops them in reverse after, and serves calls from worker processes', async () => {
    const project = createProject({
      'services.ts': SERVICES,
      'server.cjs': SERVER,
      'e2e.config.ts': CONFIG,
      'tests/one.e2e.ts': recordingTest('one'),
      'tests/two.e2e.ts': recordingTest('two'),
      'tests/fail.e2e.ts': `import { test } from 'e2e';
test('calls a function that throws', async ({ services }) => {
  await (services['beta'] as { fail(): Promise<void> }).fail();
});
`,
    });
    projects.push(project);

    const outcome = await runExistingWithConfigFile(project, {});

    const events = readFileSync(path.join(project.dir, 'events.log'), 'utf8').trim().split('\n');
    const port = outcome.config?.ports['fake'];
    expect(port).toBeGreaterThan(0);
    expect(events.filter((line) => !line.includes(' record '))).toEqual([
      'start alpha',
      'start beta',
      'env',
      `app start ${port} http://alpha.test`,
      'app stop',
      'stop beta',
      'stop alpha',
    ]);
    const recordedPids = events.filter((line) => line.startsWith('alpha record ')).map((line) => Number(line.slice('alpha record '.length)));
    expect(recordedPids).toHaveLength(2);
    expect(recordedPids).not.toContain(process.pid);
    expect(outcome.results.filter((result) => result.status === 'passed').map((result) => result.test.title).toSorted()).toEqual(['one', 'two']);
    expect(failureOf(outcome, 'calls a function that throws')).toBe('services.beta.fail() failed: beta is down');
    expect(runErrors(outcome)).toEqual([]);
  });

  it('copies data to tests in the runner process and calls functions there', async () => {
    const items = ['first'];
    const outcome = await runInProcess(
      {
        'tests/calls.e2e.ts': `import { expect, test } from 'e2e';
type Store = {
  items: string[];
  when: Date;
  bytes: Uint8Array;
  nested: { readers: { read(): Promise<string> }[] };
  size(): Promise<number>;
  add(item: string): Promise<number>;
  fail(): Promise<void>;
  leak(): Promise<unknown>;
};
test('reads data and calls functions', async ({ services }) => {
  const store = services['store'] as Store;
  store.items.push('local');
  expect(await store.size()).toBe(1);
  expect(await store.add('second')).toBe(2);
  expect(store.when instanceof Date).toBe(true);
  expect(store.bytes instanceof Uint8Array).toBe(true);
  expect(await store.nested.readers[0]!.read()).toBe('read');
});
test('gets a copy of a thrown error', async ({ services }) => {
  await (services['store'] as Store).fail();
});
test('passes an argument that cannot be copied', async ({ services }) => {
  await (services['store'] as Store).add((() => 'x') as never);
});
test('gets a result that cannot be copied', async ({ services }) => {
  await (services['store'] as Store).leak();
});
`,
      },
      {
        services: {
          store: defineService({
            async *start() {
              yield {
                items,
                when: new Date(0),
                bytes: Buffer.from('abc'),
                nested: { readers: [{ read: () => 'read' }] },
                size: () => items.length,
                add: (item: string) => items.push(item),
                fail: () => {
                  throw new RangeError('the store is full');
                },
                leak: () => () => 'a function',
              };
            },
          }),
        },
      },
    );

    expect(failureOf(outcome, 'reads data and calls functions')).toBeUndefined();
    expect(items).toEqual(['first', 'second']);
    expect(failureOf(outcome, 'gets a copy of a thrown error')).toBe('services.store.fail() failed: the store is full');
    expect(failureOf(outcome, 'passes an argument that cannot be copied')).toContain('services.store.add() takes arguments that can be copied to the runner process');
    expect(failureOf(outcome, 'gets a result that cannot be copied')).toContain("services.store.leak() failed: it returned a value that can't be copied to the test");
  });

  it('calls an env function once, after the services start, with {port} expanded', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });
    projects.push(project);
    const seen: unknown[] = [];
    const outcome = await runExisting(project, {
      config: {
        services: {
          alpha: defineService({
            async *start() {
              yield { url: 'http://alpha.test' };
            },
          }),
        },
        targets: [
          commandTarget(({ services }) => {
            seen.push(services);
            return { PORT: '{port}', ALPHA_URL: String((services['alpha'] as { url: string }).url) };
          }),
        ],
      },
    });

    expect(seen).toEqual([{ alpha: { url: 'http://alpha.test' } }]);
    expect(readFileSync(path.join(project.dir, 'events.log'), 'utf8')).toBe(`app start ${outcome.config?.ports['fake']} http://alpha.test\napp stop\n`);
    expect(runErrors(outcome)).toEqual([]);
  });

  it.each([
    { returned: () => ({ PORT: 4000 }), message: 'target "fake" app.command.env.PORT must be a string, got' },
    { returned: () => 'PORT=4000', message: 'target "fake" app.command.env must return an object of variable name to string, got' },
    {
      returned: () => {
        throw new Error('no port today');
      },
      message: 'target "fake" app.command.env threw: no port today',
    },
  ])('fails the run before spawning when an env function returns $message', async ({ returned, message }) => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });
    projects.push(project);
    const outcome = await runExisting(project, { config: { targets: [commandTarget(returned as never)] } });

    expect(runErrors(outcome)).toEqual([{ code: 'INVALID_CONFIG', message: expect.stringContaining(message) }]);
    expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
  });

  it('starts one process for two targets that declare the same command and env function', async () => {
    const port = await freePort();
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });
    projects.push(project);
    let calls = 0;
    const command = {
      executable: process.execPath,
      args: ['server.cjs'],
      shutdownTimeout: 2000,
      env: () => {
        calls += 1;
        return { PORT: String(port), ALPHA_URL: 'shared' };
      },
    };
    const outcome = await runExisting(project, {
      config: {
        targets: [
          { name: 'a', platform: 'fake', engine: createFakeEngine().engine, app: { url: `http://127.0.0.1:${port}`, command } },
          { name: 'b', platform: 'fake', engine: createFakeEngine().engine, app: { url: `http://127.0.0.1:${port}`, command } },
        ],
      },
    });

    expect(calls).toBe(1);
    expect(readFileSync(path.join(project.dir, 'events.log'), 'utf8')).toBe(`app start ${port} shared\napp stop\n`);
    expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
  });

  it('does not call an env function when reuseExisting uses a process that is already running', async () => {
    const port = await freePort();
    const server = createServer((_request, response) => response.end('ready')).listen(port, '127.0.0.1');
    await once(server, 'listening');
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });
    projects.push(project);
    let calls = 0;
    try {
      const outcome = await runExisting(project, {
        config: {
          targets: [
            {
              name: 'fake',
              platform: 'fake',
              engine: createFakeEngine().engine,
              app: {
                url: `http://127.0.0.1:${port}`,
                command: {
                  executable: process.execPath,
                  args: ['server.cjs'],
                  reuseExisting: true,
                  env: () => {
                    calls += 1;
                    return { PORT: String(port) };
                  },
                },
              },
            },
          ],
        },
      });

      expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
      expect(calls).toBe(0);
      expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
    } finally {
      server.close();
    }
  });

  it('stops the services that started when a later one fails to start, and starts no app command', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });
    projects.push(project);
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: {
        services: {
          first: defineService({
            async *start() {
              events.push('start first');
              yield {};
              events.push('stop first');
            },
          }),
          broken: defineService({
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start() {
              events.push('start broken');
              throw new Error('port 4010 is taken');
            },
          }),
          never: defineService({
            async *start() {
              events.push('start never');
              yield {};
            },
          }),
        },
        targets: [commandTarget({ PORT: '{port}' })],
      },
    });

    expect(events).toEqual(['start first', 'start broken', 'stop first']);
    expect(runErrors(outcome)).toEqual([{ code: 'SERVICE_START_FAILED', message: 'service "broken" failed to start: port 4010 is taken' }]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.results.some((result) => result.status === 'passed')).toBe(false);
    expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
  });

  it('fails the run when a service finishes without yielding', async () => {
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        quiet: defineService({
          async *start() {},
        }),
      },
    });

    expect(runErrors(outcome)).toEqual([
      {
        code: 'SERVICE_START_FAILED',
        message: 'service "quiet" finished without yielding; yield its value once, between the code that starts it and the code that stops it',
      },
    ]);
  });

  it('aborts the signal and fails the run when a service does not yield within the start limit', async () => {
    let reason: unknown;
    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          slow: defineService({
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start({ signal }) {
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
              reason = signal.reason;
            },
          }),
        },
      },
      { serviceStartTimeout: 100 },
    );

    expect(runErrors(outcome)).toEqual([{ code: 'SERVICE_START_FAILED', message: 'service "slow" didn\'t yield within 0.1 seconds' }]);
    await expect.poll(() => reason).toBeInstanceOf(Error);
  });

  it('aborts the signal of a service still starting when the run is interrupted', async () => {
    const interrupt = new AbortController();
    let aborted = false;
    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          slow: defineService({
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start({ signal }) {
              const done = new Promise((resolve) => signal.addEventListener('abort', resolve));
              interrupt.abort();
              await done;
              aborted = true;
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal },
    );

    expect(outcome.status).toBe('interrupted');
    expect(runErrors(outcome)).toEqual([]);
    await expect.poll(() => aborted).toBe(true);
  });

  it('aborts the signal and reports a cleanup error when the stop code does not finish within the stop limit', async () => {
    let aborted = false;
    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          stuck: defineService({
            async *start({ signal }) {
              yield {};
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
              aborted = true;
            },
          }),
        },
      },
      { serviceStopTimeout: 100 },
    );

    expect(outcome.report.run.errors).toEqual([
      expect.objectContaining({ code: 'SERVICE_STOP_FAILED', message: 'service "stuck" didn\'t stop within 0.1 seconds', phase: 'cleanup' }),
    ]);
    expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
    await expect.poll(() => aborted).toBe(true);
  });

  it('reports a cleanup error when the stop code throws', async () => {
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        flaky: defineService({
          async *start() {
            yield {};
            throw new Error('could not flush the inbox');
          },
        }),
      },
    });

    expect(runErrors(outcome)).toEqual([{ code: 'SERVICE_STOP_FAILED', message: 'service "flaky" failed to stop: could not flush the inbox' }]);
  });

  it('ends a service that yields a second time and runs its finally block', async () => {
    let finished = false;
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        twice: defineService({
          async *start() {
            try {
              yield {};
              yield {};
            } finally {
              finished = true;
            }
          },
        }),
      },
    });

    expect(runErrors(outcome)).toEqual([
      { code: 'SERVICE_STOP_FAILED', message: 'service "twice" yielded a second time; a service yields once, and the code after its yield stops it' },
    ]);
    expect(finished).toBe(true);
  });

  class Inbox {
    readonly url = 'http://inbox.test';
  }
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;

  it.each([
    { value: 'http://inbox.test', message: 'service "bad" yielded string; yield a plain object, such as { url }' },
    { value: { inbox: new Inbox() }, message: 'service "bad" yielded an instance of Inbox at inbox, which loses its class when it\'s copied to the workers; wrap the data tests need in a plain object' },
    { value: { tag: Symbol('tag') }, message: "service \"bad\" yielded a value at tag that can't be copied to the workers: Symbol(tag) could not be cloned." },
    { value: { list: [cycle] }, message: "service \"bad\" yielded a value at list[0].self that refers to itself, which can't be copied to the workers" },
    { value: { counter: new SharedArrayBuffer(8) }, message: "service \"bad\" yielded a value at counter that can't be copied to the workers: " },
  ])('fails the run when a service yields $message', async ({ value, message }) => {
    let stopped = false;
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        bad: {
          async *start() {
            yield value as object;
            stopped = true;
          },
        } satisfies Service,
      },
    });

    expect(runErrors(outcome)).toEqual([{ code: 'INVALID_SERVICE_VALUE', message: expect.stringContaining(message) }]);
    expect(outcome.exitCode).toBe(2);
    expect(stopped).toBe(true);
  });

  it('lists tests without starting a service or calling an env function', async () => {
    let started = false;
    let called = false;
    const { pairs, project } = await listProject({ 'tests/a.e2e.ts': PASSING_TEST }, {
      config: {
        services: {
          loud: defineService({
            async *start() {
              started = true;
              yield {};
            },
          }),
        },
        targets: [
          commandTarget(() => {
            called = true;
            return {};
          }),
        ],
      },
    });
    projects.push(project);

    expect(pairs.map((pair) => pair.title)).toEqual(['passes']);
    expect(started).toBe(false);
    expect(called).toBe(false);
  });

  it('keeps the config digest, and with it the replay cache, when services or an env function are added', () => {
    const service = defineService({
      async *start() {
        yield {};
      },
    });
    const engine = createFakeEngine().engine;
    const app = { url: 'http://127.0.0.1:4000', command: { executable: 'node', args: ['server.cjs'] } };
    const digest = (config: E2EConfig): string => resolveConfig(config, { projectRoot: '/repo', env: {} }).configDigest;
    const plain = digest({ targets: [{ name: 'fake', platform: 'fake', engine, app }] });

    expect(digest({ services: { service }, targets: [{ name: 'fake', platform: 'fake', engine, app }] })).toBe(plain);
    expect(digest({ targets: [{ name: 'fake', platform: 'fake', engine, app: { ...app, command: { ...app.command, env: () => ({}) } } }] })).toBe(plain);
  });

  describe('openHost', () => {
    const harness = hostHarness();

    it('opens a host on a config with services, and names the service an env function or a session reads there', async () => {
      const port = await freePort();
      writeStartupScripts(harness.dir());
      const throwing = defineService({
        // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
        async *start() {
          throw new Error('openHost started a service');
        },
      });
      const config = (read: boolean): E2EConfig => ({
        services: { email: throwing },
        targets: [
          {
            name: 'kiosk',
            platform: 'kiosk',
            engine: createFakeEngine().engine,
            app: {
              url: `http://127.0.0.1:${port}`,
              command: {
                executable: process.execPath,
                args: ['server.cjs', String(port)],
                env: ({ services }) => (read ? { EMAIL_URL: String(services['email']) } : {}),
              },
            },
          },
        ],
      });

      await expect(harness.host(createFakeEngine().engine, { config: config(true) })).rejects.toThrow(
        "target \"kiosk\" app.command.env threw: openHost doesn't start services, so services.email isn't available here",
      );
      const host = await harness.host(createFakeEngine().engine, { config: config(false) });
      expect(host.target).toBe('kiosk');
      expect(startupLog(harness.dir())).toBe('app\n');
      const session = await host.openSession({ name: 'reads a service' });
      expect(() => Reflect.get(session.fixtures.services, 'email')).toThrow("openHost doesn't start services, so services.email isn't available here");
      await session.close();
    });
  });

  describe('e2e mcp', () => {
    it('opens sessions on a config with services, sharing one app process, and names the service an env function or a test reads there', async () => {
      const port = await freePort();
      const project = createProject({
        'tests/reads.e2e.ts': `import { test } from 'e2e';
test('reads a service', async ({ services }) => {
  void (services['email'] as { url: string }).url;
});
`,
      });
      projects.push(project);
      writeStartupScripts(project.dir);
      const sessions = (read: boolean) =>
        new SessionHost({
          locateConfig: () => path.join(project.dir, 'e2e.config.ts'),
          loadConfig: async (configPath) => ({
            ...resolveConfig(
              {
                services: {
                  email: defineService({
                    // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
                    async *start() {
                      throw new Error('e2e mcp started a service');
                    },
                  }),
                },
                targets: [
                  {
                    name: 'kiosk',
                    platform: 'kiosk',
                    engine: createFakeEngine().engine,
                    app: {
                      url: `http://127.0.0.1:${port}`,
                      command: {
                        executable: process.execPath,
                        args: ['server.cjs', String(port)],
                        env: ({ services }) => (read ? { EMAIL_URL: String(services['email']) } : {}),
                      },
                    },
                  },
                ],
              },
              { projectRoot: project.dir, env: {}, configPath },
            ),
            configPath,
          }),
          loadEngineConfig: async () => {
            throw new Error('no engine sessions here');
          },
          env: {},
          headed: false,
          log: () => undefined,
          maxSessions: 2,
        });

      await expect(sessions(true).open({})).rejects.toThrow(
        "target \"kiosk\" app.command.env threw: e2e mcp doesn't start services, so services.email isn't available here",
      );
      const host = sessions(false);
      const opened = await Promise.all([host.open({}), host.open({})]);
      expect(opened).toEqual([expect.stringMatching(/^Session \S+ open/), expect.stringMatching(/^Session \S+ open/)]);
      expect(startupLog(project.dir)).toBe('app\n');
      await host.closeAll('done');
      const testing = sessions(false);
      expect(await testing.open({ test: 'tests/reads.e2e.ts' })).toContain("e2e mcp doesn't start services, so services.email isn't available here");
      await testing.close('done');
    });
  });
});

