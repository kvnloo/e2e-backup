import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineAppInfo, OperationContext, SemanticNode } from '@e2e-dev/core/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOptions } from '../../src/options.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { alive, failure, fakeDriver, killSpawned, snapshotAnswer, spawnApp, standIn, type Answer, type FakeDriver, type Scenario } from '../helpers/fake-driver.ts';

const signal = new AbortController().signal;
const surfaces: DesktopSurface[] = [];

/** The artifact directories attempts were given, removed after each test. */
const artifactDirs: string[] = [];

afterEach(async () => {
  // Disposing removes each surface's private state directory.
  for (const surface of surfaces.splice(0)) await surface.dispose({ signal, timeoutMs: 2_000 }).catch(() => undefined);
  killSpawned();
  for (const directory of artifactDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function artifacts(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  artifactDirs.push(directory);
  return directory;
}

/** Whether a process is gone within `ms`. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function operation(origin: 'test' | 'agent' = 'test'): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin };
}

const ok = (data: unknown): Answer => ({ ok: true, data });

/** A window list answer of the newest launched process. */
function windows(list: (pid: number) => readonly Record<string, unknown>[], sleepMs?: number) {
  return (fake: FakeDriver): Answer => ({ ok: true, data: list(fake.pid).map((window) => ({ pid: fake.pid, ...window })), ...(sleepMs === undefined ? {} : { sleepMs }) });
}

/** A snapshot fixture's answer with its refs and window renamed, as a later snapshot of the same window reports it. */
function renamed(name: string, from: string, to: string): Answer {
  return JSON.parse(JSON.stringify(snapshotAnswer(name)).replaceAll(from, to)) as Answer;
}

/** A snapshot answer of one window with the nodes given. */
function screen(windowId: string, tree: Record<string, unknown>, extra: Record<string, unknown> = {}): Answer {
  return ok({ snapshot_id: 's', window: { id: windowId }, tree: { role: 'window', ...tree }, ...extra });
}

const testId = (value: string) => ({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value, exact: true } } }) as const;

interface Launch {
  /** The run's own `--headed`, as `init` receives it. */
  readonly runHeaded?: boolean;
  readonly openTimeoutMs?: number;
  readonly observe?: boolean;
  readonly options?: Parameters<typeof resolveOptions>[0];
  readonly launchArgumentValues?: EngineAppInfo['launchArgumentValues'];
  readonly app?: EngineAppInfo;
  readonly projectRoot?: string;
}

/** A surface on the scripted driver, initialized but with nothing launched. */
async function initialized(scenario: Scenario | FakeDriver = {}, { options = {}, runHeaded = false, launchArgumentValues, app, projectRoot = process.cwd() }: Launch = {}) {
  const fake = 'calls' in scenario ? scenario : fakeDriver(scenario);
  const surface = new DesktopSurface(resolveOptions({ settle: false, ...options }), 'macos', () => fake);
  surfaces.push(surface);
  await surface.init({
    runId: 'run',
    targetName: 'macos',
    projectRoot,
    app: app ?? { bundleId: 'dev.e2e.spike.form', ...(launchArgumentValues === undefined ? {} : { launchArgumentValues }) },
    // A secret in the run's environment, which the app the engine launches may not see.
    env: { HOME: '/Users/ada', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', E2E_PROBE_SECRET: 'hunter2' },
    headed: runHeaded,
    workerSlot: 0,
    signal,
    log: () => undefined,
  });
  return { surface, fake };
}

/** A surface on the scripted driver, with the form launched (a real child process as the app) and observed once. */
async function launched(scenario: Scenario | FakeDriver = {}, launch: Launch = {}) {
  const { openTimeoutMs = 10_000, observe = true } = launch;
  const { surface, fake } = await initialized(scenario, launch);
  await surface.restart({ ...operation(), timeoutMs: openTimeoutMs });
  const nodes = observe ? await surface.observe(operation(), undefined).then((observed) => [observed.root, ...(observed.root.children ?? [])]) : [];
  const byTestId = (value: string) => {
    const node = nodes.find((candidate) => candidate.testId === value);
    if (node === undefined) throw new Error(`no node ${value}`);
    return node.ref;
  };
  return { surface, fake, byTestId };
}

/** The arguments of the newest call of a method. */
function last<T = Record<string, unknown>>(fake: FakeDriver, method: string): T | undefined {
  return fake.of(method).at(-1)?.args[0] as T | undefined;
}

/** The input calls the surface made: actions, keys, and pointer input. */
function inputs(fake: FakeDriver): string[] {
  return fake.calls.flatMap((call) => {
    if (call.method === 'act') return [(call.args[0] as { action: string }).action];
    if (call.method === 'press') return [`press ${(call.args[0] as { combo: string }).combo}`];
    if (call.method === 'pointer' || call.method === 'focusWindow') return [call.method];
    return [];
  });
}

const startAttempt = (surface: DesktopSurface) =>
  surface.startAttempt({
    attemptId: 'a',
    artifactsDir: artifacts(),
    resolveSecret: async () => '',
    signal,
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });

/** A state directory a worker left behind, owned by the process `owner` names. */
function leftDirectory(owner: string, record?: unknown, prefix = 'e2e-desktop-worker-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(directory, 'owner'), owner);
  if (record !== undefined) writeFileSync(path.join(directory, 'app.json'), typeof record === 'string' ? record : JSON.stringify(record));
  return directory;
}

/** A process id no process holds: one that just exited. */
async function deadPid(): Promise<number> {
  const pid = standIn({ exits: true });
  await gone(pid);
  return pid;
}

describe('DesktopSurface: launching', () => {
  it("passes the target's launch arguments after its own, an object spelled as user defaults", async () => {
    const { fake } = await launched({}, { launchArgumentValues: { AppleLanguages: ['fr'], e2e: true } });
    expect(last<{ arguments: string[] }>(fake, 'launch')?.arguments).toEqual(['-ApplePersistenceIgnoreState', 'YES', '-AppleLanguages', '(fr)', '-e2e', 'YES']);
  });

  it('launches the app by id in the background, and reads only the windows of the process it launched', async () => {
    const { fake } = await launched({});
    const launch = last<{ bundleId?: string; path?: string; activate: boolean }>(fake, 'launch');
    expect(launch).toMatchObject({ bundleId: 'dev.e2e.spike.form', activate: false });
    expect(launch).not.toHaveProperty('path');
    expect(fake.of('listWindows').every((call) => call.args[0] === fake.pid)).toBe(true);
    expect(last(fake, 'snapshot')).toMatchObject({ pid: fake.pid, windowId: 'w-mine', maxDepth: 24, interactive: false });
  });

  it("gives the app only a few variables of the run's environment, and its launch token apart from them", async () => {
    const { fake } = await launched({});
    const launch = last<{ environment: Record<string, string>; token: string }>(fake, 'launch')!;
    expect(launch.environment).toEqual({ HOME: '/Users/ada', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C' });
    expect(launch.token).toMatch(/^[\da-f-]{36}$/);
    expect(JSON.stringify(launch)).not.toContain('hunter2');
  });

  it("launches the app in the foreground when the run asks for --headed, or desktop({ headed }) does, and only then", async () => {
    const { fake } = await launched({}, { runHeaded: true, observe: false });
    expect(last(fake, 'launch')).toMatchObject({ activate: true });
    const { fake: headed } = await launched({}, { options: { headed: true }, observe: false });
    expect(last(headed, 'launch')).toMatchObject({ activate: true });
    const { fake: background } = await launched({}, { observe: false });
    expect(last(background, 'launch')).toMatchObject({ activate: false });
  });

  // plutil reads the bundle id: macOS only.
  it.skipIf(process.platform !== 'darwin')('launches an appPath build by its path, and refuses a bundleId that is not its own', async () => {
    const directory = artifacts();
    const bundle = path.join(directory, 'Built.app');
    mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
    const { surface, fake } = await initialized({}, { projectRoot: directory, app: { appPath: 'Built.app', bundleId: 'dev.e2e.built' } });
    await surface.restart(operation());
    expect(last<{ path: string }>(fake, 'launch')?.path).toBe(realpathSync(bundle));
    await expect(initialized({}, { projectRoot: directory, app: { appPath: 'Built.app', bundleId: 'com.example.other' } })).rejects.toThrow(/is not the CFBundleIdentifier "dev.e2e.built"/);
  });

  it('refuses to launch without the Accessibility permission', async () => {
    const fake = fakeDriver();
    fake.accessibility = false;
    await expect(initialized(fake)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/Accessibility/) });
  });

  it('says which app is missing when the bundle id names none, and takes nothing as its own', async () => {
    const theirs = standIn();
    const { surface } = await initialized({ launch: [failure('APP_NOT_FOUND', 'not_delivered', 'no installed app has the name or bundle id "dev.e2e.spike.form"')] });
    await expect(surface.restart(operation())).rejects.toThrow(/no installed app has the name or bundle id "dev.e2e.spike.form"; check the target/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('launches nothing for an open cancelled before the launch was sent', async () => {
    const { surface, fake } = await initialized({});
    const controller = new AbortController();
    controller.abort();
    await expect(surface.restart({ ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.of('launch')).toEqual([]);
  });

  it('reports an open LaunchServices refused as a failure that started nothing', async () => {
    const { surface } = await initialized({ launch: [failure('ACTION_FAILED', 'not_delivered', 'open could not start Built.app: its executable is missing', { kind: 'not_started' })] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/its executable is missing$/) });
    const started = Date.now();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a launch whose process could not be told apart as one that may have committed, and quits the copy carrying its token', async () => {
    const { surface, fake } = await initialized({ launch: [spawnApp({ answer: failure('TIMEOUT', 'delivered_unverified', 'no new process carries the token', { kind: 'unclaimed' }) })] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringMatching(/looks for it again/) });
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.pid)).toBe(true);
  });

  it('keeps a launch that ran out of time pending, and the next quit kills the process the driver then reports', async () => {
    // The process carries no token: only the driver's late answer names it.
    const { surface, fake } = await initialized({ launch: [spawnApp({ token: false, sleepMs: 1_500 })] });
    await expect(surface.restart({ ...operation(), timeoutMs: 600 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const pid = fake.pid;
    expect(alive(pid)).toBe(true);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(pid)).toBe(true);
  });

  it('quits the process carrying the token of a launch that failed after it may have started the app', async () => {
    const theirs = standIn();
    const { surface, fake } = await initialized({ launch: [spawnApp({ answer: failure('TIMEOUT', 'delivered_unverified') })] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.pid)).toBe(true);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('quits an app a launch that answered without one starts a moment later, by its token', async () => {
    const { surface, fake } = await initialized({ launch: [failure('TIMEOUT', 'delivered_unverified', 'no new process carries the token', { kind: 'unclaimed' })] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const { token } = last<{ token: string }>(fake, 'launch')!;
    const late = standIn();
    setTimeout(() => fake.carriers.set(late, token), 350);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(late)).toBe(true);
  });

  it('never kills a process that has the app\'s id when its start cannot be read and it carries no token', async () => {
    const fake = fakeDriver({ launch: [spawnApp({ token: false })] });
    const { surface } = await launched(fake, { observe: false });
    const pid = fake.pid;
    fake.startsUnreadable = true;
    try {
      await surface.endAttempt({ signal, timeoutMs: 2_000 });
      expect(await gone(pid, 300)).toBe(false);
    } finally {
      fake.startsUnreadable = false;
    }
  });

  it('never kills the process a late launch answer named once its id went to another process', async () => {
    // The launch answers late with a process and its start; by the quit, that id is a process that started at another time.
    const fake = fakeDriver({ launch: [(driver) => ({ ok: true, data: { app: 'SpikeForm', pid: driver.spawn({}), started: 7 }, sleepMs: 1_500 })] });
    const { surface } = await initialized(fake);
    await expect(surface.restart({ ...operation(), timeoutMs: 600 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const pid = fake.pid;
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(pid, 300)).toBe(false);
  });

  it('never takes a running copy without its launch token, and says the launch left nothing it could find', async () => {
    const theirs = standIn();
    const { surface } = await initialized({ launch: [failure('TIMEOUT', 'delivered_unverified')] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('keeps a launch whose process it could not look for, so the next quit looks again', async () => {
    const fake = fakeDriver({ launch: [spawnApp({ answer: failure('TIMEOUT', 'delivered_unverified') })] });
    const { surface } = await initialized(fake);
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    fake.lookupFails = true;
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/could not tell whether a launch/);
    fake.lookupFails = false;
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.pid)).toBe(true);
  });

  it('keeps the launch record of a launch whose process was never found, so the next run can quit it', async () => {
    const fake = fakeDriver({ launch: [failure('TIMEOUT', 'delivered_unverified')] });
    const { surface } = await initialized(fake);
    const home = (surface as unknown as { home: string }).home;
    try {
      await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      fake.lookupFails = true;
      await expect(surface.dispose({ signal, timeoutMs: 1_000 })).rejects.toThrow(/could not tell/);
      expect(readdirSync(home).toSorted()).toEqual(['app.json', 'owner']);
      expect(readFileSync(path.join(home, 'owner'), 'utf8')).toBe('abandoned');
      expect(JSON.parse(readFileSync(path.join(home, 'app.json'), 'utf8'))).toMatchObject({ token: expect.any(String) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves nothing to look for after an open whose budget ran out before it launched', async () => {
    const { surface, fake } = await initialized({});
    await expect(surface.restart({ ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(fake.of('launch')).toHaveLength(0);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  it('opens again after a failed launch that left no process, rather than fail on the launch it cannot find', async () => {
    const { surface, fake } = await initialized({ launch: [failure('TIMEOUT', 'delivered_unverified'), spawnApp()] });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await surface.restart(operation());
    expect(fake.spawned).toHaveLength(1);
  });

  it("starts a reused handle's next host clean, though the last one left a launch it could not settle", async () => {
    const fake = fakeDriver({ launch: [failure('TIMEOUT', 'delivered_unverified')] });
    const { surface } = await initialized(fake);
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    fake.lookupFails = true;
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/could not tell/);
    await expect(surface.dispose({ signal, timeoutMs: 1_000 })).rejects.toThrow(/could not tell/);
    // The next host's app is healthy: it launches and lists as it should.
    fake.lookupFails = false;
    fake.rescript({});
    await surface.init({ runId: 'run-2', targetName: 'macos', projectRoot: process.cwd(), app: { bundleId: 'dev.e2e.spike.second' }, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.restart(operation());
    expect(last(fake, 'launch')).toMatchObject({ bundleId: 'dev.e2e.spike.second' });
  });

  it('runs two overlapping opens one after the other, and leaves no copy running', async () => {
    const { surface, fake } = await initialized({});
    await Promise.all([surface.restart(operation()), surface.restart(operation())]);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(fake.spawned).toHaveLength(2);
    for (const pid of fake.spawned) expect(await gone(pid)).toBe(true);
  });

  it('fails the open of an app that quit right after it launched', async () => {
    const started = Date.now();
    await expect(launched({ launch: [spawnApp({ exits: true })], listWindows: [ok([])] }, { observe: false })).rejects.toThrow(/quit right after it launched/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('DesktopSurface: the launch wait', () => {
  it('fails the open when the window never becomes readable', async () => {
    await expect(launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true, accessible: false }])] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/cannot be read through accessibility/);
  }, 30_000);

  it('reports a launch whose window reads ran out of time as unreadable, not as an app that opened no window', async () => {
    await expect(launched({ listWindows: [failure('TIMEOUT', 'not_delivered')] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/cannot be read through accessibility \(a read ran out of time\)/);
  });

  it('says a background app that opens no window needs headed, however the wait ends against a slow window list', async () => {
    await expect(launched({ listWindows: [{ ok: true, data: [], sleepMs: 700 }] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/opened no window.*desktop\(\{ headed: true \}\)/);
  }, 30_000);

  it('says a foreground launch listed no window, rather than that its window cannot be read', async () => {
    await expect(launched({ listWindows: [ok([])] }, { runHeaded: true, openTimeoutMs: 15_000 })).rejects.toThrow(/listed no window within 10 s/);
  }, 30_000);

  it('reads until the end of the launch wait, so a window that shows up late still opens', async () => {
    await launched({ listWindows: [{ ok: true, data: [], sleepMs: 9_100 }, windows(() => [{ id: 'w-mine', is_focused: true }])] }, { openTimeoutMs: 15_000, observe: false });
  }, 30_000);

  it('says the screen is locked when macOS reports it so, rather than that the app opened no window', async () => {
    const fake = fakeDriver({ listWindows: [ok([])] });
    fake.locked = true;
    await expect(launched(fake, { openTimeoutMs: 15_000 })).rejects.toThrow(/screen is locked/);
  }, 30_000);

  it('reads again when the driver says a read of the window may be retried', async () => {
    const busy = failure('APP_UNRESPONSIVE', 'not_delivered', 'the app did not answer in time', { retryable: true });
    const { fake } = await launched({ snapshot: [busy, snapshotAnswer('macos/appkit-form')] }, { observe: false });
    expect(fake.of('snapshot').length).toBeGreaterThanOrEqual(2);
    expect(fake.spawned).toHaveLength(1);
  });

  it('reads again when the window was replaced while the open read it, and launches once', async () => {
    const { fake } = await launched({ snapshot: [failure('STALE_REF', 'not_delivered'), snapshotAnswer('macos/appkit-form')] }, { observe: false });
    expect(fake.of('snapshot').length).toBeGreaterThanOrEqual(2);
    expect(fake.spawned).toHaveLength(1);
  });

  it('reports an open that ran out of its own budget as a timeout, not a locked screen', async () => {
    await expect(launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true, accessible: false }])] }, { openTimeoutMs: 1_500 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('reports a read that fails for another reason as it is', async () => {
    await expect(launched({ snapshot: [failure('PERM_DENIED', 'not_delivered')] }, { openTimeoutMs: 1_500 })).rejects.toThrow(/Grant Accessibility/);
  });

  it('keeps the launch wait within its time when each read of it is slow', async () => {
    const started = Date.now();
    await expect(launched({ listWindows: [{ ok: true, data: [], sleepMs: 2_000 }] }, { openTimeoutMs: 3_000, observe: false })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(4_500);
  });

  it('gives each read of the launch wait what is left of that wait, not of the whole open', async () => {
    const { fake } = await launched({}, { openTimeoutMs: 60_000, observe: false });
    expect(last<{ timeoutMs: number }>(fake, 'snapshot')!.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe('DesktopSurface: reading', () => {
  it('reads and drives nothing before the app is opened, or once it quit', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    await surface.closeApp(signal, 5_000);
    const before = fake.calls.filter((call) => call.method === 'snapshot' || call.method === 'listWindows').length;
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children).toBeUndefined();
    expect(await surface.locate(testId('username'), operation())).toEqual([]);
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls.filter((call) => call.method === 'snapshot' || call.method === 'listWindows')).toHaveLength(before);
    expect(inputs(fake)).toEqual([]);
  });

  it('keeps a control id across observations of a window and acts on its newest ref', async () => {
    const mine = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    const newer = JSON.parse(JSON.stringify(mine).replaceAll('s1y1hxmo5pexrl', 'snewer')) as Answer;
    const { surface, fake, byTestId } = await launched({ snapshot: [mine, mine, newer] });
    const signIn = byTestId('sign-in');
    const again = await surface.observe(operation(), undefined);
    expect(again.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
    await surface.perform(signIn, { kind: 'tap' }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@snewer:e5', action: 'click' });
    await expect(surface.perform({ id: 'n9999', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('gives a control in another window an id of its own', async () => {
    const { surface, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-other')] });
    const signIn = byTestId('sign-in');
    const other = await surface.observe(operation(), undefined);
    expect(other.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).not.toBe(signIn.id);
  });

  it('keeps the ids of one window while another window is read', async () => {
    const mine = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    const { surface, byTestId } = await launched({
      listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-other' }])],
      snapshot: [mine, mine, renamed('macos/appkit-form', 'w-8032', 'w-other'), mine],
    });
    const signIn = byTestId('sign-in');
    await surface.observe(operation(), undefined);
    const back = await surface.observe(operation(), undefined);
    expect(back.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
  });

  it('retires an id once its control has a look-alike, so a surviving twin never inherits it', async () => {
    const button = (ref: string) => ({ role: 'button', name: 'Delete', ref_id: ref });
    const read = (buttons: readonly unknown[]) => screen('w-1', { name: 'List', children: buttons });
    const { surface } = await launched({ snapshot: [read([button('@s1:e1')]), read([button('@s1:e1')]), read([button('@s2:e1'), button('@s2:e2')]), read([button('@s3:e2')])] }, { observe: false });
    const first = await surface.observe(operation(), undefined);
    const original = first.root.children?.[0]?.ref.id;
    await surface.observe(operation(), undefined);
    const final = await surface.observe(operation(), undefined);
    expect(final.root.children?.[0]?.ref.id).not.toBe(original);
  });

  it("cuts an observation's names at 256 and text at 512, and still locates by the whole text", async () => {
    const long = 'L'.repeat(1_200);
    const labelled = JSON.parse(JSON.stringify(snapshotAnswer('macos/appkit-form')).replace('"name":"Username"', `"name":"${long}"`)) as Answer;
    const { surface } = await launched({ snapshot: [labelled] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children?.find((node) => node.testId === 'username')?.name).toBe(long.slice(0, 256));
    const all = (node: SemanticNode): SemanticNode[] => [node, ...(node.children ?? []).flatMap(all)];
    for (const node of all(observed.root)) {
      expect(node.name?.length ?? 0).toBeLessThanOrEqual(256);
      expect(node.text?.length ?? 0).toBeLessThanOrEqual(512);
    }
    const byName = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: long, exact: true } } } as const;
    expect(await surface.locate(byName, operation())).toHaveLength(1);
  });

  it('reads again when the window closed while it was read, so a locator keeps polling', async () => {
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')] });
    await expect(surface.locate(testId('username'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reads the controls of a minimized window as hidden, still found by test id', async () => {
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }]), windows(() => [{ id: 'w-mine', visible: false, minimized: true }])] }, { observe: false });
    const [username] = await surface.locate(testId('username'), operation());
    expect(username?.states?.hidden).toBe(true);
  });

  it('reads an app with no window as an empty screen', async () => {
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }]), ok([])] }, { observe: false });
    expect(await surface.locate(testId('username'), operation())).toEqual([]);
  });

  it('reads again, never an empty screen or a closed window, once the screen locks after the open', async () => {
    const both = windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel' }]);
    const fake = fakeDriver({ listWindows: [both, both, ok([])] });
    const { surface } = await launched(fake, { observe: false });
    await surface.useWindow('w-panel', signal, 5_000);
    fake.locked = true;
    await expect(surface.locate(testId('username'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/screen is locked/) });
    await surface.useWindow(undefined, signal, 5_000);
    await expect(surface.locate(testId('username'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/screen is locked/) });
  });

  it('reads again, never a closed window, when the screen locks between the window list and the read', async () => {
    const fake = fakeDriver({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel' }])], snapshot: [snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')] });
    const { surface } = await launched(fake, { observe: false });
    await surface.useWindow('w-panel', signal, 5_000);
    fake.locked = true;
    await expect(surface.locate(testId('username'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/screen is locked/) });
  });

  it('reads the next window when the focused-first one is a panel accessibility cannot read', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-panel', visible: true }, { id: 'w-doc', visible: true }])], snapshot: [snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered', 'no accessibility element', { kind: 'window_without_accessibility_element' }), snapshotAnswer('macos/appkit-form')] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children?.length).toBeGreaterThan(0);
    expect(fake.of('snapshot').slice(1).map((call) => (call.args[0] as { windowId: string }).windowId)).toEqual(['w-panel', 'w-doc']);
  });

  it('skips a window the list marks unreadable without asking the driver to read it', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-hidden', is_focused: true, accessible: false }, { id: 'w-mine', visible: true }])] }, { observe: false });
    await surface.observe(operation(), undefined);
    expect(fake.of('snapshot').every((call) => (call.args[0] as { windowId: string }).windowId === 'w-mine')).toBe(true);
  });

  it('reads no empty screen from an app whose windows accessibility cannot read, and lets a locator read again', async () => {
    const unreadable = failure('WINDOW_NOT_FOUND', 'not_delivered', 'no accessibility element', { kind: 'window_without_accessibility_element' });
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), unreadable] }, { observe: false });
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/could be read/) });
    await expect(surface.observe(operation(), undefined)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('reads no empty screen from an app that quit', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }]), ok([])] }, { observe: false });
    process.kill(fake.pid, 'SIGKILL');
    expect(await gone(fake.pid)).toBe(true);
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/quit/) });
  });

  it('takes a process whose start time changed as the app quit, as when another process took its id, and kills nothing', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    const pid = fake.pid;
    fake.startTimes.set(pid, 42);
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/quit/) });
    await expect(surface.windows(signal, 5_000)).resolves.toEqual([]);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(pid, 300)).toBe(false);
  });

  it('reads a window as deep as desktop({ maxDepth }) says', async () => {
    const { fake } = await launched({}, { options: { maxDepth: 40 } });
    expect(last(fake, 'snapshot')).toMatchObject({ maxDepth: 40 });
  });

  it('refuses a placeholder query, which macOS names a field by already', async () => {
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/sign-in-form')] }, { observe: false });
    const placeholder = { kind: 'query', query: { kind: 'placeholder', value: { kind: 'string', value: 'Username', exact: true } } } as const;
    await expect(surface.locate(placeholder, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const textbox = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } } } as const;
    await expect(surface.locate({ kind: 'filter', source: textbox, has: placeholder }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const named = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: 'Username', exact: true } } } as const;
    await expect(surface.locate(named, operation())).resolves.toHaveLength(1);
  });

  it('counts no matches in a window read in part, and lets the locator read again', async () => {
    const partial = snapshotAnswer('macos/appkit-form') as { ok: true; data: Record<string, unknown> };
    const cut = { ...partial, data: { ...partial.data, complete: false } };
    const { surface } = await launched({ snapshot: [cut, cut, cut, snapshotAnswer('macos/appkit-form')] }, { observe: false });
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/read only in part/) });
    await expect(surface.locate(testId('username'), operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(surface.locate(testId('username'), operation())).resolves.toHaveLength(1);
  });

  it('reads the whole window for a locator even with interactive snapshots, so a label is found', async () => {
    const window = { name: 'Form', bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const label = { role: 'statictext', value: 'Not signed in', bounds: { x: 10, y: 40, width: 80, height: 20 } };
    const button = { role: 'button', name: 'Sign in', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 50, height: 20 } };
    const read = { ...screen('w-mine', { ...window, children: [button, label] }), interactive: screen('w-mine', { ...window, children: [button] }) };
    const { surface, fake } = await launched({ snapshot: [read] }, { observe: false, options: { snapshot: 'interactive' } });
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children).toHaveLength(1);
    expect(await surface.locate({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Not signed in', exact: true } } }, operation())).toHaveLength(1);
    const reads = fake.of('snapshot').map((call) => (call.args[0] as { interactive: boolean }).interactive);
    expect(reads.slice(-2)).toEqual([true, false]);
  });

  it("reads a window's title from the driver's list, and lists the app's windows", async () => {
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', title: 'Spike Form', is_focused: true }]), windows(() => [{ id: 'w-mine', title: 'Spike Form', is_focused: true }, { id: 'w-prefs', title: 'Preferences' }, { id: 'w-untitled' }])] }, { observe: false });
    expect(await surface.windows(signal, 5_000)).toEqual([
      { id: 'w-mine', title: 'Spike Form', focused: true },
      { id: 'w-prefs', title: 'Preferences', focused: false },
      { id: 'w-untitled', title: '', focused: false },
    ]);
  });

  it('drops the identities of a window once the app no longer lists it', async () => {
    const read = (id: string) => screen(id, { name: id, bounds: { x: 0, y: 0, width: 200, height: 100 }, children: [{ role: 'button', name: 'OK', ref_id: `@${id}:e1`, bounds: { x: 10, y: 10, width: 40, height: 20 } }] });
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-1', is_focused: true }]), windows(() => [{ id: 'w-1', is_focused: true }]), windows(() => [{ id: 'w-2', is_focused: true }])], snapshot: [read('w-1'), read('w-1'), read('w-2')] }, { observe: false });
    const ids = (surface as unknown as { ids: Map<string, string> }).ids;
    await surface.observe(operation(), undefined);
    expect([...ids.keys()].some((identity) => identity.startsWith('w-1|'))).toBe(true);
    await surface.observe(operation(), undefined);
    expect([...ids.keys()].some((identity) => identity.startsWith('w-1|'))).toBe(false);
  });

  it('gives no id to a control under a node a read cut short, which may hide its twin', async () => {
    const window = { name: 'Rows', bounds: { x: 0, y: 0, width: 300, height: 300 } };
    const remove = (ref: string, x: number) => ({ role: 'button', name: 'Delete', ref_id: ref, bounds: { x, y: 10, width: 60, height: 20 } });
    const list = (nodes: readonly unknown[], cut = false) => ({ role: 'list', name: 'Rows', ...(cut ? { subtree_truncated: true } : {}), children: nodes });
    const read = (tree: unknown, complete = true) => screen('w-mine', { ...window, children: [tree] }, { complete });
    const { surface } = await launched({ snapshot: [read(list([remove('@s:e1', 200)])), read(list([remove('@s:e1', 200)])), read(list([remove('@s:e2', 10)], true), false)] }, { observe: false });
    const first = await surface.observe(operation(), undefined);
    const cut = await surface.observe(operation(), undefined);
    expect(cut.root.children?.[0]?.children?.[0]?.ref.id).not.toBe(first.root.children?.[0]?.children?.[0]?.ref.id);
  });

  it('keeps no identity for a control under a look-alike, so reads do not pile them up', async () => {
    const card = (ref: string) => ({ role: 'group', name: 'Card', children: [{ role: 'button', name: 'Open', ref_id: ref, bounds: { x: 10, y: 10, width: 60, height: 20 } }] });
    const read = screen('w-mine', { name: 'Cards', bounds: { x: 0, y: 0, width: 300, height: 300 }, subtree_truncated: true, children: [card('@s:e1'), card('@s:e2')] }, { complete: false, truncated: true });
    const { surface } = await launched({ snapshot: [read] }, { observe: false });
    const ids = (surface as unknown as { ids: Map<string, string> }).ids;
    await surface.observe(operation(), undefined);
    const size = ids.size;
    for (let index = 0; index < 5; index += 1) await surface.observe(operation(), undefined);
    expect(ids.size).toBe(size);
  });

  it('gives no id to a control beside a wrapper the read cut off at the depth limit, which may hide its twin', async () => {
    const remove = (ref: string, x: number) => ({ role: 'button', name: 'Delete', ref_id: ref, bounds: { x, y: 10, width: 60, height: 20 } });
    const read = (nodes: readonly unknown[]) => screen('w-mine', { name: 'Rows', bounds: { x: 0, y: 0, width: 300, height: 300 }, children: [{ role: 'list', name: 'Rows', children: nodes }] });
    const { surface } = await launched({ snapshot: [read([remove('@s:e1', 200)]), read([remove('@s:e1', 200)]), read([remove('@s:e2', 10), { role: 'group', children_count: 2 }])] }, { observe: false });
    const first = await surface.observe(operation(), undefined);
    const cut = await surface.observe(operation(), undefined);
    expect(cut.root.children?.[0]?.children?.[0]?.ref.id).not.toBe(first.root.children?.[0]?.children?.[0]?.ref.id);
  });

  it("passes no id on through a read cut short that gave the twins' parent a fresh id", async () => {
    const item = (name: string, ref: string) => ({ role: 'menuitem', name, ref_id: ref, native_id: { kind: 'ax_identifier', value: 'menuItemSelected:' }, bounds: { x: 10, y: 10, width: 100, height: 20 } });
    const read = (items: readonly unknown[], cut = false) =>
      screen('w-mine', { name: 'Menu', bounds: { x: 0, y: 0, width: 300, height: 300 }, ...(cut ? { subtree_truncated: true } : {}), children: [{ role: 'menu', name: 'Actions', children: items }] }, cut ? { complete: false, truncated: true } : {});
    const { surface } = await launched({ snapshot: [read([item('Archive', '@s:e1')]), read([item('Archive', '@s:e1')]), read([item('Archive', '@s:e1'), item('Delete', '@s:e2')], true), read([item('Delete', '@s:e2')])] }, { observe: false });
    const first = await surface.observe(operation(), undefined);
    await surface.observe(operation(), undefined);
    const final = await surface.observe(operation(), undefined);
    const only = (observed: typeof first) => observed.root.children?.[0]?.children?.[0];
    expect(only(final)?.name).toBe('Delete');
    expect(only(final)?.ref.id).not.toBe(only(first)?.ref.id);
  });

  it('keeps the id of a control a read cut short did not reach, and retires one it saw a twin take', async () => {
    const mail = { role: 'textfield', name: 'To', ref_id: '@s:e1', native_id: { kind: 'ax_identifier', value: 'mail' }, bounds: { x: 10, y: 10, width: 100, height: 20 } };
    const send = { role: 'button', name: 'Send', ref_id: '@s:e2', bounds: { x: 10, y: 40, width: 60, height: 20 } };
    const read = (nodes: readonly unknown[], complete = true) => screen('w-mine', { name: 'Mail', bounds: { x: 0, y: 0, width: 300, height: 300 }, children: nodes }, { complete });
    const { surface } = await launched({ snapshot: [read([mail, send]), read([mail, send]), read([{ ...send, ref_id: '@s:e3' }, send], false), read([mail, send])] }, { observe: false });
    const idOf = (root: SemanticNode, name: string) => root.children?.find((node) => node.name === name)?.ref.id;
    const first = await surface.observe(operation(), undefined);
    await surface.observe(operation(), undefined);
    const final = await surface.observe(operation(), undefined);
    expect(idOf(final.root, 'To')).toBe(idOf(first.root, 'To'));
    expect(idOf(final.root, 'Send')).not.toBe(idOf(first.root, 'Send'));
  });
});

describe('DesktopSurface: windows', () => {
  it('reads only the window a test chose, until it goes back to the focused one', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel', is_focused: false }])] });
    await expect(surface.useWindow('w-gone', signal, 5_000)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    await surface.useWindow('w-panel', signal, 5_000);
    await surface.observe(operation(), undefined);
    expect(last(fake, 'snapshot')).toMatchObject({ windowId: 'w-panel' });
    await surface.useWindow(undefined, signal, 5_000);
    await surface.observe(operation(), undefined);
    expect(last(fake, 'snapshot')).toMatchObject({ windowId: 'w-mine' });
  });

  it('acts on no node read in another window than the one a test chose', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel' }])] });
    await surface.useWindow('w-panel', signal, 5_000);
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(inputs(fake)).toEqual([]);
  });

  it('refuses to read a chosen window that closed between the list and the read', async () => {
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel' }])], snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')] });
    await surface.useWindow('w-panel', signal, 5_000);
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/useWindow\(\) chose/) });
  });

  it('refuses to read a chosen window once it closed, rather than show an empty screen', async () => {
    const both = windows(() => [{ id: 'w-mine', is_focused: true }, { id: 'w-panel' }]);
    const { surface } = await launched({ listWindows: [both, both, both, windows(() => [{ id: 'w-mine', is_focused: true }])] });
    await surface.useWindow('w-panel', signal, 5_000);
    await expect(surface.locate(testId('nowhere'), operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/useWindow\(\) chose/) });
    await expect(surface.pressKey('Enter', operation())).rejects.toThrow(/useWindow\(\) chose/);
  });
});

describe('DesktopSurface: acting', () => {
  it('fills a field with the value as a call argument, never through another process', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('password'), { kind: 'fill', value: 'hunter2', sensitive: true }, operation());
    const fill = last<{ ref: string; action: string; value: string; timeoutMs: number }>(fake, 'act')!;
    expect(fill).toMatchObject({ ref: '@s1y1hxmo5pexrl:e2', action: 'setValue', value: 'hunter2' });
    // The driver's own wait is what is left of the operation's budget.
    expect(fill.timeoutMs).toBeGreaterThan(9_000);
    expect(fill.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('leaves whether a box needs checking to the driver, which reads its live state', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('remember'), { kind: 'check' }, operation());
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(fake.acted()).toEqual(['check', 'uncheck']);
  });

  it('unchecks a mixed checkbox, whose state is neither checked nor unchecked', async () => {
    const mixed = JSON.parse(JSON.stringify(snapshotAnswer('macos/appkit-form')).replace('"value":"0"', '"value":"2","states":["indeterminate"]')) as Answer;
    const { surface, fake, byTestId } = await launched({ snapshot: [mixed] });
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(fake.acted()).toEqual(['uncheck']);
  });

  it('maps each control action onto the driver action that performs it', async () => {
    const { surface, fake, byTestId } = await launched({}, { options: { headed: true } });
    const signIn = byTestId('sign-in');
    for (const kind of ['tap', 'doubleTap', 'secondaryTap', 'focus', 'clear', 'hover'] as const) await surface.perform(signIn, { kind }, operation());
    expect(fake.acted()).toEqual(['click', 'doubleClick', 'rightClick', 'focus', 'clear', 'hover']);
  });

  it('refuses to act on the window but to swipe or bring it into view', async () => {
    const { surface } = await launched({});
    await expect(surface.perform({ id: 'root', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('refuses to act on a node the driver gave no ref', async () => {
    const read = screen('w-mine', { name: 'Form', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [{ role: 'statictext', value: 'Hello', bounds: { x: 10, y: 10, width: 50, height: 20 } }] });
    const { surface, fake } = await launched({ snapshot: [read] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(inputs(fake)).toEqual([]);
  });

  it('reports a click the driver may have delivered as possibly committed, and one it refused by its code', async () => {
    const { surface, byTestId } = await launched({ act: [failure('ACTION_FAILED', 'delivered_unverified'), failure('ACTION_NOT_SUPPORTED', 'not_delivered'), failure('STALE_REF', 'not_delivered')] });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reports an action still running when its budget ran out as possibly committed, and a cancelled one as cancelled', async () => {
    const { surface, byTestId } = await launched({ act: [{ ok: true, data: {}, sleepMs: 3_000 }] });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), timeoutMs: 600 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('sends nothing once the operation budget is spent', async () => {
    const { surface, fake, byTestId } = await launched({});
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(inputs(fake)).toEqual([]);
  });

  it('takes a visible window as in view, and refuses a minimized one', async () => {
    const shown = await launched({}, { observe: false });
    await shown.surface.perform({ id: 'root', revision: '' }, { kind: 'scrollIntoView' }, operation());
    const minimized = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }]), windows(() => [{ id: 'w-mine', minimized: true, visible: false }])] }, { observe: false });
    await expect(minimized.surface.perform({ id: 'root', revision: '' }, { kind: 'scrollIntoView' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/not on screen/) });
  });

  it('scrolls nothing to bring visible static text into view, and refuses hidden text it cannot scroll to', async () => {
    const read = (states: readonly string[]) => screen('w-mine', { name: 'Form', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [{ role: 'statictext', value: 'Sign in to the testbed', states, bounds: { x: 10, y: 10, width: 150, height: 20 } }] });
    const text = { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Sign in to the testbed', exact: true } } } as const;
    const shown = await launched({ snapshot: [read([])] }, { observe: false });
    const [label] = await shown.surface.locate(text, operation());
    await shown.surface.perform(label!.ref, { kind: 'scrollIntoView' }, operation());
    expect(inputs(shown.fake)).toEqual([]);
    const away = await launched({ snapshot: [read(['offscreen'])] }, { observe: false });
    const [hidden] = await away.surface.locate(text, operation());
    await expect(away.surface.perform(hidden!.ref, { kind: 'scrollIntoView' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('scrolls a control into view through the driver when it is hidden and has a ref', async () => {
    const read = screen('w-mine', { name: 'Form', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [{ role: 'button', name: 'Far', ref_id: '@s:e1', states: ['offscreen'], bounds: { x: 10, y: 900, width: 50, height: 20 } }] });
    const { surface, fake } = await launched({ snapshot: [read] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![0]!.ref, { kind: 'scrollIntoView' }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@s:e1', action: 'scrollTo' });
  });

  it('scrolls the window on a root swipe right after a restart, by its momentum', async () => {
    const scrollable = screen('w-mine', { name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', ref_id: '@s9:e1', available_actions: ['Scroll'] }] });
    const { surface, fake } = await launched({ snapshot: [scrollable] }, { observe: false });
    await surface.restart(operation());
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@s9:e1', action: 'scroll', direction: 'down', pages: 0.5 });
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'up', momentum: 'fast' }, operation());
    expect(last(fake, 'act')).toMatchObject({ direction: 'up', pages: 1.5 });
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'left', momentum: 'slow' }, operation());
    expect(last(fake, 'act')).toMatchObject({ direction: 'left', pages: 0.75 });
  });

  it('scrolls the window as it is now on a root swipe, not the container of an older observation', async () => {
    const read = (id: string) => screen('w-mine', { name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', name: id, ref_id: `@${id}:e1`, available_actions: ['Scroll'] }] });
    const { surface, fake } = await launched({ snapshot: [read('s1'), read('s1'), read('s2')] });
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@s2:e1', action: 'scroll' });
  });

  it('keeps every node of a screen larger than the binding cap', async () => {
    const buttons = Array.from({ length: 5_000 }, (_, index) => ({ role: 'button', name: `b${index}`, ref_id: `@s1:e${index}` }));
    const { surface, fake } = await launched({ snapshot: [screen('w-mine', { name: 'Big', children: buttons })] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![0]!.ref, { kind: 'tap' }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@s1:e0', action: 'click' });
  });

  it("waits out settle after an agent's action, and never after a test's own", async () => {
    const { surface, byTestId } = await launched({}, { options: { settle: 600 } });
    let started = Date.now();
    await surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation('agent'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    started = Date.now();
    await surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation());
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('DesktopSurface: select', () => {
  it('selects an option by its label through the driver', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: '- None -' }, operation());
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: { value: 'Team' } }, operation());
    expect(fake.of('act').map((call) => call.args[0])).toEqual([expect.objectContaining({ action: 'select', value: '- None -' }), expect.objectContaining({ action: 'select', value: 'Team' })]);
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: { index: 1 } }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('reports an option the list does not have as missing', async () => {
    const { surface, fake, byTestId } = await launched({ act: [failure('ELEMENT_NOT_FOUND', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no option "Team"/) });
    expect(fake.acted()).toEqual(['select']);
  });

  it('names a menu the driver could not close after a select of a missing option', async () => {
    const { surface, byTestId } = await launched({ act: [failure('ELEMENT_NOT_FOUND', 'delivered_unverified', 'the list has no option "Enterprise", and its menu did not close', { menu: 'open' })] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: expect.stringMatching(/menu is still open/) });
  });

  it('reports a select that may have chosen something as possibly committed', async () => {
    const { surface, byTestId } = await launched({ act: [failure('ACTION_FAILED', 'delivered_unverified'), failure('ELEMENT_NOT_FOUND', 'delivered_unverified')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.not.stringMatching(/menu is still open/) });
  });

  it('maps a select the driver refused by its code', async () => {
    const refusals = { ACTION_NOT_SUPPORTED: 'UNSUPPORTED_CAPABILITY', POLICY_DENIED: 'UNSUPPORTED_CAPABILITY', TIMEOUT: 'NOT_ACTIONABLE', ACTION_FAILED: 'NOT_ACTIONABLE', STALE_REF: 'NODE_STALE' } as const;
    for (const [refusal, code] of Object.entries(refusals)) {
      const { surface, byTestId } = await launched({ act: [failure(refusal, 'not_delivered')] });
      await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code });
    }
  });

  it('never types a missing option into an editable combo box as free text: a select there is refused, and nothing is sent', async () => {
    const editable = screen('w-mine', { name: 'Form', children: [{ role: 'combobox', name: 'Plan', ref_id: '@s5:e1', available_actions: ['Click', 'SetValue', 'SetFocus'] }] });
    const { surface, fake } = await launched({ snapshot: [editable] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/editable.*fill\(\)/) });
    expect(inputs(fake)).toEqual([]);
  });
});

describe('DesktopSurface: keys', () => {
  it('presses keys as driver combos into the window of the launched process, without physical input', async () => {
    const { surface, fake } = await launched({});
    await surface.pressKey('ControlOrMeta+a', operation());
    expect(last(fake, 'press')).toEqual({ pid: fake.pid, windowId: 'w-mine', combo: 'cmd+a', physical: false });
  });

  it('presses keys through the real keyboard with headed', async () => {
    const { surface, fake } = await launched({}, { options: { headed: true } });
    await surface.pressKey('Enter', operation());
    expect(last(fake, 'press')).toMatchObject({ combo: 'return', physical: true });
  });

  it("refuses a key the driver could not send to the app's key window, and says nothing was sent", async () => {
    const unconfirmed = failure('ACTION_FAILED', 'not_delivered', 'the window is not the key window', { cause: 'exact_window_focus_unconfirmed' });
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], press: [unconfirmed] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Tab' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/key window.*nothing was sent/) });
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('press').map((call) => (call.args[0] as { combo: string; windowId: string }).combo)).toEqual(['tab', 'return']);
  });

  it('presses a key into a control only while it holds focus, and into its own window', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')] });
    await surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation());
    expect(inputs(fake)).toEqual(['focus', 'press return']);
    expect(last(fake, 'press')).toMatchObject({ windowId: 'w-mine' });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'press', key: 'Enter' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('press')).toHaveLength(1);
  });

  it('sends no key when focusing the control fails', async () => {
    const { surface, fake, byTestId } = await launched({ act: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.of('press')).toHaveLength(0);
  });

  it('refuses a key the engine cannot press before it moves focus', async () => {
    const { surface, fake, byTestId } = await launched({});
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Insert' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(inputs(fake)).toEqual([]);
  });

  it('reports a read that went stale after the press focused the control as possibly committed, so it is not retried and focused again', async () => {
    const form = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    const { surface, fake, byTestId } = await launched({ snapshot: [form, form, failure('APP_UNRESPONSIVE', 'not_delivered', 'busy', { retryable: true })] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Tab' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(fake.acted()).toEqual(['focus']);
    expect(fake.of('press')).toHaveLength(0);
  });

  it("sends no key into a window that cannot be shown to be the app's key window", async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], listWindows: [windows(() => [{ id: 'w-mine', is_focused: false }, { id: 'w-panel', is_focused: true }])] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation())).rejects.toThrow(/key window/);
    expect(fake.of('press')).toHaveLength(0);
  });

  it('presses a key into a control whose window is on another Space, which the window list shows as not visible', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], listWindows: [windows(() => [{ id: 'w-mine', is_focused: true, visible: false }])] }, { options: { headed: true } });
    await surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation());
    expect(last(fake, 'press')).toMatchObject({ combo: 'return', windowId: 'w-mine' });
  });

  it('sends no key when another control in the same place holds focus', async () => {
    const form = renamed('macos/sign-in-form', 'w-8321', 'w-mine');
    const swapped = JSON.parse(JSON.stringify(form).replace('"name":"Username"', '"name":"Search"').replace('"value":"username"', '"value":"search"')) as Answer;
    const { surface, fake, byTestId } = await launched({ snapshot: [form, form, swapped] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation())).rejects.toThrow(/did not keep keyboard focus/);
    expect(fake.of('press')).toHaveLength(0);
  });

  const field = (name: string, ref: string, y: number, focused: boolean, extra: Record<string, unknown> = {}) => ({ role: 'textfield', name, ref_id: ref, bounds: { x: 10, y, width: 100, height: 20 }, ...(focused ? { states: ['focused'] } : {}), ...extra });
  const list = (id: string, children: readonly unknown[], extra: Record<string, unknown> = {}) => screen('w-mine', { name: 'List', bounds: { x: 0, y: 0, width: 200, height: 200 }, children }, { snapshot_id: id, ...extra });

  it('presses a key into one of two look-alike fields, found again by its place', async () => {
    const read = (id: string, focusSecond: boolean) => list(id, [field('Item', `@${id}:e1`, 10, false), field('Item', `@${id}:e2`, 40, focusSecond)]);
    const { surface, fake } = await launched({ snapshot: [read('s1', false), read('s1', false), read('s2', true)] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation());
    expect(last(fake, 'press')).toMatchObject({ combo: 'a', windowId: 'w-mine' });
  });

  it('sends no key when a twin went as the field was focused, so the other could have taken its place', async () => {
    const both = list('s1', [field('Item', '@s1:e1', 10, false), field('Item', '@s1:e2', 40, false)]);
    const one = list('s2', [field('Item', '@s2:e1', 40, true)]);
    const { surface, fake } = await launched({ snapshot: [both, both, one] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('press')).toHaveLength(0);
  });

  it('sends no key when focusing a look-alike field replaced it with one of the same name but another developer id', async () => {
    const id = (value: string) => ({ native_id: { kind: 'ax_identifier', value } });
    const read = (snapshot: string, value: string, focusSecond: boolean) => list(snapshot, [field('Item', `@${snapshot}:e1`, 10, false, id(value)), field('Item', `@${snapshot}:e2`, 40, focusSecond, id(value))]);
    const { surface, fake } = await launched({ snapshot: [read('s1', 'Old', false), read('s1', 'Old', false), read('s2', 'New', true)] }, { observe: false, options: { headed: true } });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('press')).toHaveLength(0);
  });

  it('sends no key when focusing a look-alike field replaced the form with other fields in the same places', async () => {
    const read = (snapshot: string, name: string, focusSecond: boolean) => list(snapshot, [field(name, `@${snapshot}:e1`, 10, false), field(name, `@${snapshot}:e2`, 40, focusSecond)]);
    const { surface, fake } = await launched({ snapshot: [read('s1', 'Old', false), read('s1', 'Old', false), read('s2', 'New', true)] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('press')).toHaveLength(0);
  });

  it('says the read was cut short, not that focus moved, when the focus check runs out of time', async () => {
    const whole = list('s1', [field('User', '@s1:e1', 10, false), field('Note', '@s1:e2', 40, false)]);
    const cut = screen('w-mine', { name: 'List', bounds: { x: 0, y: 0, width: 200, height: 200 }, subtree_truncated: true, children: [field('User', '@s2:e1', 10, true), field('Note', '@s2:e2', 40, false, { subtree_truncated: true })] }, { snapshot_id: 's2', complete: false, truncated: true });
    const { surface, fake } = await launched({ snapshot: [whole, whole, cut] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ message: expect.stringMatching(/read only in part/) });
    expect(fake.of('press')).toHaveLength(0);
  });

  it('presses a key into a located field among look-alike cards with interactive snapshots, and keeps the observation ids', async () => {
    const window = { name: 'Notes', bounds: { x: 0, y: 0, width: 300, height: 300 } };
    const note = (focused: boolean) => ({ role: 'textfield', name: 'Note', ref_id: '@s:e1', native_id: { kind: 'ax_identifier', value: 'note' }, bounds: { x: 10, y: 10, width: 100, height: 20 }, ...(focused ? { states: ['focused'] } : {}) });
    const card = (inside: readonly unknown[]) => ({ role: 'group', name: 'Card', children: inside });
    const read = (focused: boolean) => ({
      ...screen('w-mine', { ...window, children: [card([note(focused)]), card([{ role: 'statictext', value: 'Draft', bounds: { x: 10, y: 60, width: 80, height: 20 } }])] }),
      interactive: screen('w-mine', { ...window, children: [card([note(focused)])] }),
    });
    const { surface, fake } = await launched({ snapshot: [read(false), read(false), read(false), read(false), read(true)] }, { observe: false, options: { snapshot: 'interactive', headed: true } });
    const before = await surface.observe(operation(), undefined);
    const [located] = await surface.locate(testId('note'), operation());
    const after = await surface.observe(operation(), undefined);
    expect(after.root.children?.[0]?.children?.[0]?.ref.id).toBe(before.root.children?.[0]?.children?.[0]?.ref.id);
    await surface.perform(located!.ref, { kind: 'press', key: 'a' }, operation());
    expect(last(fake, 'press')).toMatchObject({ combo: 'a', windowId: 'w-mine' });
  });

  it("waits out settle after an agent's key press, as after its other actions", async () => {
    const { surface } = await launched({}, { options: { settle: 600 } });
    const started = Date.now();
    await surface.pressKey('Tab', operation('agent'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });
});

describe('DesktopSurface: typing', () => {
  it('types keystrokes into the focused field, into the app without headed and through the real keyboard with it', async () => {
    const { surface, fake } = await launched({});
    await surface.typeText('ada', { replace: false }, operation());
    expect(last(fake, 'act')).toMatchObject({ ref: '@s1y1hxmo5pexrl:e1', action: 'type', value: 'ada', physical: false });
    const headed = await launched({}, { options: { headed: true } });
    await headed.surface.typeText('ada', { replace: false }, operation());
    expect(last(headed.fake, 'act')).toMatchObject({ action: 'type', physical: true });
  });

  it('stops the text still to type once the call is cut off, so no key lands after the step gave up', async () => {
    const { surface, fake } = await launched({ act: [{ ok: true, data: {}, sleepMs: 2_000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(surface.typeText('ada', { replace: false }, { ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const { inputId } = last(fake, 'act') as { inputId: number };
    expect(fake.of('cancelTyping').map((entry) => entry.args)).toEqual([[inputId]]);
    // A typing call that answers in time cancels nothing.
    const quick = await launched({});
    await quick.surface.typeText('ada', { replace: false }, operation());
    expect(quick.fake.of('cancelTyping')).toEqual([]);
  });

  it('replaces the focused field as a keyboard does, select all and delete, and never by an accessibility clear', async () => {
    const { surface, fake } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')] });
    await surface.typeText('ada', { replace: true }, operation());
    expect(inputs(fake)).toEqual(['press cmd+a', 'press backspace', 'type']);
  });

  it('sends nothing when the control with keyboard focus takes no text, so no select-all or delete reaches a list or button', async () => {
    const focusedButton = JSON.parse(
      JSON.stringify(snapshotAnswer('macos/appkit-form'))
        .replace('"states":["focused"]', '"states":[]')
        .replace('"native_id":{"kind":"ax_identifier","value":"sign-in"}', '"native_id":{"kind":"ax_identifier","value":"sign-in"},"states":["focused"]'),
    ) as Answer;
    const { surface, fake } = await launched({ snapshot: [focusedButton] });
    for (const replace of [true, false]) await expect(surface.typeText('ada', { replace }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/takes no text/) });
    expect(inputs(fake)).toEqual([]);
  });

  it('refuses a NUL before any key is sent, so a replace never empties the field for nothing', async () => {
    const { surface, fake } = await launched({});
    await expect(surface.typeText('a\0b', { replace: true }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(inputs(fake)).toEqual([]);
    // Long text is the driver's to type in chunks.
    await surface.typeText('a'.repeat(20_000), { replace: false }, operation());
    expect(fake.acted()).toEqual(['type']);
  });

  it('sends no delete when select all moved focus off the field, so it never reaches another control', async () => {
    const form = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    const moved = JSON.parse(
      JSON.stringify(form)
        .replace('"states":["focused"]', '"states":[]')
        .replace('"native_id":{"kind":"ax_identifier","value":"sign-in"}', '"native_id":{"kind":"ax_identifier","value":"sign-in"},"states":["focused"]'),
    ) as Answer;
    const { surface, fake } = await launched({ snapshot: [form, form, form, moved] });
    await expect(surface.typeText('ada', { replace: true }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringMatching(/lost keyboard focus after select all/) });
    expect(inputs(fake)).toEqual(['press cmd+a']);
  });

  it('reports a type after a clear that changed the field as possibly committed', async () => {
    const { surface } = await launched({ act: [failure('STALE_REF', 'not_delivered')] });
    await expect(surface.typeText('ada', { replace: true }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  });

  it('reads again, rather than find no focused field or nothing to scroll, when a read runs out of time', async () => {
    const window = { name: 'Form', bounds: { x: 0, y: 0, width: 200, height: 200 } };
    const cut = screen('w-mine', { ...window, subtree_truncated: true, children: [{ role: 'button', name: 'OK', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 40, height: 20 } }] }, { complete: false, truncated: true });
    const whole = screen('w-mine', { ...window, children: [] });
    const { surface } = await launched({ snapshot: [whole, cut] }, { observe: false });
    await expect(surface.typeText('ada', { replace: false }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/which field has keyboard focus/) });
    await expect(surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/what in it scrolls/) });
  });
});

describe('DesktopSurface: points', () => {
  const button = (id: string, x: number) => screen(id, { name: id, bounds: { x, y: 0, width: 200, height: 100 }, children: [{ role: 'button', name: 'OK', ref_id: `@${id}:e1`, bounds: { x: x + 10, y: 10, width: 40, height: 20 } }] }, { snapshot_id: id });

  it("measures the agent's point in the newest observation's window, as core hit-tests it, though that observation had no image", async () => {
    const { surface, fake } = await launched(
      {
        listWindows: [windows(() => [{ id: 'w-a', bounds: { x: 100, y: 0, width: 200, height: 100 } }, { id: 'w-b', is_focused: true, bounds: { x: 500, y: 0, width: 200, height: 100 } }])],
        // The open's read, the first observation and the read after its capture show window A; the second observation reads dialog B, whose capture fails.
        snapshot: [button('w-a', 100), button('w-a', 100), button('w-a', 100), button('w-b', 500)],
        screenshot: [{ ok: true, writePng: { width: 200, height: 100 }, data: { scale_factor: 1 } }, failure('INTERNAL', 'not_delivered', 'capture failed')],
      },
      { observe: false, options: { headed: true } },
    );
    expect((await surface.observe(operation('agent'), { pixels: true })).pixels).toBeDefined();
    expect((await surface.observe(operation('agent'), { pixels: true })).pixels).toBeUndefined();
    await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation('agent'));
    expect(fake.of('pointer').at(-1)?.args).toEqual([520, 30, 'tap']);
  });

  it("measures a test's point in the window of the newest read, though that read took no image", async () => {
    const both = (focused: string) => windows(() => [{ id: 'w-a', is_focused: focused === 'w-a', bounds: { x: 100, y: 0, width: 200, height: 100 } }, { id: 'w-b', is_focused: focused === 'w-b', bounds: { x: 500, y: 0, width: 200, height: 100 } }]);
    const { surface, fake } = await launched({ listWindows: [both('w-a'), both('w-a'), both('w-b')], snapshot: [button('w-a', 100), button('w-a', 100), button('w-b', 500)] }, { observe: false, options: { headed: true } });
    await surface.locate({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } }, operation());
    await surface.observe(operation(), undefined);
    await surface.performAt({ x: 100, y: 50 }, { kind: 'tap' }, operation());
    expect(fake.of('pointer').at(-1)?.args).toEqual([600, 50, 'tap']);
  });

  it('taps, double-taps, secondary-taps, and hovers a point in the window where it is now, with no observation first', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true, bounds: { x: 300, y: 200, width: 400, height: 300 } }])] }, { observe: false, options: { headed: true } });
    for (const kind of ['tap', 'doubleTap', 'secondaryTap', 'hover'] as const) await surface.performAt({ x: 20, y: 30 }, { kind }, operation());
    expect(fake.of('pointer').map((call) => call.args)).toEqual([[320, 230, 'tap'], [320, 230, 'doubleTap'], [320, 230, 'secondaryTap'], [320, 230, 'hover']]);
    expect(fake.of('focusWindow').every((call) => call.args[1] === 'w-mine')).toBe(true);
  });

  it('taps a point in the window it was taken from, even after another window took focus', async () => {
    const pair = (first: number) => windows(() => [{ id: 'w-mine', is_focused: first === 0, bounds: { x: 100, y: 100, width: 400, height: 300 } }, { id: 'w-other', is_focused: first === 1, bounds: { x: 700, y: 200, width: 400, height: 300 } }]);
    const form = renamed('macos/sign-in-form', 'w-8321', 'w-mine');
    const { width, height } = (form.data as { tree: { bounds: { width: number; height: number } } }).tree.bounds;
    // The open's read, the observation and the read after its capture list w-mine focused; then w-other takes focus, and w-mine comes back once brought forward.
    const { surface, fake } = await launched({ snapshot: [form], screenshot: [{ ok: true, writePng: { width, height }, data: { scale_factor: 1 } }], listWindows: [pair(0), pair(0), pair(0), pair(1), pair(0)] }, { observe: false, options: { headed: true } });
    expect((await surface.observe(operation(), { pixels: true })).pixels).toBeDefined();
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    expect(fake.of('focusWindow').at(-1)?.args).toEqual([fake.pid, 'w-mine']);
    expect(fake.of('pointer').at(-1)?.args).toEqual([110, 120, 'tap']);
  });

  it('measures a point in the window a locate read, after a dialog window took over', async () => {
    const pair = windows(() => [{ id: 'w-8032', is_focused: false, bounds: { x: 100, y: 100, width: 400, height: 300 } }, { id: 'w-dialog', is_focused: true, bounds: { x: 500, y: 100, width: 300, height: 200 } }]);
    const { surface, fake } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-dialog')], listWindows: [pair] }, { options: { headed: true } });
    await surface.locate(testId('sign-in'), operation());
    await surface.performAt({ x: 11.5, y: 16.25 }, { kind: 'tap' }, operation());
    expect(fake.of('focusWindow').at(-1)?.args[1]).toBe('w-dialog');
    expect(fake.of('pointer').at(-1)?.args).toEqual([511.5, 116.25, 'tap']);
  });

  it('taps a point in the window a test chose after a read of another one', async () => {
    const pair = (panel = false) => windows(() => [{ id: 'w-8032', is_focused: !panel, bounds: { x: 100, y: 100, width: 400, height: 300 } }, { id: 'w-panel', is_focused: panel, bounds: { x: 600, y: 100, width: 300, height: 200 } }]);
    // The panel has focus once it is brought forward, the fifth listing.
    const { surface, fake } = await launched({ listWindows: [pair(), pair(), pair(), pair(), pair(true)] }, { options: { headed: true } });
    await surface.locate(testId('sign-in'), operation());
    await surface.useWindow('w-panel', signal, 5_000);
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    expect(fake.of('focusWindow').at(-1)?.args[1]).toBe('w-panel');
    expect(fake.of('pointer').at(-1)?.args).toEqual([610, 120, 'tap']);
  });

  it('refuses a point when another window took focus as the target came forward, since the click carries no window', async () => {
    const list = (sheet: boolean) => windows(() => [{ id: 'w-mine', is_focused: !sheet, bounds: { x: 100, y: 100, width: 400, height: 300 } }, ...(sheet ? [{ id: 'w-sheet', is_focused: true, bounds: { x: 100, y: 120, width: 400, height: 200 } }] : [])]);
    const { surface, fake } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], listWindows: [list(false), list(false), list(false), list(true)] }, { options: { headed: true } });
    await expect(surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/another window took focus/) });
    expect(fake.of('pointer')).toHaveLength(0);
  });

  it('measures a point from where the window is once it was brought forward', async () => {
    const at = (x: number) => windows(() => [{ id: 'w-mine', is_focused: true, bounds: { x, y: 200, width: 400, height: 300 } }]);
    const { surface, fake } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], listWindows: [at(100), at(100), at(100), at(500)] }, { options: { headed: true } });
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    expect(fake.of('pointer').at(-1)?.args).toEqual([510, 220, 'tap']);
  });

  it('refuses a point outside the window, which would land on another app', async () => {
    const { surface, fake } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true, bounds: { x: 100, y: 100, width: 100, height: 100 } }])] }, { observe: false, options: { headed: true } });
    await expect(surface.performAt({ x: 115, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.of('pointer')).toHaveLength(0);
    expect(fake.of('focusWindow')).toHaveLength(0);
  });
});

describe('DesktopSurface: pixels', () => {
  type Form = { ok: true; data: { complete?: boolean; tree: { bounds: { width: number; height: number }; children_count?: number } } };
  const form = () => renamed('macos/sign-in-form', 'w-8321', 'w-mine') as Form;
  const plain = () => JSON.parse(JSON.stringify(form()).replaceAll('"secure"', '"required"')) as Form;
  const capture = (answer: Form): Answer => ({ ok: true, writePng: { width: answer.data.tree.bounds.width, height: answer.data.tree.bounds.height }, data: { scale_factor: 1 } });

  it('captures the window with every secure field painted over, into the attempt\'s screenshots', async () => {
    const shot = form();
    const { surface, fake } = await launched({ snapshot: [shot], screenshot: [capture(shot)] });
    await startAttempt(surface);
    const relative = await surface.screenshot('shot', operation());
    expect(relative).toBe(path.join('screenshots', '001-shot.png'));
    // The unmasked capture goes to the worker's private directory, and is removed.
    const file = last<{ path: string; windowId: string }>(fake, 'screenshot')!;
    expect(file.windowId).toBe('w-mine');
    expect(file.path.startsWith((surface as unknown as { home: string }).home)).toBe(true);
    expect(existsSync(file.path)).toBe(false);
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toMatchObject({ mediaType: 'image/png', width: 420, height: 352, scale: 1 });
    expect(observed.maskedRegionCount).toBe(1);
  });

  it('withholds a screenshot when the snapshot did not read the whole window', async () => {
    const partial = form();
    const { surface } = await launched({ snapshot: [{ ...partial, data: { ...partial.data, complete: false } }] });
    await startAttempt(surface);
    await expect(surface.screenshot('partial', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/did not read the whole window/) });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    // Withheld pixels still report the regions masked, none, so the harness reads unproven masking, not a missing screenshot.
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('tries a window with no secure field again when its read ran out of time, and refuses one deeper than maxDepth', async () => {
    const window = plain();
    const outOfTime = { ...window, data: { ...window.data, complete: false } };
    const timed = await launched({ screenshot: [capture(window)], snapshot: [window, outOfTime, window] }, { observe: false });
    const first = await timed.surface.observe(operation(), { pixels: true });
    expect(first.pixels).toBeUndefined();
    expect(first).not.toHaveProperty('maskedRegionCount');
    const second = await timed.surface.observe(operation(), { pixels: true });
    expect(second.pixels).toBeDefined();
    expect(second.maskedRegionCount).toBe(0);
    const deep = { ...window, data: { ...window.data, tree: { ...window.data.tree, children_count: 999 } } };
    const { surface } = await launched({ screenshot: [capture(window)], snapshot: [window, deep] }, { observe: false });
    await startAttempt(surface);
    await expect(surface.screenshot('deep', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/deeper than desktop\(\{ maxDepth \}\) reads \(24 levels\)/) });
    expect((await surface.observe(operation(), { pixels: true })).maskedRegionCount).toBe(0);
  });

  it('reports a capture that failed as no screenshot, not as masking it could not prove', async () => {
    const denied = failure('PERM_DENIED', 'not_delivered', 'screencapture could not capture the window; it needs Screen Recording permission');
    const { surface } = await launched({ snapshot: [form()], screenshot: [denied] });
    await startAttempt(surface);
    await expect(surface.screenshot('denied', operation())).rejects.toThrow(/Screen Recording permission/);
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed).not.toHaveProperty('maskedRegionCount');
  });

  it('fails an observation cancelled while its pixels are captured, rather than return it without them', async () => {
    const { surface, fake } = await launched({ snapshot: [form()], screenshot: [{ ok: true, data: { scale_factor: 1 }, sleepMs: 5_000 }] });
    const controller = new AbortController();
    const observed = surface.observe({ ...operation(), signal: controller.signal }, { pixels: true }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    while (fake.of('screenshot').length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await observed).toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a screenshot as a policy when a password field has no bounds to mask', async () => {
    // The AppKit form's password field was captured with no bounds.
    const { surface } = await launched({});
    await startAttempt(surface);
    await expect(surface.screenshot('unmaskable', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('withholds a screenshot when a secure field moved while it was captured, and keeps one that did not', async () => {
    const shot = form();
    const moved = JSON.parse(JSON.stringify(shot).replace('"y":675', '"y":700')) as Answer;
    const steady = await launched({ screenshot: [capture(shot)], snapshot: [shot] });
    await startAttempt(steady.surface);
    await expect(steady.surface.screenshot('steady', operation())).resolves.toMatch(/steady\.png$/);
    const { surface } = await launched({ screenshot: [capture(shot)], snapshot: [shot, shot, shot, moved] });
    await startAttempt(surface);
    await expect(surface.screenshot('moved', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/window changed while it was captured/) });
  });

  it('withholds a capture as a policy when the read after it fails and a secure field is on screen', async () => {
    const shot = form();
    const { surface } = await launched({ screenshot: [capture(shot)], snapshot: [shot, shot, failure('WINDOW_NOT_FOUND', 'not_delivered')] }, { observe: false });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('withholds a capture of the wrong size as a policy when a secure field is on screen', async () => {
    const shot = form();
    const { width, height } = shot.data.tree.bounds;
    const { surface } = await launched({ screenshot: [{ ok: true, writePng: { width: width + 10, height }, data: { scale_factor: 1 } }], snapshot: [shot] });
    await startAttempt(surface);
    await expect(surface.screenshot('wrong-size', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/does not match the window/) });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('reports a window with no secure field that changed size during the capture as no screenshot, so the next capture may work', async () => {
    const window = plain();
    const grown = JSON.parse(JSON.stringify(window).replace('"height":352', '"height":360')) as Answer;
    const shot = await launched({ screenshot: [capture(window)], snapshot: [window, window, window, grown] });
    await startAttempt(shot.surface);
    await expect(shot.surface.screenshot('grown', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/changed size while it was captured/) });
    const { surface } = await launched({ screenshot: [capture(window)], snapshot: [window, window, window, grown] });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed).not.toHaveProperty('maskedRegionCount');
  });

  it('takes no screenshot with interactive snapshots when the window changed size between the read and the whole read', async () => {
    const tree = (width: number) => ({ name: 'Form', bounds: { x: 0, y: 0, width, height: 100 }, children: [{ role: 'button', name: 'Save', ref_id: '@s:e1', bounds: { x: width - 50, y: 10, width: 40, height: 20 } }] });
    const { surface } = await launched({ snapshot: [screen('w-mine', tree(100)), screen('w-mine', tree(100)), screen('w-mine', tree(200))], screenshot: [{ ok: true, writePng: { width: 200, height: 100 }, data: { scale_factor: 1 } }] }, { observe: false, options: { snapshot: 'interactive' } });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.viewport.width).toBe(100);
    expect(observed.pixels).toBeUndefined();
    expect(observed).not.toHaveProperty('maskedRegionCount');
  });

  it('reads the whole window for a screenshot even with interactive snapshots', async () => {
    const { surface, fake } = await launched({ snapshot: [form()] }, { options: { snapshot: 'interactive' } });
    await startAttempt(surface);
    await surface.screenshot('shot', operation()).catch(() => undefined);
    const reads = fake.of('snapshot').map((call) => (call.args[0] as { interactive: boolean }).interactive);
    expect(reads.at(-1)).toBe(false);
    expect(reads).toContain(true);
  });

  it("keeps the ids of an interactive screen across the whole reads a screenshot's mask takes", async () => {
    const field = { role: 'textfield', name: 'Name', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 50, height: 20 } };
    const window = { name: 'Form', bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const interactive = screen('w-mine', { ...window, children: [field] });
    const whole = screen('w-mine', { ...window, children: [{ role: 'group', name: 'Details', children: [field] }] });
    const { surface } = await launched({ snapshot: [interactive, interactive, interactive, whole, whole, interactive], screenshot: [{ ok: true, writePng: { width: 100, height: 100 }, data: { scale_factor: 1 } }] }, { observe: false, options: { snapshot: 'interactive' } });
    await startAttempt(surface);
    const before = await surface.observe(operation(), undefined);
    await surface.screenshot('shot', operation());
    const after = await surface.observe(operation(), undefined);
    expect(after.root.children?.[0]?.ref.id).toBe(before.root.children?.[0]?.ref.id);
  });

  it('refuses a screenshot outside an attempt, and of an app with no window', async () => {
    const { surface } = await launched({ listWindows: [windows(() => [{ id: 'w-mine', is_focused: true }]), ok([])] }, { observe: false });
    await expect(surface.screenshot('outside', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await startAttempt(surface);
    await expect(surface.screenshot('none', operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/no window/) });
  });
});

describe('DesktopSurface: quitting', () => {
  it('quits the process it launched at the end of the attempt, and only that one', async () => {
    const theirs = standIn();
    const { surface, fake } = await launched({});
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.pid)).toBe(true);
    expect(await gone(theirs, 300)).toBe(false);
    expect(fake.of('forgetProcess').map((call) => call.args[0])).toEqual([fake.pid]);
  });

  it('closes the app on desktop.closeApp(), and opens it fresh again', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    const first = fake.pid;
    await surface.closeApp(signal, 5_000);
    expect(await gone(first)).toBe(true);
    await surface.restart(operation());
    expect(fake.pid).not.toBe(first);
  });

  it('kills nothing when the app already quit on its own', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    process.kill(fake.pid, 'SIGKILL');
    expect(await gone(fake.pid)).toBe(true);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  it('removes the launch record once the app quit, and the state directory at dispose', async () => {
    const { surface } = await launched({}, { observe: false });
    const home = (surface as unknown as { home: string }).home;
    const record = JSON.parse(readFileSync(path.join(home, 'app.json'), 'utf8')) as { token: string; pid: number; started: number };
    expect(record).toMatchObject({ token: expect.any(String), pid: expect.any(Number), started: expect.any(Number) });
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(existsSync(path.join(home, 'app.json'))).toBe(false);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(existsSync(home)).toBe(false);
  });
});

describe('DesktopSurface: sweeping what killed workers left', () => {
  it('quits the app a killed worker left running, by its launch token, and nothing else', async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const theirs = standIn();
    const leaked = standIn();
    fake.carriers.set(theirs, 'another-token');
    fake.carriers.set(leaked, 'token-1');
    // Written before the launch: the token alone, since the worker may be killed before it learns the process id.
    const first = leftDirectory(String(dead), { token: 'token-1' });
    const second = leftDirectory(String(dead), { pid: theirs, token: 'token-1' });
    try {
      await initialized(fake);
      expect(await gone(leaked)).toBe(true);
      expect(await gone(theirs, 300)).toBe(false);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
    } finally {
      for (const directory of [first, second]) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("quits the process a killed worker's record names by its id and start, though its environment cannot be read, and not a later one given that id", async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const leaked = standIn();
    const reused = standIn();
    const directories = [
      leftDirectory(String(dead), { token: 'token-1', pid: leaked, started: fake.processStarted(leaked) }),
      // The id the record names now belongs to a process that started at another time.
      leftDirectory(String(dead), { token: 'token-2', pid: reused, started: 7 }),
    ];
    try {
      await initialized(fake);
      expect(await gone(leaked)).toBe(true);
      expect(await gone(reused, 300)).toBe(false);
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("quits the process an agent-desktop engine's record names by its id and `ps` start time, and not a later one given that id", async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const leaked = standIn();
    const reused = standIn();
    // 2026-11-26T10:00:00.123456Z, which `ps -o lstart=` in UTC prints to the second.
    fake.startTimes.set(leaked, 1_795_687_200_123_456);
    fake.startTimes.set(reused, 1_795_690_800_000_000);
    const directories = [
      leftDirectory(String(dead), { token: 'token-1', pid: leaked, started: 'Thu Nov 26 10:00:00 2026' }, 'e2e-agent-desktop-'),
      leftDirectory(String(dead), { token: 'token-2', pid: reused, started: 'Thu Nov 26 10:00:00 2026' }, 'e2e-agent-desktop-'),
    ];
    try {
      await initialized(fake);
      expect(await gone(leaked)).toBe(true);
      expect(await gone(reused, 300)).toBe(false);
      expect(existsSync(directories[0]!)).toBe(false);
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sweeps the agent-desktop engine\'s state directories too, whose field text must not stay behind', async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const leaked = standIn();
    fake.carriers.set(leaked, 'token-old');
    const left = leftDirectory(String(dead), { token: 'token-old' }, 'e2e-agent-desktop-');
    mkdirSync(path.join(left, 'refs'));
    writeFileSync(path.join(left, 'refs', 'fields.json'), '{"value":"ada"}');
    try {
      await initialized(fake);
      expect(await gone(leaked)).toBe(true);
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('keeps the launch record of a killed worker when the process lookup fails, and quits its app at the next sweep', async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const leaked = standIn();
    fake.carriers.set(leaked, 'token-keep');
    const left = leftDirectory(String(dead), { token: 'token-keep' });
    writeFileSync(path.join(left, 'fields.json'), '{"text":"typed"}');
    try {
      fake.lookupFails = true;
      await initialized(fake);
      expect(await gone(leaked, 300)).toBe(false);
      expect(readdirSync(left).toSorted()).toEqual(['app.json', 'owner']);
      fake.lookupFails = false;
      await initialized(fake);
      expect(await gone(leaked)).toBe(true);
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('quits the app a failed dispose left running at the next init in the same process', async () => {
    const fake = fakeDriver();
    // No start time to tell the process by: only its token shows it is still the launch's.
    fake.startsUnreadable = true;
    const { surface } = await launched(fake, { observe: false });
    const pid = fake.pid;
    const home = (surface as unknown as { home: string }).home;
    try {
      fake.lookupFails = true;
      await expect(surface.dispose({ signal, timeoutMs: 5_000 })).rejects.toThrow(/could not tell whether process/);
      expect(await gone(pid, 300)).toBe(false);
      expect(readFileSync(path.join(home, 'owner'), 'utf8')).toBe('abandoned');
      expect(readdirSync(home).toSorted()).toEqual(['app.json', 'owner']);
      // A second host in this process, as a program that opens one after another does.
      fake.lookupFails = false;
      fake.startsUnreadable = false;
      await initialized(fake);
      expect(await gone(pid)).toBe(true);
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('trusts no state directory it cannot show this user wrote: a symlink in the temporary directory is left alone', async () => {
    const dead = await deadPid();
    const fake = fakeDriver();
    const victim = standIn();
    fake.carriers.set(victim, 'token-planted');
    // What another user could put in a shared /tmp: a link named like a state directory, to a record that names a process of this user.
    const planted = artifacts();
    writeFileSync(path.join(planted, 'owner'), String(dead));
    writeFileSync(path.join(planted, 'app.json'), JSON.stringify({ token: 'token-planted' }));
    const link = path.join(tmpdir(), `e2e-desktop-worker-planted-${process.pid}`);
    symlinkSync(planted, link);
    try {
      await initialized(fake);
      expect(await gone(victim, 300)).toBe(false);
      expect(existsSync(path.join(planted, 'app.json'))).toBe(true);
    } finally {
      // The link itself, never its target: rmSync on a link to a directory throws on Node 24.8.
      unlinkSync(link);
    }
  });

  it("sweeps a state directory whose owner's id another process took, and records when its own worker started", async () => {
    // This test's own process id, but another start time: the worker that wrote it is gone, and the OS gave its id to this process.
    const left = leftDirectory(`${process.pid}\n7`);
    try {
      const { surface, fake } = await initialized({});
      expect(existsSync(left)).toBe(false);
      const home = (surface as unknown as { home: string }).home;
      expect(readFileSync(path.join(home, 'owner'), 'utf8')).toBe(`${process.pid}\n${fake.processStarted(process.pid)}`);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('keeps the state directory and app of a live worker, its start written the way the agent-desktop engine wrote it', async () => {
    const fake = fakeDriver();
    const worker = standIn();
    const app = standIn();
    fake.carriers.set(app, 'token-live');
    fake.startTimes.set(worker, 1_795_687_200_500_000);
    const used = leftDirectory(`${worker}\nThu Nov 26 10:00:00 2026`, { token: 'token-live' }, 'e2e-agent-desktop-');
    try {
      await initialized(fake);
      expect(existsSync(used)).toBe(true);
      expect(await gone(app, 300)).toBe(false);
    } finally {
      rmSync(used, { recursive: true, force: true });
    }
  });

  it("sweeps an agent-desktop worker's directory whose process id another process took since", async () => {
    const fake = fakeDriver();
    const reused = standIn();
    fake.startTimes.set(reused, 1_795_690_800_000_000);
    const left = leftDirectory(`${reused}\nThu Nov 26 10:00:00 2026`, { token: 'token-gone' }, 'e2e-agent-desktop-');
    try {
      await initialized(fake);
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('sweeps a state directory whose launch record was cut short, and starts', async () => {
    const left = leftDirectory(String(await deadPid()), '{"pid":');
    try {
      await initialized({});
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('sweeps the state directories of workers that are gone, and keeps the ones in use', async () => {
    const left = leftDirectory(String(await deadPid()));
    const used = leftDirectory(String(process.pid));
    try {
      await initialized({});
      expect(existsSync(left)).toBe(false);
      expect(existsSync(used)).toBe(true);
    } finally {
      rmSync(left, { recursive: true, force: true });
      rmSync(used, { recursive: true, force: true });
    }
  });
});

describe('DesktopSurface: doctor', () => {
  it('reports the driver and the permissions it holds', async () => {
    const fake = fakeDriver();
    fake.screenRecording = false;
    const surface = new DesktopSurface(resolveOptions({}), 'macos', () => fake);
    const checks = await surface.doctor({ targetName: 'mac', projectRoot: process.cwd(), app: { bundleId: 'com.example.app' }, env: {}, headed: false, signal, log: () => undefined });
    expect(checks).toEqual([
      { id: 'desktop-driver', status: 'pass', message: 'desktop driver 0.0.0-test' },
      { id: 'accessibility', status: 'pass', message: expect.any(String) },
      { id: 'screen-recording', status: 'warn', message: expect.stringMatching(/Screen Recording/) },
    ]);
  });

  it('fails doctor when the native driver cannot be loaded', async () => {
    const surface = new DesktopSurface(resolveOptions({}), 'macos', () => {
      throw new Error('no native driver for this machine');
    });
    const checks = await surface.doctor({ targetName: 'mac', projectRoot: process.cwd(), app: { bundleId: 'com.example.app' }, env: {}, headed: false, signal, log: () => undefined });
    expect(checks).toEqual([{ id: 'desktop-driver', status: 'fail', message: 'no native driver for this machine' }]);
  });

  it('fails doctor on an appPath that is no app bundle, or does not exist', async () => {
    const directory = artifacts();
    mkdirSync(path.join(directory, 'Empty.app'));
    const surface = new DesktopSurface(resolveOptions({}), 'macos', () => fakeDriver());
    const appPath = async (app: { appPath: string }) => (await surface.doctor({ targetName: 'mac', projectRoot: directory, app, env: {}, headed: false, signal, log: () => undefined })).find((check) => check.id === 'app-path');
    expect(await appPath({ appPath: 'Empty.app' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/no Contents\/Info.plist/) });
    expect(await appPath({ appPath: 'Missing.app' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/does not exist/) });
  });

  it.skipIf(process.platform !== 'darwin')("fails doctor on a bundle init would refuse: no bundle id, or not the target's", async () => {
    const directory = artifacts();
    const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
    for (const [name, body] of [['Anonymous.app', ''], ['Built.app', '<key>CFBundleIdentifier</key><string>dev.e2e.built</string>']] as const) {
      mkdirSync(path.join(directory, name, 'Contents'), { recursive: true });
      writeFileSync(path.join(directory, name, 'Contents', 'Info.plist'), plist(body));
    }
    const surface = new DesktopSurface(resolveOptions({}), 'macos', () => fakeDriver());
    const appPath = async (app: { appPath: string; bundleId?: string }) => (await surface.doctor({ targetName: 'mac', projectRoot: directory, app, env: {}, headed: false, signal, log: () => undefined })).find((check) => check.id === 'app-path');
    expect(await appPath({ appPath: 'Anonymous.app' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/declares no CFBundleIdentifier/) });
    expect(await appPath({ appPath: 'Built.app', bundleId: 'com.example.other' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/is not the CFBundleIdentifier "dev.e2e.built"/) });
    expect(await appPath({ appPath: 'Built.app', bundleId: 'dev.e2e.built' })).toMatchObject({ status: 'pass' });
  });
});
