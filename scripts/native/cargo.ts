/**
 * Finds cargo for the crates in `crates/`: a Homebrew rustup puts no `cargo`
 * on `PATH` of its own, and the toolchain the root `rust-toolchain.toml` pins
 * may not be installed yet.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The repository root, which holds the Cargo workspace. */
export const WORKSPACE = path.join(import.meta.dirname, '..', '..');

/** How to run cargo: the program, the arguments before cargo's own, and the environment. */
export interface Cargo {
  readonly file: string;
  readonly prefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The toolchain `rust-toolchain.toml` pins, when rustup runs cargo; with none, the `cargo` on `PATH`. */
  readonly toolchain?: string;
}

/**
 * Cargo through `rustup run <pinned toolchain>`, with the toolchain's `bin`
 * first on `PATH` so cargo finds its rustc where rustup is the only Rust tool
 * on `PATH` (Homebrew's). With no rustup, the `cargo` on `PATH`. rustup
 * installs the pinned toolchain first when it is missing.
 */
export function cargo(): Cargo {
  if (spawnSync('rustup', ['--version'], { stdio: 'ignore' }).error !== undefined) {
    if (spawnSync('cargo', ['--version'], { cwd: WORKSPACE, stdio: 'ignore' }).error === undefined) return { file: 'cargo', prefix: [], env: process.env };
    throw new Error('the native addons need Rust: install rustup (https://rustup.rs), which installs the toolchain rust-toolchain.toml pins');
  }
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(WORKSPACE, 'rust-toolchain.toml'), 'utf8'))?.[1];
  if (channel === undefined) throw new Error('rust-toolchain.toml names no channel');
  if (spawnSync('rustup', ['which', '--toolchain', channel, 'cargo'], { cwd: WORKSPACE, stdio: 'ignore' }).status !== 0) {
    // With no toolchain named, rustup installs the one `rust-toolchain.toml` pins, with its targets and components.
    const { RUSTUP_TOOLCHAIN: _override, ...env } = process.env;
    spawnSync('rustup', ['toolchain', 'install'], { cwd: WORKSPACE, stdio: 'inherit', env });
  }
  const pinned = spawnSync('rustup', ['which', '--toolchain', channel, 'cargo'], { cwd: WORKSPACE, encoding: 'utf8' });
  if (pinned.status !== 0) throw new Error('rustup could not install the toolchain rust-toolchain.toml pins');
  const bin = path.dirname(pinned.stdout.trim());
  return { file: 'rustup', prefix: ['run', channel, 'cargo'], env: { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }, toolchain: channel };
}
