---
'@e2e-dev/core': patch
'e2e': patch
---

With `locators: { visible: true }` in the config or on a target, hidden nodes are skipped by `getByText`, `getByLabel`, `getByPlaceholder`, `getByDisplayValue`, and `getByTestId` without `{ visible: true }` on each query. A `visible` passed to a query takes precedence, and `getByRole` doesn't use the default.
