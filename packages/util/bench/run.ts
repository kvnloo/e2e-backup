/**
 * Times every case in `cases.ts` both ways, each side in its own process so
 * one side's garbage is not collected on the other's clock, and prints
 * markdown tables:
 *
 * - wall time per call, one call at a time;
 * - JavaScript-thread time per call, from `performance.eventLoopUtilization`:
 *   the time the event loop could not run anything else, garbage collection
 *   included;
 * - the longest event-loop stall during the run (`monitorEventLoopDelay`);
 * - wall time for 8 calls at once, as parallel observations or polls ask;
 * - peak memory for 120 model downscales of a 2560x1440 screenshot in a row,
 *   with and without yielding to the event loop between them.
 *
 * Usage: `pnpm --filter @e2e-dev/util bench [--runs 30] [--case <substring>]`.
 * Needs a release build of the addon (`pnpm --filter @e2e-dev/util build:native`).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { processPng } from '../src/index.ts';
import * as reference from '../tests/reference.ts';
import { cases } from './cases.ts';
import { screenshots } from '../tests/screenshots.ts';

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: { runs: { type: 'string' }, case: { type: 'string' }, child: { type: 'string' }, side: { type: 'string' }, memory: { type: 'string' } },
});
const RUNS = Number(values.runs ?? 30);
const WARMUP = 3;
const BURST = 8;
const MEMORY_CALLS = 120;

interface Measure {
  readonly median: number;
  readonly p95: number;
  readonly thread: number;
  readonly stall: number;
  readonly burst: number;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Lets timers and I/O run, as a real step does between captures. */
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function measure(run: () => unknown): Promise<Measure> {
  for (let at = 0; at < WARMUP; at += 1) await run();
  const times: number[] = [];
  const delay = monitorEventLoopDelay({ resolution: 1 });
  await yieldLoop();
  delay.enable();
  const before = performance.eventLoopUtilization();
  for (let at = 0; at < RUNS; at += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
    await yieldLoop();
  }
  const used = performance.eventLoopUtilization(before);
  delay.disable();
  const burstStart = performance.now();
  await Promise.all(Array.from({ length: BURST }, () => run()));
  const burst = performance.now() - burstStart;
  times.sort((a, b) => a - b);
  return { median: quantile(times, 0.5), p95: quantile(times, 0.95), thread: used.active / RUNS, stall: delay.max / 1e6, burst };
}

/** Peak RSS in MB after `MEMORY_CALLS` model downscales; `yields` lets finalizers run between calls. */
async function memory(side: 'old' | 'native', yields: boolean): Promise<number> {
  const bytes = (await screenshots()).find((shot) => shot.name === 'desktop-2560x1440')!.bytes;
  for (let at = 0; at < MEMORY_CALLS; at += 1) {
    if (side === 'old') reference.encodePng(reference.resampleImage(reference.decodePng(bytes), 768, 432));
    else await processPng(bytes, { resize: { width: 768, height: 432 }, output: 'png' });
    if (yields) await yieldLoop();
  }
  return process.resourceUsage().maxRSS / 1024;
}

const fixed = (value: number): string => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));

/** Runs this script as a child for one measurement and parses its JSON answer. */
function child(args: readonly string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [import.meta.filename, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
}

if (values.child !== undefined) {
  const entry = (await cases())[Number(values.child)]!;
  process.stdout.write(JSON.stringify(await measure(values.side === 'old' ? entry.old : entry.native)));
} else if (values.memory !== undefined) {
  process.stdout.write(JSON.stringify(await memory(values.side === 'old' ? 'old' : 'native', values.memory === 'yield')));
} else {
  await screenshots();
  const all = await cases();
  const rows: string[] = [];
  for (const [index, entry] of all.entries()) {
    if (values.case !== undefined && !entry.name.includes(values.case)) continue;
    const old = child(['--child', String(index), '--side', 'old', '--runs', String(RUNS)]) as Measure;
    const native = child(['--child', String(index), '--side', 'native', '--runs', String(RUNS)]) as Measure;
    rows.push(
      `| ${entry.name} | ${fixed(old.median)} | ${fixed(native.median)} | ${(old.median / native.median).toFixed(1)}x | ${fixed(old.thread)} | ${fixed(native.thread)} | ${fixed(old.stall)} | ${fixed(native.stall)} | ${fixed(old.burst)} | ${fixed(native.burst)} |`,
    );
    process.stderr.write(`${entry.name}: done\n`);
  }
  const memoryRows = (['tight', 'yield'] as const).map((mode) => {
    const old = child(['--memory', mode, '--side', 'old']) as number;
    const native = child(['--memory', mode, '--side', 'native']) as number;
    return `| ${MEMORY_CALLS} model downscales of 2560x1440, ${mode === 'tight' ? 'no yield between calls (old) / awaited (native)' : 'yielding to the event loop between calls'} | ${old.toFixed(0)} | ${native.toFixed(0)} |`;
  });
  const addon = path.join(import.meta.dirname, '..', `util.${process.platform}-${process.arch}.node`);
  process.stdout.write(
    [
      `Node ${process.version}, ${process.platform}-${process.arch}, ${RUNS} runs per case after ${WARMUP} warm-up, each side in its own process. Times in ms. "JS thread" is event-loop busy time per call (GC included), "stall" the longest event-loop delay during the run, "burst" the wall time of ${BURST} calls started at once.`,
      '',
      '| case | old median | native median | speedup | old JS thread | native JS thread | old stall | native stall | old burst of 8 | native burst of 8 |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows,
      '',
      '| peak RSS, MB | old | native |',
      '| --- | ---: | ---: |',
      ...memoryRows,
      '',
      `Addon size: ${(readFileSync(addon).byteLength / 1024).toFixed(0)} KB (${path.basename(addon)}).`,
      '',
    ].join('\n'),
  );
}
