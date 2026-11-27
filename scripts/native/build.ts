/**
 * Builds one NAPI-RS crate of the `crates/` workspace for this machine, or
 * for the target triple given, and puts the addon where its npm package loads
 * it from in a checkout: `<package>/<name>.<platform>.node`.
 *
 * Usage: `node scripts/native/build.ts --crate e2e-util-napi --package packages/util --name util [--target <triple>] [--out <dir>] [--debug]`.
 * `--out` copies the addon into another directory too, the platform package
 * before it is published, with a stamp naming that package's version, which
 * its `prepublishOnly` checks.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cargo, WORKSPACE } from './cargo.ts';

/** NAPI-RS's platform name for each target triple an addon builds for. */
const TARGETS: Readonly<Record<string, string>> = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
  'aarch64-pc-windows-msvc': 'win32-arm64-msvc',
};

/** The oldest macOS an addon runs on. */
const DEPLOYMENT_TARGET = '13.0';

/** The target triple of the machine this runs on. */
function hostTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  const musl = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime === undefined;
  return `${arch}-unknown-linux-${musl ? 'musl' : 'gnu'}`;
}

/** The file name cargo gives a cdylib on a target. */
function libraryName(crate: string, target: string): string {
  const stem = crate.replaceAll('-', '_');
  if (target.includes('apple')) return `lib${stem}.dylib`;
  if (target.includes('windows')) return `${stem}.dll`;
  return `lib${stem}.so`;
}

// pnpm passes a `--` before the script's own arguments through: it separates nothing here.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    crate: { type: 'string' },
    package: { type: 'string' },
    name: { type: 'string' },
    target: { type: 'string' },
    out: { type: 'string' },
    debug: { type: 'boolean' },
  },
});
if (values.crate === undefined || values.package === undefined || values.name === undefined) throw new Error('--crate, --package, and --name are required');
const target = values.target ?? hostTarget();
const platform = TARGETS[target];
if (platform === undefined) throw new Error(`no addon build for ${target}; one of ${Object.keys(TARGETS).join(', ')}`);

const run = cargo();
const env = { ...run.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET };
if (run.toolchain !== undefined && target !== hostTarget()) {
  execFileSync('rustup', ['target', 'add', '--toolchain', run.toolchain, target], { cwd: WORKSPACE, stdio: 'inherit', env });
}
const profile = values.debug === true ? [] : ['--release'];
execFileSync(run.file, [...run.prefix, 'build', ...profile, '--locked', '-p', values.crate, '--target', target], { cwd: WORKSPACE, stdio: 'inherit', env });
// Where cargo wrote it: `CARGO_TARGET_DIR` or a cargo config can move the target directory.
const metadata = JSON.parse(execFileSync(run.file, [...run.prefix, 'metadata', '--format-version', '1', '--no-deps'], { cwd: WORKSPACE, encoding: 'utf8', env })) as { target_directory: string };
const built = path.join(metadata.target_directory, target, values.debug === true ? 'debug' : 'release', libraryName(values.crate, target));
const name = `${values.name}.${platform}.node`;
const placed = path.join(WORKSPACE, values.package, name);
replace(built, placed);
if (values.out !== undefined) {
  mkdirSync(values.out, { recursive: true });
  replace(built, path.join(values.out, name));
  const manifest = path.join(values.out, 'package.json');
  if (existsSync(manifest)) {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    writeFileSync(path.join(values.out, '.build.json'), `${JSON.stringify({ version })}\n`);
  }
}
process.stdout.write(`built ${placed}\n`);

/**
 * Copies an addon over an older one as a new file. macOS keeps the code
 * signature it checked for a file, so an addon overwritten in place gets the
 * next process that loads it killed (exit 137).
 */
function replace(from: string, to: string): void {
  rmSync(to, { force: true });
  copyFileSync(from, to);
}
