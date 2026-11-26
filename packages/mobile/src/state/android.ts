/** An Android emulator's snapshot: the app's data directory, and its keys in the Keystore database when the emulator gives root. */

import path from 'node:path';
import { z } from 'zod';
import { invalidState, unsupported } from '../support.ts';
import { failure, packFiles, run, unpackFiles, type PlatformState, type RunOptions, type StateTarget } from './host.ts';
import { insertRow, Rows, SecureStore, type Row, type Schema } from './rows.ts';

const KEYSTORE_DATABASE = '/data/misc/keystore/persistent.sqlite';
/** A key entry, its blobs and their metadata, and the tables that hang off the entry by `keyentryid`. */
const Keystore = z.object({ keyentry: Rows, blobentry: Rows, blobmetadata: Rows, keyparameter: Rows, keymetadata: Rows });
type Keystore = z.infer<typeof Keystore>;
const KEYSTORE_TABLES = ['keyentry', 'blobentry', 'blobmetadata', 'keyparameter', 'keymetadata'] as const;
const NO_KEYS: Keystore = { keyentry: [], blobentry: [], blobmetadata: [], keyparameter: [], keymetadata: [] };

const AndroidState = z.object({
  platform: z.literal('android'),
  app: z.string(),
  /** The data directory: a gzipped tar, base64. */
  files: z.string(),
  /** Absent when the emulator gave no root: the files of a debuggable build, read as the app itself. */
  keystore: Keystore.optional(),
});
type AndroidState = z.infer<typeof AndroidState>;

/** Kept in place and emptied: their group is the app's cache gid, which a restore as root would lose. */
const CACHES = ['cache', 'code_cache'];
const ROOT = ['su', '0'];

function adbPath(): string {
  const sdk = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  return sdk === undefined || sdk === '' ? 'adb' : path.join(sdk, 'platform-tools', 'adb');
}

/** The app on one emulator, reached as root, or as the app itself when root is refused and the build is debuggable. */
class Emulator {
  private constructor(
    private readonly target: StateTarget,
    private readonly signal: AbortSignal,
    readonly root: boolean,
  ) {}

  static async open(target: StateTarget, signal: AbortSignal): Promise<Emulator> {
    const adb = (prefix: readonly string[]) => run('checking device access', adbPath(), ['-s', target.deviceId, 'shell', '-T', ...prefix, 'id', '-u'], { signal, allowFailure: true });
    if ((await adb(ROOT)).toString('utf8').trim() === '0') return new Emulator(target, signal, true);
    if (/^\d+$/.test((await adb(['run-as', target.app])).toString('utf8').trim())) return new Emulator(target, signal, false);
    throw unsupported(
      `a session can be saved on an Android emulator with root access (any image without Google Play), or for a debuggable build; ${target.deviceId} gives neither for ${target.app}`,
    );
  }

  /**
   * Runs a command on the device. `shell`, never `exec-out` or `exec-in`: those
   * drop the command's exit code, so a failed read would pass for a short one.
   * `-T` keeps adb from allocating a terminal, so bytes pass both ways unchanged.
   */
  private shell(step: string, command: readonly string[], stdin?: RunOptions['stdin']): Promise<Buffer> {
    return run(step, adbPath(), ['-s', this.target.deviceId, 'shell', '-T', ...command], { signal: this.signal, ...(stdin === undefined ? {} : { stdin }) });
  }

  private get dataAccess(): readonly string[] {
    return this.root ? ROOT : ['run-as', this.target.app];
  }

  private get dataDir(): string {
    return `/data/data/${this.target.app}`;
  }

  async stop(): Promise<void> {
    await this.shell('stopping the app', ['am', 'force-stop', this.target.app]);
  }

  readFiles(): Promise<Buffer> {
    const excludes = CACHES.flatMap((entry) => ['--exclude', `./${entry}`]);
    return this.shell('reading the app data', [...this.dataAccess, 'tar', '-cf', '-', '-C', this.dataDir, ...excludes, '.']);
  }

  /** Never `pm clear`: it deletes the app's Keystore keys along with its files. */
  async replaceFiles(archive: Buffer): Promise<void> {
    await this.shell(
      'clearing the app data',
      [...this.dataAccess, 'sh'],
      [
        'set -e',
        `cd ${this.dataDir}`,
        `find . -mindepth 1 -maxdepth 1 ${CACHES.map((entry) => `! -name ${entry}`).join(' ')} -exec rm -rf {} +`,
        `for entry in ${CACHES.join(' ')}; do if [ -d "$entry" ]; then find "$entry" -mindepth 1 -delete; fi; done`,
        '',
      ].join('\n'),
    );
    await this.shell('writing the app data', [...this.dataAccess, 'tar', '-xf', '-', '-C', this.dataDir], archive);
  }

  /** The uid the device installed the app under and the SELinux label of its data directory: both differ from one device to the next. */
  async owner(): Promise<{ uid: string; label: string }> {
    const listed = (await this.shell('reading the app id', ['cmd', 'package', 'list', 'packages', '-U', this.target.app])).toString('utf8');
    const uid = listed.split('\n').find((line) => line.startsWith(`package:${this.target.app} `))?.match(/uid:(\d+)/)?.[1];
    if (uid === undefined) throw failure(`reading the app id: ${this.target.app} is not installed on ${this.target.deviceId}`);
    const label = (await this.shell('reading the app data', [...ROOT, 'stat', '-c', '%C', this.dataDir])).toString('utf8').trim();
    if (!/^[A-Za-z0-9_:,.]+$/.test(label)) throw failure(`reading the app data: ${this.target.app} has no data directory on ${this.target.deviceId}`);
    return { uid, label };
  }

  /** Hands files extracted as root back to the app, under the label its directory carries. */
  async giveFilesTo(owner: { uid: string; label: string }): Promise<void> {
    const { uid, label } = owner;
    await this.shell(
      'writing the app data',
      [...ROOT, 'sh'],
      [
        'set -e',
        `cd ${this.dataDir}`,
        `chown ${uid}:${uid} .`,
        `chcon ${label} .`,
        'for entry in * .[!.]*; do',
        `  case "$entry" in ${CACHES.join('|')}) continue ;; esac`,
        `  if [ -e "$entry" ]; then chown -R ${uid}:${uid} "$entry"; chcon -R ${label} "$entry"; fi`,
        'done',
        '',
      ].join('\n'),
    );
  }

  /** The emulator's Keystore database, through its own sqlite3 as root. */
  get keystore(): SecureStore {
    return new SecureStore('keystore', (step, sql) => this.shell(step, [...ROOT, 'sqlite3', '-safe', '-bail', KEYSTORE_DATABASE], `.timeout 5000\n${sql}`));
  }
}

/** The app's own keys: `domain` 0 is an app's namespace, which is its uid. */
const ownedBy = (uid: string) => `domain = 0 and namespace = ${uid}`;

async function capture(target: StateTarget, signal: AbortSignal): Promise<AndroidState> {
  const emulator = await Emulator.open(target, signal);
  await emulator.stop();
  const files = await packFiles(await emulator.readFiles());
  if (!emulator.root) return { platform: 'android', app: target.app, files };

  const { uid } = await emulator.owner();
  const { keystore } = emulator;
  const entries = `(select id from keyentry where ${ownedBy(uid)})`;
  const [keyentry, blobentry, blobmetadata, keyparameter, keymetadata] = await Promise.all([
    keystore.rows('keyentry', ownedBy(uid)),
    keystore.rows('blobentry', `keyentryid in ${entries}`),
    keystore.rows('blobmetadata', `blobentryid in (select id from blobentry where keyentryid in ${entries})`),
    keystore.rows('keyparameter', `keyentryid in ${entries}`),
    keystore.rows('keymetadata', `keyentryid in ${entries}`),
  ]);
  return { platform: 'android', app: target.app, files, keystore: { keyentry, blobentry, blobmetadata, keyparameter, keymetadata } };
}

async function restore(target: StateTarget, data: unknown, signal: AbortSignal): Promise<void> {
  const saved = AndroidState.safeParse(data);
  if (!saved.success) throw invalidState('the saved session is not an Android app state');
  const archive = await unpackFiles(saved.data.files);
  const emulator = await Emulator.open(target, signal);
  if (saved.data.keystore !== undefined && !emulator.root) {
    throw unsupported(`the saved session carries Keystore keys, which need root access to restore, and ${target.deviceId} gives none`);
  }
  await emulator.stop();
  if (!emulator.root) {
    await emulator.replaceFiles(archive);
    return;
  }
  // Read before the archive lands: it carries the owner of the device it was saved on, the directory's included.
  const owner = await emulator.owner();
  const { keystore } = emulator;
  // Planned before anything is replaced: a snapshot this emulator's Keystore cannot take is refused with the app untouched.
  // A snapshot without keys still replaces the app's state, so the keys of whoever was signed in go.
  const keys = replaceKeys(saved.data.keystore ?? NO_KEYS, owner.uid, await keystore.schema(KEYSTORE_TABLES));
  await emulator.replaceFiles(archive);
  await emulator.giveFilesTo(owner);
  await keystore.write(keys);
}

/** The statements that put `saved` in place of the keys `uid` owns. */
function replaceKeys(saved: Keystore, uid: string, schema: Schema): string[] {
  const insert = (table: keyof Keystore, row: Row, overrides?: Row) => insertRow(table, row, schema, overrides);
  // The app's keys, and any entry already under a saved key's id: ids are unique across the store.
  const savedIds = saved.keyentry.flatMap((row) => (row['id'] === undefined ? [] : [row['id']]));
  const entries = `(select id from keyentry where ${ownedBy(uid)}${savedIds.length === 0 ? '' : ` or id in (${savedIds.join(', ')})`})`;
  return [
    `delete from blobmetadata where blobentryid in (select id from blobentry where keyentryid in ${entries});`,
    `delete from blobentry where keyentryid in ${entries};`,
    `delete from keyparameter where keyentryid in ${entries};`,
    `delete from keymetadata where keyentryid in ${entries};`,
    `delete from grant where keyentryid in ${entries};`,
    `delete from keyentry where id in ${entries};`,
    // A key's namespace is the app's uid, which differs from one device to the next.
    ...saved.keyentry.map((row) => insert('keyentry', row, { namespace: uid })),
    // A blob's id is the device's to assign, the highest so far; its metadata follows it to the new one.
    ...saved.blobentry.flatMap(({ id, ...blob }) => [
      insert('blobentry', blob),
      ...saved.blobmetadata
        .filter((row) => row['blobentryid'] === id)
        .map(({ id: _id, ...metadata }) => insert('blobmetadata', metadata, { blobentryid: '(select max(id) from blobentry)' })),
    ]),
    ...saved.keyparameter.map((row) => insert('keyparameter', row)),
    ...saved.keymetadata.map((row) => insert('keymetadata', row)),
  ];
}

export const android: PlatformState = { capture, restore };
