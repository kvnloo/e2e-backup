/** `e2e cache ls`, `show`, `check`, `clear`, and `stats` over a real store directory. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '@e2e-dev/core/lib/cache/store';
import { main } from '../../src/cli/index.ts';
import type { ActionTrace, TraceProvenance } from '@e2e-dev/core/lib/cache/trace';

let root: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const CACHE_DIR = 'store';

function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

function writeConfig(body: string): void {
  writeFileSync(path.join(root, 'e2e.config.ts'), body, 'utf8');
}

/** The default config of these tests: one target, cache in `store/`. */
function writeDefaultConfig(): void {
  writeConfig(
    `export default { targets: [{ name: 'web', platform: 'web' }], cache: { dir: ${JSON.stringify(CACHE_DIR)} } };\n`,
  );
}

function trace(recordedFor: TraceProvenance | undefined, actions: number): ActionTrace {
  return {
    actions: Array.from({ length: actions }, (_, index) => ({
      name: 'tap' as const,
      summary: `tap ${index}`,
      target: { role: 'button', name: `Button ${index}` },
    })),
    executor: { name: 'example-agent' },
    ...(recordedFor === undefined ? {} : { recordedFor }),
    summary: 'step passed',
  };
}

async function seed(entries: readonly { keyHash: string; trace: ActionTrace }[]): Promise<void> {
  const store = new FileCacheStore({
    directory: path.join(root, CACHE_DIR),
    maxBytes: MAX_CACHE_WIRE_BYTES,
    writable: true,
  });
  for (const entry of entries) await store.write(entry.keyHash, entry.trace);
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args, '--config', path.join(root, 'e2e.config.ts')]);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'e2e-cache-cli-'));
  // The config loader reads .ts config only from an ES module project.
  writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeDefaultConfig();
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('e2e cache ls', () => {
  it('prints the entry, provenance, age, and action count of every entry', async () => {
    await seed([
      {
        keyHash: 'a'.repeat(64),
        trace: trace({ testId: 'tests/signup.e2e.ts::signs up', targetId: 'web', instructionDigest: 'd'.repeat(64) }, 3),
      },
      {
        keyHash: 'b'.repeat(64),
        trace: trace({ testId: 'tests/billing.e2e.ts::upgrades', targetId: 'safari', instructionDigest: 'e'.repeat(64) }, 1),
      },
    ]);
    await invoke('cache', 'ls');
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(process.exitCode).toBe(0);
    expect(lines[0]).toMatch(/^ENTRY +TEST +TARGET +INSTRUCTION +AGE +ACTIONS$/);
    // Sorted by test, so billing precedes signup whatever the file order was.
    expect(lines[1]).toMatch(/^bbbbbbbbbbbb +tests\/billing\.e2e\.ts::upgrades +safari +eeeeeeeeeeee +<1m +1$/);
    expect(lines[2]).toMatch(/^aaaaaaaaaaaa +tests\/signup\.e2e\.ts::signs up +web +dddddddddddd +<1m +3$/);
  });

  it('marks a recording the action cap cut short', async () => {
    await seed([{ keyHash: 'b'.repeat(64), trace: { ...trace(undefined, 2), truncated: true } }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy).trimEnd().split('\n')[1]).toMatch(/ 2 \(truncated\)$/);
  });

  it.each([
    { testId: 'tests/中文.e2e.ts::passes', padding: 2, asciiPadding: 5 },
    { testId: 'tests/e\u0301.e2e.ts::passes', padding: 2, asciiPadding: 2 },
    { testId: 'tests/👩‍💻.e2e.ts::passes', padding: 2, asciiPadding: 3 },
  ])('aligns columns for $testId by displayed width', async ({ testId, padding, asciiPadding }) => {
    const asciiId = 'tests/a.e2e.ts::passes';
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace({ testId: asciiId, targetId: 'web', instructionDigest: 'd'.repeat(64) }, 1) },
      { keyHash: 'b'.repeat(64), trace: trace({ testId, targetId: 'web', instructionDigest: 'e'.repeat(64) }, 1) },
    ]);
    await invoke('cache', 'ls');
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(process.exitCode).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.includes(asciiId))).toBe(
      `aaaaaaaaaaaa  ${asciiId}${' '.repeat(asciiPadding)}web     dddddddddddd  <1m  1`,
    );
    expect(lines.find((line) => line.includes(testId))).toBe(
      `bbbbbbbbbbbb  ${testId}${' '.repeat(padding)}web     eeeeeeeeeeee  <1m  1`,
    );
  });

  it('reports an empty store instead of failing', async () => {
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no replay cache entries in');
    expect(process.exitCode).toBe(0);
  });

  it('counts a file the store cannot read as unreadable, not as an entry', async () => {
    mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
    writeFileSync(path.join(root, CACHE_DIR, `${'c'.repeat(64)}.json`), '{ not json', 'utf8');
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no replay cache entries in');
    expect(written(stderrSpy)).toContain('are not readable trace-1 entries');
  });
});

/** The wrong-page flow: Settings, a page backed out of, then the right one. */
function detouredTrace(): ActionTrace {
  return {
    actions: [
      { name: 'tap', summary: 'tap button "Notifications"', target: { role: 'button', name: 'Notifications' }, at: 'com.example / Settings' },
      { name: 'scroll', summary: 'scroll down', direction: 'down', at: 'com.example / Notifications' },
      { name: 'back', summary: 'go back', at: 'com.example / Notifications' },
      { name: 'tap', summary: 'tap button "Privacy"', target: { role: 'button', name: 'Privacy' }, at: 'com.example / Settings' },
    ],
    executor: { name: 'example-agent' },
    recordedFor: { testId: 'tests/settings.e2e.ts::opens privacy', targetId: 'ios', instructionDigest: 'f'.repeat(64) },
    summary: 'privacy settings are open',
    startPath: 'com.example / Settings',
    endPath: 'com.example / Privacy',
    endAnchors: [{ role: 'heading', name: 'Privacy' }],
  };
}

const DETOUR_LINE = 'actions 1-3 left com.example / Settings for com.example / Notifications and came back with nothing typed, chosen, or set';

describe('e2e cache ls: detours', () => {
  it('marks an entry whose flow takes a detour', async () => {
    await seed([{ keyHash: 'c'.repeat(64), trace: detouredTrace() }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy).trimEnd().split('\n')[1]).toMatch(/ 4 \(detour\)$/);
  });
});

describe('e2e cache show', () => {
  it('prints the entry action by action, with where each ran and the detour marked', async () => {
    await seed([{ keyHash: 'c'.repeat(64), trace: detouredTrace() }]);
    await invoke('cache', 'show', 'cccccc');
    expect(process.exitCode).toBe(0);
    const output = written(stdoutSpy);
    expect(output).toContain(`entry      ${path.join(root, CACHE_DIR, `${'c'.repeat(64)}.json`)}`);
    expect(output).toContain('test       tests/settings.e2e.ts::opens privacy');
    expect(output).toContain('ends on    com.example / Privacy');
    const rows = output.split('\n').filter((line) => /^\d /.test(line));
    expect(rows).toEqual([
      '1  com.example / Settings       tap button "Notifications" (detour)',
      '2  com.example / Notifications  scroll down (detour)',
      '3  com.example / Notifications  go back (detour)',
      '4  com.example / Settings       tap button "Privacy"',
    ]);
    expect(output).toContain('end state: shows heading "Privacy"');
    expect(output).toContain(`detour: ${DETOUR_LINE}`);
  });

  it('takes the path of the entry file too', async () => {
    await seed([{ keyHash: 'c'.repeat(64), trace: detouredTrace() }]);
    await invoke('cache', 'show', path.join(CACHE_DIR, `${'c'.repeat(64)}.json`));
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toContain('tests/settings.e2e.ts::opens privacy');
  });

  it('strips terminal controls the recorded text carries', async () => {
    const recorded = detouredTrace();
    await seed([{ keyHash: 'c'.repeat(64), trace: { ...recorded, summary: 'done\u001b[2J\u0007' } }]);
    await invoke('cache', 'show', 'c'.repeat(12));
    expect(String(stdoutSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''))).not.toContain('\u001b[2J');
  });

  it('fails with exit 2 when no entry, or more than one, matches', async () => {
    await seed([
      { keyHash: `ab${'0'.repeat(62)}`, trace: trace(undefined, 1) },
      { keyHash: `ab${'1'.repeat(62)}`, trace: trace(undefined, 1) },
    ]);
    await invoke('cache', 'show', 'ab');
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('ab matches 2 entries');
    stderrSpy.mockClear();
    await invoke('cache', 'show', 'ff');
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('no replay cache entry ff');
  });
});

describe('e2e cache check', () => {
  it('names every detour and exits 1', async () => {
    await seed([
      { keyHash: 'c'.repeat(64), trace: detouredTrace() },
      { keyHash: 'a'.repeat(64), trace: trace({ testId: 'tests/a.e2e.ts::a', targetId: 'web', instructionDigest: 'd'.repeat(64) }, 2) },
    ]);
    await invoke('cache', 'check');
    expect(process.exitCode).toBe(1);
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(lines).toEqual([
      `cccccccccccc tests/settings.e2e.ts::opens privacy (ios): ${DETOUR_LINE}`,
      '1 of 2 replay cache entries take a detour; e2e cache show <entry> prints its actions',
    ]);
  });

  it('reads an entry recorded before locations by its actions alone', async () => {
    const legacy: ActionTrace = {
      ...trace(undefined, 0),
      actions: [
        { name: 'tap', summary: 'tap button "Help"', target: { role: 'button', name: 'Help' } },
        { name: 'back', summary: 'go back' },
        { name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } },
      ],
    };
    await seed([{ keyHash: 'e'.repeat(64), trace: legacy }]);
    await invoke('cache', 'check');
    expect(process.exitCode).toBe(1);
    expect(written(stdoutSpy)).toContain('eeeeeeeeeeee: actions 1-2 left a screen, only looked around, and went back');
  });

  it('exits 0 when no entry takes a detour, and on an empty store', async () => {
    await invoke('cache', 'check');
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toContain('no detours in 0 replay cache entries');
    stdoutSpy.mockClear();
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(undefined, 3) }]);
    await invoke('cache', 'check');
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toContain('no detours in 1 replay cache entry');
  });
});

describe('e2e cache stats', () => {
  it('prints the directory, the entry count, and the size', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(undefined, 1) },
      { keyHash: 'b'.repeat(64), trace: trace(undefined, 1) },
    ]);
    await invoke('cache', 'stats');
    const output = written(stdoutSpy);
    expect(output).toContain(`directory  ${path.join(root, CACHE_DIR)}`);
    expect(output).toContain('entries    2');
    expect(output).toMatch(/size {7}\d+(\.\d)? (B|KiB)/);
  });

  it('reads the directory --cache-dir or E2E_CACHE_DIR names over cache.dir', async () => {
    await invoke('cache', 'stats', '--cache-dir', 'from-flag');
    expect(written(stdoutSpy)).toContain(`directory  ${path.join(root, 'from-flag')}`);
    stdoutSpy.mockClear();
    vi.stubEnv('E2E_CACHE_DIR', 'from-env');
    try {
      await invoke('cache', 'stats');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(written(stdoutSpy)).toContain(`directory  ${path.join(root, 'from-env')}`);
  });
});

describe('e2e cache clear', () => {
  it('deletes the entries and the directory', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(undefined, 1) },
      { keyHash: 'b'.repeat(64), trace: trace(undefined, 1) },
    ]);
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('cleared 2 file(s)');
    expect(readdirSync(root).toSorted()).toEqual(['e2e.config.ts', 'package.json']);
    expect(process.exitCode).toBe(0);
  });

  it('removes an unreadable entry and a crashed writer\u2019s temporary file', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${'c'.repeat(64)}.json`), 'torn', 'utf8');
    writeFileSync(path.join(directory, `${'d'.repeat(64)}.json.0123456789abcdef.tmp`), '{}', 'utf8');
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('cleared 2 file(s)');
  });

  it('leaves files the runner never wrote, and says so', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'notes.md'), 'keep me', 'utf8');
    await invoke('cache', 'clear');
    expect(written(stderrSpy)).toContain('notes.md');
    expect(readdirSync(directory)).toEqual(['notes.md']);
  });

  it('has nothing to clear when the store was never written', async () => {
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('no replay cache entries to clear');
    expect(process.exitCode).toBe(0);
  });
});

describe('e2e cache configuration', () => {
  it('refuses a custom store it cannot enumerate', async () => {
    writeConfig(
      [
        "const store = { writable: false, read: async () => ({ status: 'miss' }), write: async () => undefined };",
        "export default { targets: [{ name: 'web', platform: 'web' }], cache: { store } };",
        '',
      ].join('\n'),
    );
    await invoke('cache', 'stats');
    expect(written(stderrSpy)).toContain('cache.store replaces the file store');
    expect(process.exitCode).toBe(2);
  });

  it('fails with the config error when the config is missing', async () => {
    rmSync(path.join(root, 'e2e.config.ts'));
    await invoke('cache', 'ls');
    expect(written(stderrSpy)).toContain('config file not found');
    expect(process.exitCode).toBe(2);
  });
});
