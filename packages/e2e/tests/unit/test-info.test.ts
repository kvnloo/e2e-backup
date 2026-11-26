/** Unit tests for `test.info()`, `resolveOutputPath`, `sanitizeAnnotations`, annotation registration, and reporter rendering. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { pollLineage } from '@e2e-dev/core/lib/expect/poll-scope';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import {
  currentTestInfo,
  MAX_ANNOTATIONS,
  MAX_ANNOTATION_DESCRIPTION_BYTES,
  MAX_ANNOTATION_TYPE_BYTES,
  resolveOutputPath,
  sanitizeAnnotations,
} from '@e2e-dev/core/lib/internal/test-info';
import { inSuiteHook } from '@e2e-dev/core/lib/internal/test-timeout';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { collectModule, describe as suite, test } from '../../src/collect/registry.ts';
import { renderJunitReport } from '../../src/report/junit.ts';
import { renderCtrfReport } from '../../src/report/ctrf.ts';
import { renderMarkdownReport } from '../../src/report/markdown.ts';
import { renderTracePage } from '../../src/report/failure-text.ts';
import { foldLastRun } from '../../src/report/fold.ts';
import { ListReporter } from '../../src/report/list.ts';
import { outcome } from '../../src/report/outcome.ts';
import type { Report1Document, ReportResult } from '../../src/report/build.ts';
import { toyTestInfo } from '../helpers/suite-hooks.ts';

describe('resolveOutputPath', () => {
  const base = path.resolve('/tmp/e2e-artifacts/test-1/attempt-1');

  it('returns outputDir itself when given no segments', () => {
    expect(resolveOutputPath(base, [])).toBe(base);
  });

  it('joins nested path segments inside outputDir', () => {
    expect(resolveOutputPath(base, ['logs', 'server.txt'])).toBe(path.join(base, 'logs', 'server.txt'));
  });

  it('allows filenames that start with two dots inside outputDir', () => {
    expect(resolveOutputPath(base, ['..hidden.txt'])).toBe(path.join(base, '..hidden.txt'));
  });

  it('rejects parent directory traversal and absolute paths', () => {
    for (const segments of [['..'], ['..', 'secret.txt'], ['sub', '..', '..', 'escape'], ['/etc/passwd']]) {
      expect(() => resolveOutputPath(base, segments)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('stay inside') }),
      );
    }
  });

  it('rejects non-string path segments', () => {
    expect(() => resolveOutputPath(base, [123 as unknown as string])).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('sanitizeAnnotations', () => {
  it('redacts secrets, strips control characters, truncates long values, and drops invalid entries', () => {
    const redact = (text: string): string => text.replaceAll('SUPER_SECRET', '[REDACTED:token]');
    const sanitized = sanitizeAnnotations(
      [
        { type: 'issue', description: 'token SUPER_SECRET\u001b[31m leaked' },
        { type: 'owner' },
        { type: '  ' },
        null,
        'not-an-object',
        { type: 'long-' + 'a'.repeat(400), description: 'b'.repeat(9000) },
        { type: 'non-string-desc', description: 42 },
      ],
      redact,
    );
    expect(sanitized).toHaveLength(4);
    expect(sanitized[0]).toEqual({ type: 'issue', description: 'token [REDACTED:token] leaked' });
    expect(sanitized[1]).toEqual({ type: 'owner' });
    expect(Buffer.byteLength(sanitized[2]!.type, 'utf8')).toBeLessThanOrEqual(MAX_ANNOTATION_TYPE_BYTES);
    expect(Buffer.byteLength(sanitized[2]!.description!, 'utf8')).toBeLessThanOrEqual(MAX_ANNOTATION_DESCRIPTION_BYTES);
    expect(sanitized[3]).toEqual({ type: 'non-string-desc' });
  });

  it('caps the number of annotations at MAX_ANNOTATIONS', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 20 }, (_, i) => ({ type: `a-${i}` }));
    expect(sanitizeAnnotations(many, (t) => t)).toHaveLength(MAX_ANNOTATIONS);
  });
});

describe('currentTestInfo', () => {
  const makeBudget = (): AttemptBudget => new AttemptBudget(new AbortController().signal, new Deadline(10_000));

  it('throws COLLECTION_ERROR outside any running test', () => {
    expect(() => currentTestInfo()).toThrow(expect.objectContaining({ code: 'COLLECTION_ERROR' }));
  });

  it('returns the published testInfo inside a running test attempt', () => {
    const end = new AbortController();
    const info = toyTestInfo();
    publishAttempt(
      {
        attemptId: 'att-1',
        owner: 'suite',
        testKind: 'test',
        assertionTimeout: 5000,
        budget: makeBudget(),
        soft: new SoftFailures(),
        testInfo: info,
      },
      end.signal,
    );
    try {
      expect(currentTestInfo()).toBe(info);
    } finally {
      end.abort();
    }
  });

  it('refuses calls inside a hosted session without testInfo', () => {
    const end = new AbortController();
    publishAttempt(
      {
        attemptId: 'att-host',
        owner: 'host',
        testKind: 'test',
        assertionTimeout: 5000,
        budget: makeBudget(),
        soft: new SoftFailures(),
      },
      end.signal,
    );
    try {
      expect(() => currentTestInfo()).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('hosted session') }),
      );
    } finally {
      end.abort();
    }
  });

  it('refuses calls inside a beforeAll or afterAll hook', async () => {
    await inSuiteHook(
      {
        name: 'a beforeAll hook',
        budget: makeBudget(),
        assertionTimeout: 5000,
        toPass: { timeout: 0, intervals: [100] },
      },
      async () => {
        expect(() => currentTestInfo()).toThrow(
          expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('workerInfo') }),
        );
      },
    );
  });

  it('refuses calls inside a worker-scoped fixture even while a test attempt is published', async () => {
    const end = new AbortController();
    const info = toyTestInfo();
    publishAttempt(
      {
        attemptId: 'att-worker',
        owner: 'suite',
        testKind: 'test',
        assertionTimeout: 5000,
        budget: makeBudget(),
        soft: new SoftFailures(),
        testInfo: info,
      },
      end.signal,
    );
    try {
      const lineage = pollLineage({ outlivesTest: true });
      await lineage.run(async () => {
        expect(() => currentTestInfo()).toThrow(
          expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('worker-scoped fixture') }),
        );
      });
    } finally {
      end.abort();
    }
  });
});

describe('annotation collection and validation', () => {
  it('collects annotations from enclosing describes outermost first, then the test, and redacts static secrets', async () => {
    const reg = await collectModule(
      async () => {
        suite('outer', { annotation: { type: 'area', description: 'auth SECRET_VAL' } }, () => {
          suite('inner', { annotation: [{ type: 'team', description: 'core' }] }, () => {
            test(
              'signs in',
              { annotation: [{ type: 'issue', description: 'https://example.com/1' }, { type: 'smoke' }] },
              async () => {},
            );
          });
        });
      },
      undefined,
      (text) => text.replaceAll('SECRET_VAL', '[REDACTED]'),
    );
    expect(reg.tests[0]!.annotations).toEqual([
      { type: 'area', description: 'auth [REDACTED]' },
      { type: 'team', description: 'core' },
      { type: 'issue', description: 'https://example.com/1' },
      { type: 'smoke' },
    ]);
  });

  it('rejects invalid annotation shapes at collection', async () => {
    await expect(
      collectModule(async () => {
        test('bad type', { annotation: { type: '   ' } }, async () => {});
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'COLLECTION_ERROR' }));

    await expect(
      collectModule(async () => {
        test('unknown key', { annotation: { type: 'ok', extra: 1 } as never }, async () => {});
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'COLLECTION_ERROR' }));

    await expect(
      collectModule(async () => {
        test('bad description', { annotation: { type: 'ok', description: 123 as never } }, async () => {});
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'COLLECTION_ERROR' }));
  });
});

describe('reporter rendering of annotations', () => {
  function sampleReport(): Report1Document {
    const result: ReportResult = {
      id: 'a'.repeat(64),
      testId: 'tests/a.e2e.ts::annotated',
      kind: 'test',
      declarationIndex: 0,
      titlePath: ['annotated'],
      file: 'tests/a.e2e.ts',
      source: { file: 'tests/a.e2e.ts', line: 3, column: 1 },
      targetId: 'web',
      platform: 'web',
      agent: 'default',
      repeat: 0,
      tags: ['smoke'],
      annotations: [
        { type: 'issue', description: 'https://example.com/issues/42?a=1&b=2' },
        { type: 'owner' },
      ],
      selected: true,
      status: 'passed',
      attempts: [
        {
          id: '018f0f5c-7b2a-7abc-8abc-1123456789ab',
          index: 0,
          status: 'passed',
          startedAt: '2026-11-24T12:00:00.000Z',
          durationMs: 250,
          steps: [],
          artifacts: [],
          secondaryErrors: [],
          cleanup: 'complete',
          annotations: [
            { type: 'issue', description: 'https://example.com/issues/42?a=1&b=2' },
            { type: 'owner' },
          ],
        },
      ],
    };
    return {
      schemaVersion: 'report-1',
      run: {
        id: '018f0f5c-7b2a-7abc-8abc-000000000000',
        specVersion: '0.1',
        runner: { name: 'e2e', version: '0.25.0' },
        status: 'passed',
        exitCode: 0,
        startedAt: '2026-11-24T12:00:00.000Z',
        finishedAt: '2026-11-24T12:00:01.000Z',
        durationMs: 1000,
        project: { id: 'demo', configDigest: '0'.repeat(64) },
        environment: { ci: false, trustNoticeShown: false, os: 'darwin 24.0', arch: 'arm64', runtime: 'node v24.0.0' },
        targets: [],
        serialGroups: [],
        results: [result],
        errors: [],
        summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 },
        limits: { maxAgentContextBytes: 16384, maxLedgerBytes: 16384, maxObservationBytes: 262144, maxEventsPerStep: 200, maxModelTokensPerCall: 64000 },
        usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
      },
    };
  }

  it('emits JUnit <properties> with XML-escaped annotation values', () => {
    const xml = renderJunitReport(sampleReport());
    expect(xml).toContain('<properties>');
    expect(xml).toContain('<property name="issue" value="https://example.com/issues/42?a=1&amp;b=2"/>');
    expect(xml).toContain('<property name="owner" value=""/>');
  });

  it('includes annotations in CTRF extra annotations', () => {
    const parsed = JSON.parse(renderCtrfReport(sampleReport())) as {
      results: { tests: { extra?: { 'e2e-inc.e2e'?: { annotations?: unknown[] } } }[] };
    };
    expect(parsed.results.tests[0]!.extra?.['e2e-inc.e2e']?.annotations).toEqual([
      { type: 'issue', description: 'https://example.com/issues/42?a=1&b=2' },
      { type: 'owner' },
    ]);
  });

  it('renders annotations in markdown summary and trace.md', () => {
    const report = sampleReport();
    const md = renderMarkdownReport(report);
    expect(md).toContain('issue: `https://example.com/issues/42?a=1&b=2`; owner');
    const result = report.run.results[0]!;
    const trace = renderTracePage(report, result, outcome(result, new Map()));
    expect(trace).toContain('Annotations: `issue` `https://example.com/issues/42?a=1&b=2` · `owner`');
  });

  it('prints annotation glance lines in the list reporter', () => {
    const chunks: string[] = [];
    const reporter = new ListReporter(
      { write: (line) => chunks.push(line) },
      { live: false, colors: false },
    );
    reporter.handle({
      type: 'test-finished',
      result: {
        test: {
          kind: 'test',
          title: 'annotated test',
          titlePath: ['annotated test'],
          declarationIndex: 0,
          sessions: [],
          tags: [],
          annotations: [{ type: 'issue', description: 'https://example.com/1' }],
          source: { file: 'tests/a.e2e.ts', line: 1, column: 1 },
          file: 'tests/a.e2e.ts',
          id: 'tests/a.e2e.ts::annotated%20test',
          serialId: undefined,
        },
        target: { name: 'web', platform: 'web' },
        agent: 'default',
        repeat: 0,
        status: 'passed',
        selected: true,
        attempts: [
          {
            id: '018f0f5c-7b2a-7abc-8abc-1123456789ab',
            index: 0,
            status: 'passed',
            startedAt: '2026-11-24T12:00:00.000Z',
            durationMs: 120,
            steps: [],
            artifacts: [],
            secondaryErrors: [],
            cleanup: 'complete',
            annotations: [
              { type: 'issue', description: 'https://example.com/1' },
              { type: 'smoke' },
            ],
          },
        ],
      },
    });
    const output = chunks.join('');
    expect(output).toContain('[issue] https://example.com/1');
    expect(output).toContain('[smoke]');
  });

  it('preserves annotations across foldLastRun (both carried passes and rerun results)', () => {
    const previous = sampleReport();
    const rerun = sampleReport();
    const carriedResult: ReportResult = {
      ...previous.run.results[0]!,
      id: 'b'.repeat(64),
      testId: 'tests/b.e2e.ts::carried',
      titlePath: ['carried'],
      annotations: [{ type: 'carried', description: 'from-first-run' }],
    };
    const rerunResult: ReportResult = {
      ...rerun.run.results[0]!,
      annotations: [{ type: 'rerun', description: 'updated' }],
    };
    const prevDoc: Report1Document = {
      ...previous,
      run: { ...previous.run, results: [previous.run.results[0]!, carriedResult] },
    };
    const rerunDoc: Report1Document = {
      ...rerun,
      run: { ...rerun.run, results: [rerunResult] },
    };
    const folded = foldLastRun(rerunDoc, prevDoc);
    expect(folded.run.results.find((r) => r.id === rerunResult.id)?.annotations).toEqual([
      { type: 'rerun', description: 'updated' },
    ]);
    expect(folded.run.results.find((r) => r.id === carriedResult.id)?.annotations).toEqual([
      { type: 'carried', description: 'from-first-run' },
    ]);
  });
});
