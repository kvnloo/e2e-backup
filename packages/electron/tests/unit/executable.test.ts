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
