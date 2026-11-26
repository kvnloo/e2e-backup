/**
 * What a running test and its worker can read about themselves: `TestInfo`,
 * `WorkerInfo`, and test annotations. Re-exported from `types.ts`.
 */

/** One annotation attached to a test: a category (`type`) and optional detail (`description`). */
export interface TestAnnotation {
  /** Category or label, e.g. `'issue'`, `'owner'`, `'slow'`. Must be non-blank. */
  readonly type: string;
  /** Optional detail, e.g. an issue URL or explanation. */
  readonly description?: string | undefined;
}

/** Read-only summary of a resolved target, exposed on `WorkerInfo` and `TestInfo`. */
export interface TestTargetInfo {
  /** Target name (`target.name`, defaulting to `platform`). */
  readonly name: string;
  /** Target platform label (`'web'`, `'ios'`, `'android'`, or an engine's own string). */
  readonly platform: string;
  /** Normalized app base URL on the run's port, or `undefined` when the target declares none. */
  readonly url: string | undefined;
  /** App environment label (`'test'`, `'staging'`, or `'production'`). */
  readonly environment: 'test' | 'staging' | 'production';
  /** Resolved `fullyParallel` for this target. */
  readonly fullyParallel: boolean;
}

/** Read-only summary of the resolved configuration for the current run, without secrets or live handles. */
export interface TestConfigInfo {
  /** Stable project identifier. */
  readonly projectId: string;
  /** Absolute project root directory. */
  readonly projectRoot: string;
  /** Absolute output directory (`.e2e` unless `output` or `--output` overrides it). */
  readonly outputDir: string;
  /** Default test attempt timeout in milliseconds. */
  readonly timeout: number;
  /** Engine init and attempt start timeout in milliseconds. */
  readonly launchTimeout: number;
  /** Default engine action timeout in milliseconds. */
  readonly actionTimeout: number;
  /** Default assertion timeout in milliseconds. */
  readonly assertionTimeout: number;
  /** Teardown and cleanup timeout in milliseconds. */
  readonly cleanupTimeout: number;
  /** Default retries per test. */
  readonly retries: number;
  /** Configured parallel worker count for this run. */
  readonly workers: number;
  /** Whether the run was started in headed mode. */
  readonly headed: boolean;
  /** Resolved targets in config order. */
  readonly targets: readonly TestTargetInfo[];
}

/** Information about the running worker, passed to worker-scoped fixtures and `beforeAll` / `afterAll` hooks. */
export interface WorkerInfo {
  /** Monotonic 0-based index of this worker in the run; a replacement worker gets a new index. */
  readonly workerIndex: number;
  /** 0-based parallel slot among live workers (`0` to `workers - 1`); never shared by two workers running at once. */
  readonly parallelIndex: number;
  /** The target this worker is bound to. */
  readonly target: TestTargetInfo;
  /** Read-only summary of the resolved configuration for this run. */
  readonly config: TestConfigInfo;
}

/** One error recorded on a test attempt, as `testInfo.error` and `testInfo.errors` expose it (with secrets redacted). */
export interface TestInfoError {
  /** Error code, e.g. `'ASSERTION_FAILED'`, `'TEST_TIMEOUT'`, `'LOCATOR_NOT_FOUND'`. */
  readonly code: string;
  /** Error message, redacted of configured secrets. */
  readonly message: string;
  /** Stack trace when available, redacted of configured secrets. */
  readonly stack?: string | undefined;
  /** Phase in which the error occurred, when known. */
  readonly phase?: 'launch' | 'beforeEach' | 'body' | 'afterEach' | 'cleanup' | undefined;
}

/** Outcome status of a test attempt on `TestInfo`. */
export type TestInfoStatus = 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

/**
 * Information about the running test attempt, returned by `test.info()` and
 * passed to test bodies, `beforeEach`, `afterEach`, and test-scoped fixtures.
 */
export interface TestInfo extends WorkerInfo {
  /** Stable test id (`<file>::<titles>`). */
  readonly testId: string;
  /** Test title. */
  readonly title: string;
  /** Enclosing describe titles outermost first, followed by the test title. */
  readonly titlePath: readonly string[];
  /** Absolute path of the test file. */
  readonly file: string;
  /** 1-based line number where the test was declared. */
  readonly line: number;
  /** 1-based column number where the test was declared. */
  readonly column: number;
  /** Declared tags: enclosing describe tags outermost first, then the test's own. */
  readonly tags: readonly string[];
  /** Configured agent name this attempt runs with. */
  readonly agent: string;
  /** 0-based retry index: `0` on the first attempt, `1` on the first retry, etc. */
  readonly retry: number;
  /** 0-based repeat index under `--repeat-each`: `0` on the first repeat. */
  readonly repeatEachIndex: number;
  /**
   * Current attempt timeout in milliseconds; reflects changes made by
   * `test.setTimeout()` and `test.slow()`.
   */
  readonly timeout: number;
  /** Elapsed time since the attempt started, in milliseconds. */
  readonly duration: number;
  /**
   * Expected outcome of this attempt: `'failed'` when marked with `{ fail }`
   * or `test.fail()`, otherwise `'passed'`.
   */
  readonly expectedStatus: 'passed' | 'failed';
  /**
   * Outcome of the attempt so far: `undefined` until a failure or verdict is
   * recorded; always set once `afterEach` hooks and fixture teardowns run.
   * Compare against `expectedStatus` when `test.fail()` is used.
   */
  readonly status: TestInfoStatus | undefined;
  /** Primary error recorded on this attempt (secrets redacted), or `undefined` if none. */
  readonly error: TestInfoError | undefined;
  /** All errors recorded on this attempt so far (primary first, then secondary; secrets redacted). */
  readonly errors: readonly TestInfoError[];
  /**
   * Annotations for this test attempt, initialized from `{ annotation }` on
   * enclosing describes and the test. Push entries here to add annotations at
   * runtime; they are redacted and included in the report.
   */
  readonly annotations: TestAnnotation[];
  /** Absolute per-attempt directory for test artifacts and custom files. */
  readonly outputDir: string;
  /**
   * Resolves a path inside `outputDir` for writing test-specific files.
   * Throws `INVALID_ARGUMENT` if the resolved path escapes `outputDir`.
   */
  outputPath(...pathSegments: string[]): string;
}
