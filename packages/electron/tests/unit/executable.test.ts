import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeExecutable, resolveExecutable } from '../../src/executable.ts';

const root = mkdtempSync(path.join(tmpdir(), 'e2e-electron-executable-'));
mkdirSync(path.join(root, 'MyApp.app'));
writeFileSync(path.join(root, 'package.json'), '{}');
writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n');
chmodSync(path.join(root, 'run.sh'), 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the project\'s electron package', () => {
  it('starts the binary ELECTRON_OVERRIDE_DIST_PATH names, as Electron\'s own index.js does', async () => {
    const project = path.join(root, 'project');
    const electron = path.join(project, 'node_modules', 'electron');
    const override = path.join(root, 'custom-dist');
    mkdirSync(electron, { recursive: true });
    mkdirSync(override, { recursive: true });
    writeFileSync(path.join(project, 'package.json'), '{}');
    writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.5.0', main: 'index.js' }));
    writeFileSync(path.join(electron, 'index.js'), '');
    writeFileSync(path.join(override, 'electron'), '');
    expect(describeExecutable(project, undefined).status).toBe('warn');
    process.env['ELECTRON_OVERRIDE_DIST_PATH'] = override;
    try {
      await expect(resolveExecutable(project, undefined)).resolves.toBe(path.join(override, 'electron'));
      expect(describeExecutable(project, undefined).status).toBe('pass');
    } finally {
      delete process.env['ELECTRON_OVERRIDE_DIST_PATH'];
    }
  });
});

describe('executablePath', () => {
  it('starts a regular file it may execute', async () => {
    await expect(resolveExecutable(root, 'run.sh')).resolves.toBe(path.join(root, 'run.sh'));
    expect(describeExecutable(root, 'run.sh').status).toBe('pass');
  });

  it('refuses a directory, such as an .app bundle, and a file it may not execute, in doctor as at launch', async () => {
    for (const name of ['MyApp.app', 'package.json', 'missing']) {
      await expect(resolveExecutable(root, name)).rejects.toThrow(/not an executable file/);
      expect(describeExecutable(root, name)).toMatchObject({ status: 'fail', message: expect.stringContaining('not an executable file') });
    }
  });
});
