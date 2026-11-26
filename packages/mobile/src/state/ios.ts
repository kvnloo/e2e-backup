/** An iOS simulator's snapshot: the app's data container, and its items in the simulator's keychain database. */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { invalidState, unsupported } from '../support.ts';
import { failure, packFiles, run, unpackFiles, type PlatformState, type RunOptions, type StateTarget } from './host.ts';
import { insertRow, Rows, SecureStore } from './rows.ts';

/** The keychain's item tables, one per item class. */
const ITEM_TABLES = ['genp', 'inet', 'cert', 'keys'] as const;
/**
 * The keys a simulator's keychain encrypts item attributes with, one row per
 * protection class, generated per simulator. An item row reads only beside
 * the keys it was written under, so a snapshot carries them.
 */
const KEYS_TABLE = 'metadatakeys';

const IosState = z.object({
  platform: z.literal('ios'),
  app: z.string(),
  /** The data container: a gzipped tar, base64. */
  files: z.string(),
  keychain: z.object({ metadatakeys: Rows, genp: Rows, inet: Rows, cert: Rows, keys: Rows }),
});
type IosState = z.infer<typeof IosState>;

const CONTAINER_METADATA = '.com.apple.mobile_container_manager.metadata.plist';
/** Purgeable or regenerated on launch; the container's own metadata belongs to the device. */
const EXCLUDED = ['./tmp', './Library/Caches', './Library/SplashBoard', './Library/Saved Application State', `./${CONTAINER_METADATA}`];
const PREFERENCES_DAEMON = 'com.apple.cfprefsd.xpc.daemon';
const KEYCHAIN_DAEMON = 'com.apple.securityd';

const SimulatorList = z.object({ devices: z.record(z.string(), z.array(z.object({ udid: z.string(), dataPath: z.string().optional() }))) });

const simctl = (step: string, args: readonly string[], options: RunOptions) => run(step, 'xcrun', ['simctl', ...args], options);

async function simulatorPaths(target: StateTarget, signal: AbortSignal): Promise<{ container: string; keychain: string }> {
  const listed = SimulatorList.parse(JSON.parse((await simctl('finding the simulator', ['list', 'devices', '-j'], { signal })).toString('utf8')));
  const device = Object.values(listed.devices).flat().find((entry) => entry.udid === target.deviceId);
  if (device?.dataPath === undefined) {
    throw unsupported(`a session can be saved on a local iOS simulator only, and ${target.deviceId} is not one`);
  }
  const container = (await simctl('finding the app data', ['get_app_container', target.deviceId, target.app, 'data'], { signal })).toString('utf8').trim();
  return { container, keychain: path.join(device.dataPath, 'Library', 'Keychains', 'keychain-2-debug.db') };
}

/** Exit 0 or not: an app that is not running has nothing left to write. */
const stopApp = (target: StateTarget, signal: AbortSignal) => simctl('stopping the app', ['terminate', target.deviceId, target.app], { signal, allowFailure: true });

/** Stops one of the simulator's daemons and waits for it to exit; launchd starts it again on demand. */
async function stopDaemon(step: string, target: StateTarget, label: string, signal: AbortSignal): Promise<void> {
  const listed = (await simctl(step, ['spawn', target.deviceId, 'launchctl', 'list'], { signal })).toString('utf8');
  const pid = Number(listed.split('\n').find((line) => line.endsWith(`\t${label}`))?.split('\t')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  await simctl(step, ['spawn', target.deviceId, 'launchctl', 'kill', 'SIGTERM', `user/${String(userInfo().uid)}/${label}`], { signal });
  const deadline = Date.now() + 5000;
  while (isRunning(pid)) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw failure(`${step}: the simulator's ${label} did not stop`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops the simulator's preferences daemon. It writes UserDefaults to disk
 * many seconds late and answers from its own cache, so a capture without
 * this misses a fresh write and a restore without it leaves the previous
 * user's defaults in force. SIGTERM makes it write what it holds.
 */
const flushPreferences = (target: StateTarget, signal: AbortSignal) => stopDaemon('flushing preferences', target, PREFERENCES_DAEMON, signal);

/** The simulator's keychain database, through the host's sqlite3; `-safe` leaves it no way out of the database. `rowid` is the keychain's to assign. */
const keychainAt = (database: string, signal: AbortSignal) =>
  new SecureStore('keychain', (step, sql) => run(step, '/usr/bin/sqlite3', ['-safe', '-bail', '-cmd', '.timeout 5000', database], { signal, stdin: sql }), ['rowid']);

/** Items of the app's own access group, `<team>.<bundle id>`: a team id has no dot. */
const ownedBy = (app: string) => `substr(agrp, instr(agrp, '.') + 1) = '${app}'`;
const EVERY_ROW = '1';

async function capture(target: StateTarget, signal: AbortSignal): Promise<IosState> {
  const paths = await simulatorPaths(target, signal);
  await stopApp(target, signal);
  await flushPreferences(target, signal);
  const archive = await run('reading the app data', '/usr/bin/tar', ['-C', paths.container, ...EXCLUDED.flatMap((entry) => ['--exclude', entry]), '-cf', '-', '.'], { signal });
  const keychain = keychainAt(paths.keychain, signal);
  const owned = ownedBy(target.app);
  const [metadatakeys, genp, inet, cert, keys] = await Promise.all([
    keychain.rows(KEYS_TABLE, EVERY_ROW),
    keychain.rows('genp', owned),
    keychain.rows('inet', owned),
    keychain.rows('cert', owned),
    keychain.rows('keys', owned),
  ]);
  return { platform: 'ios', app: target.app, files: await packFiles(archive), keychain: { metadatakeys, genp, inet, cert, keys } };
}

async function restore(target: StateTarget, data: unknown, signal: AbortSignal): Promise<void> {
  const saved = IosState.safeParse(data);
  if (!saved.success) throw invalidState('the saved session is not an iOS app state');
  const archive = await unpackFiles(saved.data.files);
  const paths = await simulatorPaths(target, signal);
  const keychain = keychainAt(paths.keychain, signal);
  await stopApp(target, signal);
  // Before the files change: the daemon would otherwise write the previous user's defaults over the restored ones.
  await flushPreferences(target, signal);
  // Planned before anything is replaced: a snapshot this simulator's keychain cannot take is refused with the app untouched.
  const items = await keychainItems(target, keychain, saved.data.keychain);
  await replaceContainer(paths.container, archive, signal);
  await keychain.write(items.statements);
  // The daemon holds the keys it started with in memory.
  if (items.foreign) await stopDaemon('writing the keychain', target, KEYCHAIN_DAEMON, signal);
}

async function replaceContainer(container: string, archive: Buffer, signal: AbortSignal): Promise<void> {
  const entries = (await readdir(container)).filter((entry) => entry !== CONTAINER_METADATA);
  await Promise.all(entries.map((entry) => rm(path.join(container, entry), { recursive: true, force: true })));
  await run('writing the app data', '/usr/bin/tar', ['-C', container, '-xf', '-'], { signal, stdin: archive });
  await Promise.all([mkdir(path.join(container, 'tmp'), { recursive: true }), mkdir(path.join(container, 'Library', 'Caches'), { recursive: true })]);
}

/**
 * The statements that put the saved items in place. A snapshot from this
 * simulator, or from one whose keys this one took at an earlier restore,
 * replaces the app's items alone. Any other snapshot is `foreign`: it brings
 * its keys, and the items of every other app go with the old ones, since
 * nothing could read them again. That is `device.clearKeychain()` plus the
 * app's items, once per simulator and snapshot source.
 */
async function keychainItems(target: StateTarget, keychain: SecureStore, saved: IosState['keychain']): Promise<{ foreign: boolean; statements: string[] }> {
  const [deviceKeys, schema] = await Promise.all([keychain.rows(KEYS_TABLE, EVERY_ROW), keychain.schema([KEYS_TABLE, ...ITEM_TABLES])]);
  const held = new Set(deviceKeys.map((row) => JSON.stringify(row)));
  const foreign = saved.metadatakeys.some((row) => !held.has(JSON.stringify(row)));
  const replaced = foreign ? EVERY_ROW : ownedBy(target.app);
  const statements = [
    ...(foreign ? [`delete from ${KEYS_TABLE};`, ...saved.metadatakeys.map((row) => insertRow(KEYS_TABLE, row, schema))] : []),
    ...ITEM_TABLES.flatMap((table) => [`delete from ${table} where ${replaced};`, ...saved[table].map((row) => insertRow(table, row, schema))]),
  ];
  return { foreign, statements };
}

export const ios: PlatformState = { capture, restore };
