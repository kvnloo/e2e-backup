---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`screen.swipe`, `locator.swipe`, and `scrollUntilVisible` take `distance` and `speed`, with the same meaning on the web and on a device. `momentum` is deprecated, and on the web it scrolls shorter distances than before. On a device, `locator.scrollIntoView()` is supported.
