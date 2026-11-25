---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

A swipe's `momentum` is deprecated in favor of `distance` and `speed`. It prints a warning once per worker process and will be removed no earlier than April 1, 2027. Its values scroll different distances: on the web, `'slow'` 0.25 (was 0.75) and `'fast'` 0.65 (was 1.5), on a device locator `'fast'` 0.65 (was 0.8), and on the desktop `'slow'` 3 wheel notches (was 2) and `'fast'` 2 (was 10).
