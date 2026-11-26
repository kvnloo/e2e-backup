---
'@e2e-dev/core': patch
'e2e': patch
---

In `e2e mcp`'s `run_code`, a locator from `screen` and one from an engine fixture such as `browser` now combine in `or`, `filter({ has })`, `dragTo`, and `browser.locator(selector, { within })`, instead of failing with `INVALID_LOCATOR`.
