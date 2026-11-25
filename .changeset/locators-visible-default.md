---
'@e2e-dev/core': patch
'e2e': patch
---

Set `locators: { visible: true }` in the config or on a target to skip hidden nodes by default in `getByText`, `getByLabel`, `getByPlaceholder`, `getByDisplayValue`, and `getByTestId`. Passing `visible` to a query overrides the default. `getByRole` isn't affected.
