/**
 * Finds cargo for the native driver's scripts: a Homebrew rustup puts no
 * `cargo` on `PATH` of its own, and the toolchain `rust-toolchain.toml`
 * pins may not be installed yet.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * The environment cargo runs in: one with the pinned toolchain's directory in
 * front, which rustup names, so a standalone cargo earlier on `PATH` (one
 * without both macOS targets) is not the one that builds. With no rustup, the
 * `cargo` on `PATH`. A Homebrew rustup puts no `cargo` on `PATH` of its own,
 * and the toolchain `rust-toolchain.toml` pins may not be installed yet.
 */
export function cargoEnvironment(directory: string): NodeJS.ProcessEnv {
  if (spawnSync('rustup', ['--version'], { stdio: 'ignore' }).error !== undefined) {
    if (spawnSync('cargo', ['--version'], { cwd: directory, stdio: 'ignore' }).error === undefined) return process.env;
    throw new Error('the native driver needs Rust: install rustup (https://rustup.rs), which installs the toolchain native/rust-toolchain.toml pins');
  }
  const which = (): string | undefined => {
    const found = spawnSync('rustup', ['which', 'cargo'], { cwd: directory, encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : undefined;
  };
  let cargo = which();
  if (cargo === undefined) {
    // With no toolchain named, rustup installs the one the crate's `rust-toolchain.toml` pins.
    spawnSync('rustup', ['toolchain', 'install'], { cwd: directory, stdio: 'inherit' });
    cargo = which();
  }
  if (cargo === undefined) throw new Error('rustup could not install the toolchain native/rust-toolchain.toml pins');
  return { ...process.env, PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ''}` };
}
