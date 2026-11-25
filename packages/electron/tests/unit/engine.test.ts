import { describe, expect, it } from 'vitest';
import { electron } from '../../src/engine.ts';
import { resolveOptions } from '../../src/options.ts';

describe('electron()', () => {
  it('declares the capabilities of a Chromium window driven over the DevTools protocol', () => {
    const engine = electron();
    expect(engine.name).toBe('electron');
    expect(engine.platform).toBe('electron');
    expect([...engine.capabilities]).toEqual(expect.arrayContaining(['observation', 'actions', 'location', 'pointer', 'keyboard', 'artifacts', 'electron']));
    expect(engine.actions).toContain('setInputFiles');
    expect(engine.actions).not.toContain('setInputFilePayloads');
    expect(engine.session?.restart).toBeTypeOf('function');
    expect(engine.session?.open).toBeUndefined();
  });

  it('needs app.appPath unless a packaged app names its own', () => {
    const info = { targetName: 'desktop' };
    expect(() => electron().validateApp?.({}, info)).toThrow(/needs app\.appPath/);
    expect(() => electron().validateApp?.({ appPath: '.' }, info)).not.toThrow();
    expect(() => electron({ executablePath: 'dist/My App' }).validateApp?.({}, info)).not.toThrow();
  });

  it('refuses app fields an Electron app has no use for', () => {
    const info = { targetName: 'desktop' };
    expect(() => electron().validateApp?.({ appPath: '.', url: 'http://localhost:3000' }, info)).toThrow(/loads its own pages/);
    expect(() => electron().validateApp?.({ bundleId: 'com.example.app' }, info)).toThrow(/app\.bundleId/);
    expect(() => electron().validateApp?.({ appPath: '.', permissions: { camera: 'granted' } } as never, info)).toThrow(/app\.permissions/);
  });
});

describe('resolveOptions', () => {
  it('applies the defaults', () => {
    expect(resolveOptions(undefined)).toEqual({ args: [], env: {}, launchTimeoutMs: 30_000, testIdAttribute: 'data-testid', settleMs: 100 });
    expect(resolveOptions({ settle: false }).settleMs).toBe(0);
  });

  it('refuses unknown keys and values of the wrong shape at config load', () => {
    expect(() => resolveOptions({ headless: true } as never)).toThrow(/headless/);
    expect(() => resolveOptions({ args: '--disable-gpu' } as never)).toThrow(/array of strings/);
    expect(() => resolveOptions({ args: ['--user-data-dir=/tmp/x'] })).toThrow(/--user-data-dir/);
    expect(() => resolveOptions({ env: { A: 1 } } as never)).toThrow(/string value/);
    expect(() => resolveOptions({ launchTimeout: 0 })).toThrow(/launchTimeout/);
    expect(() => resolveOptions({ testIdAttribute: 'data test' })).toThrow(/testIdAttribute/);
    expect(() => resolveOptions(null as never)).toThrow(/must be an object/);
  });
});
