---
'@e2e-dev/core': patch
'e2e': patch
---

With `locators: { visible: true }` in the config or on a target, hidden nodes are skipped by default in `getByText`, `getByLabel`, `getByPlaceholder`, `getByDisplayValue`, and `getByTestId`. Passing `visible` to a query overrides the default. `getByRole` isn't affected.
