/**
 * Writes the notices of the crates the native driver links into the
 * platform packages, `packages/desktop-darwin-*\/THIRD_PARTY_LICENSES.md`.
 * The addon is a static library of them, and their licenses (MIT,
 * Apache-2.0, and the like) ask that their notices go with every copy.
 *
 * Usage: `pnpm --filter @e2e-dev/desktop licenses:native [--check]`. With `--check` it
 * writes nothing and fails when a committed file differs from what
 * `Cargo.lock` gives, which CI's `native` job runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cargo } from './cargo.ts';

interface Target {
  readonly kind: readonly string[];
}

interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly manifest_path: string;
  readonly targets: readonly Target[];
}

interface Metadata {
  readonly packages: readonly CargoPackage[];
  readonly resolve: {
    readonly root: string;
    readonly nodes: readonly { readonly id: string; readonly deps: readonly { readonly pkg: string; readonly dep_kinds: readonly { readonly kind: string | null }[] }[] }[];
  };
}

/** A license file's name: `LICENSE`, `LICENSE-MIT`, `COPYING`, `UNLICENSE`, with any extension. */
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)/i;

const crate = path.join(import.meta.dirname, '..', 'native');
/** License texts of repositories whose crates publish none of their own, by `<owner>/<repo>` (`native/licenses/README.md`). */
const vendored = path.join(crate, 'licenses');
const packages = path.join(import.meta.dirname, '..', '..');
const outputs = ['desktop-darwin-arm64', 'desktop-darwin-x64'].map((name) => path.join(packages, name, 'THIRD_PARTY_LICENSES.md'));

const run = cargo(crate);
// Resolved for the two Mac targets the platform packages ship, so a crate only another OS links (`windows-link`) is not listed.
const metadata = JSON.parse(
  execFileSync(run.file, [...run.prefix, 'metadata', '--format-version', '1', '--locked', '--filter-platform', 'aarch64-apple-darwin', '--filter-platform', 'x86_64-apple-darwin'], {
    cwd: crate,
    encoding: 'utf8',
    env: run.env,
    maxBuffer: 64 * 1024 * 1024,
  }),
) as Metadata;
const text = notices(linked(metadata));

if (process.argv.includes('--check')) {
  const stale = outputs.filter((file) => !existsSync(file) || readFileSync(file, 'utf8') !== text);
  if (stale.length > 0) {
    console.error(`stale: ${stale.map((file) => path.relative(packages, file)).join(', ')}; run pnpm --filter @e2e-dev/desktop licenses:native`);
    process.exit(1);
  }
  console.log('third-party licenses are current');
} else {
  for (const file of outputs) writeFileSync(file, text);
  console.log(`wrote ${outputs.map((file) => path.relative(packages, file)).join(', ')}`);
}

/**
 * The crates built into the addon: what the driver depends on, through
 * normal dependencies only, less the proc macros and build-time crates
 * that run in the compiler and are not linked.
 */
function linked(graph: Metadata): CargoPackage[] {
  const byId = new Map(graph.packages.map((cargoPackage) => [cargoPackage.id, cargoPackage]));
  const nodes = new Map(graph.resolve.nodes.map((node) => [node.id, node]));
  // A proc macro and what it depends on run in the compiler: the walk does not go through one.
  const procMacro = (id: string): boolean => byId.get(id)?.targets.every((target) => target.kind.includes('proc-macro')) ?? false;
  const seen = new Set<string>();
  const pending = [graph.resolve.root];
  while (pending.length > 0) {
    const node = nodes.get(pending.pop() ?? '');
    for (const dep of node?.deps ?? []) {
      if (seen.has(dep.pkg) || procMacro(dep.pkg) || !dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      seen.add(dep.pkg);
      pending.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((cargoPackage): cargoPackage is CargoPackage => cargoPackage !== undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The license texts of a crate that publishes no license file, from its repository's texts vendored under
 * `native/licenses/<owner>/<repo>`. A crate with neither stops the generator: a sentence naming the license would drop
 * the copyright and permission notice the license requires.
 */
function repositoryTexts(cargoPackage: CargoPackage): string[] {
  const slug = /github\.com\/([^/]+\/[^/.]+)/.exec(cargoPackage.repository ?? '')?.[1];
  const directory = slug === undefined ? undefined : path.join(vendored, slug);
  const files = directory !== undefined && existsSync(directory) ? readdirSync(directory).filter((name) => LICENSE_FILE.test(name)).toSorted() : [];
  if (directory === undefined || files.length === 0) {
    throw new Error(`${cargoPackage.name} ${cargoPackage.version} publishes no license file, and native/licenses has none for its repository (${cargoPackage.repository ?? 'none named'}); add that repository's license texts there`);
  }
  const texts = files.map((name) => readFileSync(path.join(directory, name), 'utf8').trim());
  // An empty file is a fetch that found nothing, never a license.
  if (texts.some((body) => body === '')) throw new Error(`a vendored license text for ${cargoPackage.name} under native/licenses/${slug} is empty`);
  return texts;
}

/** The notices file: each distinct license text once, under the crates that carry it. */
function notices(crates: readonly CargoPackage[]): string {
  const groups = new Map<string, string[]>();
  for (const cargoPackage of crates) {
    const directory = path.dirname(cargoPackage.manifest_path);
    const files = readdirSync(directory).filter((name) => LICENSE_FILE.test(name)).toSorted();
    const label = `${cargoPackage.name} ${cargoPackage.version} (${cargoPackage.license ?? 'no license field'})${cargoPackage.repository === null ? '' : `, ${cargoPackage.repository}`}`;
    const texts = files.length > 0 ? files.map((name) => readFileSync(path.join(directory, name), 'utf8').trim()) : repositoryTexts(cargoPackage);
    for (const body of texts) groups.set(body, [...(groups.get(body) ?? []), label]);
  }
  const sections = [...groups].map(([body, labels]) => `## ${[...new Set(labels)].join('; ')}\n\n\`\`\`text\n${body}\n\`\`\``);
  return `# Third-party licenses\n\nThe native driver in this package is built from these Rust crates, generated from \`packages/desktop/native/Cargo.lock\` by \`packages/desktop/scripts/native-licenses.ts\`.\n\n${sections.join('\n\n')}\n`;
}
