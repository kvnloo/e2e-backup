/**
 * App state capture and restore for a local simulator or emulator: what
 * `session.save()` and the `session` option ride on a `mobile()` target.
 *
 * A snapshot is the app's data directory plus the rows the app owns in the
 * device's secure store (the simulator keychain, the emulator's Keystore
 * database), since most apps keep their sign-in there and not in their files.
 * Both stores are read and written from the host, which is why only a local
 * simulator or emulator qualifies: a hosted or physical device exposes
 * neither.
 */

import type { EngineState } from '@e2e-dev/core/engine';
import { z } from 'zod';
import type { MobilePlatform } from '../options.ts';
import { invalidState, unsupported } from '../support.ts';
import { android } from './android.ts';
import type { PlatformState, StateTarget } from './host.ts';
import { ios } from './ios.ts';

export type { StateTarget } from './host.ts';

export const STATE_FORMAT = 'mobile-app-state';
const STATE_VERSION = 1;

const PLATFORMS: Readonly<Record<MobilePlatform, PlatformState>> = { ios, android };

/** The id reaches device paths and statements, so a display name the app was opened by does not qualify. */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What every platform's snapshot says about itself. */
const Origin = z.object({ platform: z.enum(['ios', 'android']), app: z.string().regex(APP_ID) });

export async function captureAppState(target: StateTarget, signal: AbortSignal): Promise<EngineState> {
  assertTarget(target);
  return { format: STATE_FORMAT, version: STATE_VERSION, data: await PLATFORMS[target.platform].capture(target, signal) };
}

export async function restoreAppState(target: StateTarget, state: EngineState, signal: AbortSignal): Promise<void> {
  assertTarget(target);
  if (state.format !== STATE_FORMAT || state.version !== STATE_VERSION) {
    throw invalidState(`unsupported state format ${state.format}@${String(state.version)}`);
  }
  const origin = Origin.safeParse(state.data);
  if (!origin.success) throw invalidState('the saved session is not a mobile app state');
  if (origin.data.platform !== target.platform || origin.data.app !== target.app) {
    throw invalidState(`the session was saved for ${origin.data.app} on ${origin.data.platform}, not for ${target.app} on ${target.platform}`);
  }
  await PLATFORMS[target.platform].restore(target, state.data, signal);
}

function assertTarget(target: StateTarget): void {
  if (!APP_ID.test(target.app)) {
    throw unsupported(`saving a session needs the app's bundle id or package in app.bundleId, got ${JSON.stringify(target.app)}`);
  }
}
