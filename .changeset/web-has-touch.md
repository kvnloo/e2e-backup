---
"@e2e-dev/core": patch
"@e2e-dev/web": patch
---

Add `web({ hasTouch: true })` to emulate a touchscreen on a web target. A single `tap()` then sends `touchstart` and `touchend` before the browser's `click`, so a test reaches the app's touch handlers. `click()` stays a mouse click (as in Playwright), and engines get it as a `tap` with `click: true`.
