/**
 * Finds cargo for the native driver's scripts: a Homebrew rustup puts no
 * `cargo` on `PATH` of its own, and the toolchain `rust-toolchain.toml`
 * pins may not be installed yet.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * The environment cargo runs in: this one when `cargo` is on `PATH`, else
 * one with the pinned toolchain's directory in front, which rustup names.
 * A Homebrew rustup puts no `cargo` on `PATH` of its own, and the toolchain
 * `rust-toolchain.toml` pins may not be installed yet.
 */
export function cargoEnvironment(directory: string): NodeJS.ProcessEnv {
  if (spawnSync('cargo', ['--version'], { cwd: directory, stdio: 'ignore' }).error === undefined) return process.env;
  const which = (): string | undefined => {
    const found = spawnSync('rustup', ['which', 'cargo'], { cwd: directory, encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : undefined;
  };
  let cargo = which();
  if (cargo === undefined && spawnSync('rustup', ['--version'], { stdio: 'ignore' }).error === undefined) {
    // With no toolchain named, rustup installs the one the crate's `rust-toolchain.toml` pins.
    spawnSync('rustup', ['toolchain', 'install'], { cwd: directory, stdio: 'inherit' });
    cargo = which();
  }
  if (cargo === undefined) throw new Error('the native driver needs Rust: install rustup (https://rustup.rs), which installs the toolchain native/rust-toolchain.toml pins');
  return { ...process.env, PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ''}` };
}
