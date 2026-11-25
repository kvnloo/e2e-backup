---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

On the web, `tap` and `click` accept `{ button: 'middle' }` and `{ button: 'right' }`, including with `count` and `position`, like Playwright's `click({ button, clickCount, position })`. Using `count` with `position` now works on any engine that declares the matching pointer action. Engines declare `tapButtons: true` for mouse buttons and the `multiTap` pointer kind for 3 or more taps at a position.
