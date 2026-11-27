import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

it.each(['a', 'b'] as const)('reads config edits across physical installs when %s installs the loader first', (first) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-loader-'));
  try {
    for (const name of ['a', 'b']) {
      const install = path.join(dir, name, 'node_modules', 'e2e');
      mkdirSync(install, { recursive: true });
      cpSync(path.join(packageRoot, 'dist'), path.join(install, 'dist'), { recursive: true });
      cpSync(path.join(packageRoot, 'package.json'), path.join(install, 'package.json'));
      symlinkSync(path.join(packageRoot, 'node_modules'), path.join(install, 'node_modules'), 'junction');
      writeFileSync(path.join(dir, name, 'client.mjs'), "export { openHost } from 'e2e/runner';");
    }
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    for (const name of ['primer', 'consumer']) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, 'name.mjs'), "export const name = 'one';");
      writeFileSync(path.join(dir, name, 'e2e.config.mjs'), `
import { name } from './name.mjs';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
export default { targets: [{ name, platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    }
    const second = first === 'a' ? 'b' : 'a';
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { writeFileSync } from 'node:fs';
import path from 'node:path';

async function target(openHost, name) {
  const host = await openHost({ cwd: path.resolve(name), env: {} });
  try { return host.target; } finally { await host.close(); }
}

const { openHost: first } = await import('./${first}/client.mjs');
const results = [await target(first, 'primer')];
const { openHost: second } = await import('./${second}/client.mjs');
results.push(await target(second, 'consumer'));
writeFileSync('consumer/name.mjs', "export const name = 'two';");
results.push(await target(second, 'consumer'));
writeFileSync('consumer/name.mjs', "export const name = 'three';");
results.push(await target(first, 'consumer'));
console.log(JSON.stringify(results));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(actual)).toEqual(['one', 'one', 'two', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

it.each(['before', 'after'])('reloads config dependencies and compiler options with a fragment hook registered %s the loader', (order) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-fragment-hook-'));
  try {
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    for (const tag of ['config', 'child']) {
      writeFileSync(path.join(dir, tag + '-signal.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync('${tag}-touched', '');
export const unused = true;
`);
    }
    writeFileSync(path.join(dir, 'child.ts'), `
import { unused } from './child-signal.mjs';
export { name } from './name.mjs';
`);
    writeFileSync(path.join(dir, 'e2e.config.ts'), `
import { existsSync } from 'node:fs';
import { unused } from './config-signal.mjs';
import { name } from './child.ts';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
const signals = ['config', 'child'].filter(tag => existsSync(tag + '-touched'));
export default { targets: [{ name: [name, ...signals].join('-'), platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { openHost } from ${JSON.stringify(runner)};
import { registerHooks } from 'node:module';
import { rmSync, writeFileSync } from 'node:fs';
const order = ${JSON.stringify(order)};
function instrument() {
  registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith('file:') && /\\/(?:e2e\\.config|child)\\.ts$/.test(new URL(result.url).pathname)) {
      return { ...result, url: result.url + '#instrumented' };
    }
    return result;
  } });
}
async function target(name, verbatimModuleSyntax) {
  writeFileSync('name.mjs', 'export const name = ' + JSON.stringify(name));
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { verbatimModuleSyntax } }));
  for (const tag of ['config', 'child']) rmSync(tag + '-touched', { force: true });
  const host = await openHost({ cwd: process.cwd(), env: {} });
  try { return host.target; } finally { await host.close(); }
}
if (order === 'before') instrument();
const first = await target('one', false);
if (order === 'after') instrument();
console.log(JSON.stringify([first, await target('two', true), await target('three', false)]));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(actual)).toEqual(['one', 'two-config-child', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

const legacyEntries = ['dist/config/load.js', 'src/config/load.ts'];
it.each(legacyEntries)('keeps legacy config loads from %s fresh while leaving matching user queries literal', (entry) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-legacy-loader-'));
  try {
    // Match the old config/load entry without pinning a published package.
    const importConfig = `
import { pathToFileURL } from 'node:url';
export function load(file, query = '?e2e=module-1&e2e-graph=module-1') {
  return import(pathToFileURL(file).href + query);
}
`;
    for (const [folder, name] of [['legacy', 'e2e'], ['user', 'example']] as const) {
      const root = path.join(dir, folder);
      mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module' }));
      writeFileSync(path.join(root, entry), importConfig);
    }
    writeFileSync(path.join(dir, 'legacy', 'helper.mjs'), importConfig);
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    writeFileSync(path.join(dir, 'name.mjs'), "export const name = 'one';");
    writeFileSync(path.join(dir, 'e2e.config.mjs'), `
import { name } from './name.mjs';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
export default { targets: [{ name, platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    writeFileSync(path.join(dir, 'child.mjs'), 'export const search = new URL(import.meta.url).search;');
    for (const name of ['helper', 'user', 'extra']) {
      writeFileSync(path.join(dir, name + '.mjs'), `
import { search as child } from './child.mjs';
export const searches = [new URL(import.meta.url).search, child];
`);
    }
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { openHost } from ${JSON.stringify(runner)};
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { load as legacy } from './legacy/${entry}';
import { load as helper } from './legacy/helper.mjs';
import { load as user } from './user/${entry}';

let instrument = false;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (instrument && result.url.startsWith('file:') && new URL(result.url).pathname.endsWith('/e2e.config.mjs')) {
    return { ...result, url: result.url + '#instrumented' };
  }
  return result;
} });
const host = await openHost({ cwd: process.cwd(), env: {} });
const first = host.target;
await host.close();
writeFileSync('name.mjs', "export const name = 'two';");
const updated = (await legacy(path.resolve('e2e.config.mjs'))).default.targets[0].name;
instrument = true;
writeFileSync('name.mjs', "export const name = 'three';");
const tagged = (await legacy(path.resolve('e2e.config.mjs'), '?e2e=module-2&e2e-graph=module-2')).default.targets[0].name;
writeFileSync('name.mjs', "export const name = 'four';");
const reopened = (await legacy(path.resolve('e2e.config.mjs'), '?e2e=module-3&e2e-graph=module-3')).default.targets[0].name;
const fromHelper = (await helper(path.resolve('helper.mjs'))).searches;
const fromUser = (await user(path.resolve('user.mjs'))).searches;
const fromExtra = (await legacy(path.resolve('extra.mjs'), '?e2e=module-1&e2e-graph=module-1&user=yes')).searches;
console.log(JSON.stringify({ first, updated, tagged, reopened, fromHelper, fromUser, fromExtra }));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    const query = '?e2e=module-1&e2e-graph=module-1';
    expect(JSON.parse(actual)).toEqual({
      first: 'one',
      updated: 'two',
      tagged: 'three',
      reopened: 'four',
      fromHelper: [query, ''],
      fromUser: [query, ''],
      fromExtra: [query + '&user=yes', ''],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);
