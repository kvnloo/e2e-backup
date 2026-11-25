---
'@e2e-dev/core': patch
'e2e': patch
---

With `locators: { visible: true }` in the config or on a target, hidden nodes are skipped by `getByText`, `getByLabel`, `getByPlaceholder`, `getByDisplayValue`, and `getByTestId` by default. Passing `visible` to a query overrides that. `getByRole` doesn't use this default.
