/**
 * Puts the driver builds a release made on macOS into the platform packages
 * (`packages/desktop-darwin-*`), each stamped with its package's version, so
 * their `prepublishOnly` (`check-native.ts`) passes. Run after the version
 * step, right before publishing.
 *
 * Usage: `node packages/desktop/scripts/place-native.ts <directory with desktop.darwin-*.node>`.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const source = process.argv[2];
if (source === undefined) throw new Error('usage: place-native.ts <directory with desktop.darwin-*.node>');
const packages = path.join(import.meta.dirname, '..', '..');
for (const platform of ['darwin-arm64', 'darwin-x64']) {
  const addon = path.join(source, `desktop.${platform}.node`);
  if (!existsSync(addon)) throw new Error(`${addon} is missing: the native build did not make it`);
  const target = path.join(packages, `desktop-${platform}`);
  copyFileSync(addon, path.join(target, `desktop.${platform}.node`));
  const { version } = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')) as { version: string };
  writeFileSync(path.join(target, '.build.json'), `${JSON.stringify({ version })}\n`);
  process.stdout.write(`placed ${addon} in ${target} for ${version}\n`);
}
