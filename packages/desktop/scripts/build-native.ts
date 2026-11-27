/**
 * Builds the native driver (`native/`, a NAPI-RS crate) for this Mac, or
 * for the target triple given, and puts it where the engine loads it from
 * in a checkout: `native/desktop.<platform>-<arch>.node`.
 *
 * Usage: `pnpm --filter @e2e-dev/desktop build:native [--target x86_64-apple-darwin] [--out <dir>]`.
 * `--out` copies the addon into another directory too, the platform package
 * (`packages/desktop-darwin-*`) before it is published, with a stamp naming
 * that package's version, which its `prepublishOnly` checks. Needs a Rust
 * toolchain (`rustup`), and runs on macOS only.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cargo } from './cargo.ts';

/** The Node platform and arch each supported target triple builds for. */
const TARGETS: Readonly<Record<string, string>> = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
};

/** The oldest macOS the addon runs on. */
const DEPLOYMENT_TARGET = '13.0';

// pnpm passes a `--` before the script's own arguments through: it separates nothing here.
const argv = process.argv.slice(2);
const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: { target: { type: 'string' }, out: { type: 'string' } } });
if (process.platform !== 'darwin') throw new Error('the native driver builds on macOS only');
const target = values.target ?? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
const platform = TARGETS[target];
if (platform === undefined) throw new Error(`no native driver build for ${target}; one of ${Object.keys(TARGETS).join(', ')}`);

const crate = path.join(import.meta.dirname, '..', 'native');
const run = cargo(crate);
const env = { ...run.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET };
// A pinned toolchain installed before (another checkout's, or under a `RUSTUP_TOOLCHAIN` override) may lack this
// target's standard library; adding one already there is a no-op.
if (run.toolchain !== undefined) execFileSync('rustup', ['target', 'add', '--toolchain', run.toolchain, target], { cwd: crate, stdio: 'inherit', env });
execFileSync(run.file, [...run.prefix, 'build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit', env });
// Where cargo wrote it: `CARGO_TARGET_DIR` or a cargo config can move the target directory off `native/target`.
const metadata = JSON.parse(execFileSync(run.file, [...run.prefix, 'metadata', '--format-version', '1', '--no-deps'], { cwd: crate, encoding: 'utf8', env })) as { target_directory: string };
const built = path.join(metadata.target_directory, target, 'release', 'libe2e_desktop_native.dylib');
const name = `desktop.${platform}.node`;
replace(built, path.join(crate, name));
if (values.out !== undefined) {
  mkdirSync(values.out, { recursive: true });
  replace(built, path.join(values.out, name));
  const manifest = path.join(values.out, 'package.json');
  if (existsSync(manifest)) {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    writeFileSync(path.join(values.out, '.build.json'), `${JSON.stringify({ version })}\n`);
  }
}
process.stdout.write(`built ${path.join(crate, name)}\n`);

/**
 * Copies an addon over an older one as a new file. macOS keeps the code
 * signature it checked for a file, so an addon overwritten in place gets the
 * next process that loads it killed (exit 137).
 */
function replace(from: string, to: string): void {
  rmSync(to, { force: true });
  copyFileSync(from, to);
}
