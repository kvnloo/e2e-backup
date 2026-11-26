---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/html-reporter': patch
---

Add `test.info()` and the `testInfo` / `workerInfo` parameters to tests, hooks, and fixtures, along with `TEST_WORKER_INDEX` and `TEST_PARALLEL_INDEX` environment variables and test annotations (`{ annotation }` and `testInfo.annotations`).

- Tests, `test.setup`, `test.each`, `test.for`, `beforeEach`, `afterEach`, and test-scoped fixtures receive `TestInfo` (and can call `test.info()`): `testId`, `title`, `titlePath`, `file`, `line`, `column`, `tags`, `agent`, `target`, `config`, `retry`, `repeatEachIndex`, `workerIndex`, `parallelIndex`, `timeout`, `duration`, `expectedStatus`, `status`, `error`, `errors`, `annotations`, `outputDir`, and `outputPath(...segments)`.
- `beforeAll`, `afterAll`, and worker-scoped fixtures receive `WorkerInfo` (`workerIndex`, `parallelIndex`, `target`, `config`).
- `status`, `expectedStatus`, `error`, and `errors` are populated before `afterEach` hooks and fixture teardowns run, with secrets redacted.
- Static `{ annotation }` options on `describe`, `test`, and `test.setup`, plus runtime entries pushed to `testInfo.annotations`, are redacted and included in `report.json`, JUnit `<properties>`, CTRF, Markdown, `trace.md`, the HTML report, and the list reporter.
