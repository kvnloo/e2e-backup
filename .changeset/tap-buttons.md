---
'@e2e-dev/core': patch
'e2e': patch
---

`tap` and `click` take `{ button: 'middle' }` or `{ button: 'right' }`, the mouse button that clicks, as Playwright's `click({ button })` does, so a test of middle-click behavior on a link no longer dispatches `auxclick` in the page. `left` stays the default. An engine opts in with `tapButtons: true`; on one that does not (the mobile engine), a `middle` or `right` tap fails with `UNSUPPORTED_CAPABILITY` before the node resolves instead of clicking with the primary button. Any other button, or a `middle` or `right` button beside `position`, is `INVALID_ARGUMENT`.
