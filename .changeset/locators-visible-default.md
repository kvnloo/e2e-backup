---
'@e2e-dev/core': patch
'e2e': patch
---

The default `visible` option of `getByText`, `getByLabel`, `getByPlaceholder`, `getByDisplayValue`, and `getByTestId` can now be set with a new `locators` config option, at the top level and on each target. With `locators: { visible: true }`, hidden nodes (such as a native screen kept mounted behind the current one) are skipped without `{ visible: true }` on each query. Precedence, from highest:

- `visible` passed to the query
- the target's `locators.visible`
- the config's `locators.visible`
- `false`, the default, so existing suites run as before

The same default is used by `run_code`, `locate`, and the test lines of an `e2e mcp` session. An invalid value is `INVALID_CONFIG`.
