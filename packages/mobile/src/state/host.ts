/** The host side of a state snapshot: which app on which device, and the commands that reach it. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { EngineError } from '@e2e-dev/core/engine';
import type { MobilePlatform } from '../options.ts';
import { invalidState, unsupported } from '../support.ts';

/** The app on the device a snapshot is taken from or put onto. */
export interface StateTarget {
  readonly platform: MobilePlatform;
  /** A simulator UDID or an emulator serial. */
  readonly deviceId: string;
  /** Bundle id or package. */
  readonly app: string;
}

/** One platform's snapshot: `capture` returns the JSON `restore` takes back, from this device or another. */
export interface PlatformState {
  capture(target: StateTarget, signal: AbortSignal): Promise<unknown>;
  restore(target: StateTarget, data: unknown, signal: AbortSignal): Promise<void>;
}

/** A snapshot travels as JSON inside the session envelope, so a data directory past this is refused instead of read into memory. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface RunOptions {
  readonly signal: AbortSignal;
  readonly stdin?: Buffer | string;
  /** A non-zero exit is an answer, not a failure: the output says which. */
  readonly allowFailure?: boolean;
}

export function failure(text: string, cause?: unknown): EngineError {
  return new EngineError('ENGINE_FAILURE', text, { retryable: false, cause });
}

/**
 * Runs one host command and returns its stdout. A failure names the step and
 * the exit code only: stderr of a restore can quote the statement or the
 * path it choked on, and a snapshot's contents must not reach an error.
 */
export function run(step: string, file: string, args: readonly string[], options: RunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { signal: options.signal, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(unsupported(`${step}: the app's data is larger than ${String(MAX_OUTPUT_BYTES / 1024 / 1024)} MB, too large to save as a session`));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (cause) => {
      reject(options.signal.aborted ? options.signal.reason : failure(`${step}: could not run ${path.basename(file)}`, cause));
    });
    child.on('close', (code) => {
      if (code === 0 || (code !== null && options.allowFailure === true)) resolve(Buffer.concat(chunks));
      else reject(failure(`${step}: ${path.basename(file)} exited with ${String(code)}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  });
}

const deflate = promisify(gzip);
const inflate = promisify(gunzip);

/** A tar of the app's data as a snapshot carries it: gzipped, base64. */
export async function packFiles(archive: Buffer): Promise<string> {
  return (await deflate(archive)).toString('base64');
}

export async function unpackFiles(files: string): Promise<Buffer> {
  try {
    return await inflate(Buffer.from(files, 'base64'), { maxOutputLength: MAX_OUTPUT_BYTES });
  } catch {
    throw invalidState('the saved session holds app data this engine cannot read');
  }
}
