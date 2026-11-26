/**
 * Builds the native driver (`native/`, a NAPI-RS crate) for this Mac, or
 * for the target triple given, and puts it where the engine loads it from
 * in a checkout: `native/desktop.<platform>-<arch>.node`.
 *
 * Usage: `pnpm --filter @e2e-dev/desktop build:native [-- --target x86_64-apple-darwin] [--out <dir>]`.
 * `--out` copies the addon into another directory too, the platform package
 * (`packages/desktop-darwin-*`) before it is published, with a stamp naming
 * that package's version, which its `prepublishOnly` checks. Needs a Rust
 * toolchain (`rustup`), and runs on macOS only.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** The Node platform and arch each supported target triple builds for. */
const TARGETS: Readonly<Record<string, string>> = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
};

/** The oldest macOS the addon runs on. */
const DEPLOYMENT_TARGET = '13.0';

const { values } = parseArgs({ options: { target: { type: 'string' }, out: { type: 'string' } } });
if (process.platform !== 'darwin') throw new Error('the native driver builds on macOS only');
const target = values.target ?? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
const platform = TARGETS[target];
if (platform === undefined) throw new Error(`no native driver build for ${target}; one of ${Object.keys(TARGETS).join(', ')}`);

const crate = path.join(import.meta.dirname, '..', 'native');
execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit', env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET } });
const built = path.join(crate, 'target', target, 'release', 'libe2e_desktop_native.dylib');
const name = `desktop.${platform}.node`;
copyFileSync(built, path.join(crate, name));
if (values.out !== undefined) {
  mkdirSync(values.out, { recursive: true });
  copyFileSync(built, path.join(values.out, name));
  const manifest = path.join(values.out, 'package.json');
  if (existsSync(manifest)) {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    writeFileSync(path.join(values.out, '.build.json'), `${JSON.stringify({ version })}\n`);
  }
}
process.stdout.write(`built ${path.join(crate, name)}\n`);
