/**
 * The seam between the scheduler and whatever actually executes work units.
 *
 * The scheduler only ever talks to a `UnitRunner`: it sends work-unit messages
 * and reacts to record messages coming back. Two implementations exist — a
 * child process (`worker/handle.ts`, the default) and an in-process runner
 * (`in-process.ts`, used when the config cannot cross a process boundary).
 * Keeping this interface narrow is what lets one scheduler own all execution.
 */

import type { MainToWorker, WorkerToMain } from './worker/protocol.ts';

export interface UnitRunnerEvents {
  onMessage(message: WorkerToMain): void;
  /**
   * Fires exactly once when the runner reaches end of life, for any reason.
   * `detail` describes the cause for infrastructure error reporting;
   * `signal` is the signal that ended a worker process, when one did.
   */
  onExit(detail: string, signal?: NodeJS.Signals | null): void;
}

/** One worker bound to a single target, executing at most one unit at a time. */
export interface UnitRunner {
  /** Resolves when the runner has exited; never rejects. */
  readonly exit: Promise<void>;
  readonly alive: boolean;
  send(message: MainToWorker): void;
  /** Terminates without waiting for in-flight work to unwind. */
  kill(): void;
}

/** Numeric slots assigned to a worker when the scheduler spawns it. */
export interface WorkerSlots {
  /** 0-based slot among live workers of this target; see `EngineInitInfo.workerSlot`. */
  readonly workerSlot: number;
  /** Monotonic 0-based worker index across the run; incremented for every spawned worker, never reused. */
  readonly workerIndex: number;
  /** 0-based parallel slot among all live workers across targets (`0` to `workers - 1`); reused when a worker exits. */
  readonly parallelIndex: number;
}

/**
 * Starts one worker for a target; run-wide settings are closed over.
 * `slots` carries the target-local `workerSlot`, the run-wide monotonic
 * `workerIndex`, and the run-wide reusable `parallelIndex`.
 */
export type SpawnUnitRunner = (targetName: string, slots: WorkerSlots, events: UnitRunnerEvents) => UnitRunner;
