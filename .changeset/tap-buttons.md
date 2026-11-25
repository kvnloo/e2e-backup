---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

On the web, `tap` and `click` take `{ button: 'middle' }` and `{ button: 'right' }`, and the button combines with `count` and `position` like Playwright's `click({ button, clickCount, position })`. `count` combines with `position` on any engine that lists the matching pointer action, where it used to fail. An engine opts in to buttons with `tapButtons: true`, and to 3 or more taps at a position with the new `multiTap` pointer kind.
