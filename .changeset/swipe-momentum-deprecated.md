---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`momentum` on swipes is deprecated in favor of `distance` and `speed`. Using it prints a warning once per worker process, and it will be removed no earlier than April 1, 2027. Its distances changed: on web, `'slow'` is 0.25 (was 0.75) and `'fast'` is 0.65 (was 1.5), on mobile locators, `'fast'` is 0.65 (was 0.8), and on desktop, `'slow'` is 3 app scroll units (was 2).
