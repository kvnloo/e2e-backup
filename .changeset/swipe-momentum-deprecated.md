---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`momentum` on a swipe is deprecated in favor of `distance` and `speed`, and will be removed no earlier than April 1, 2027. Using it prints a warning once per worker process. Its distances changed: on the web, `'slow'` is 0.25 (was 0.75) and `'fast'` is 0.65 (was 1.5), on a device locator `'fast'` is 0.65 (was 0.8), and on the desktop `'slow'` is 3 of the app's scroll units (was 2).
