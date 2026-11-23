---
'@e2e-dev/core': patch
'e2e': patch
---

`tap` and `click` accept `{ button: 'middle' }` and `{ button: 'right' }`, like Playwright's `click({ button })`. A test of a middle click on a link doesn't need to dispatch `auxclick` in the page anymore. The default is still `left`.

Engine support is declared with `tapButtons: true`. A middle or right tap fails with `UNSUPPORTED_CAPABILITY` when `tapButtons` isn't declared (as on the mobile engine). It fails before the node resolves, instead of clicking with the primary button.

`INVALID_ARGUMENT` is thrown for any other button, and for a middle or right button with `position`.
