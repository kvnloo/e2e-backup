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
