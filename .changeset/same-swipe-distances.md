---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`screen.swipe`, `locator.swipe`, and `scrollUntilVisible` take `distance` and `speed`, and a swipe moves the same share of what it scrolls on every engine. `momentum` still works and is deprecated. A screen swipe scrolls the container under the screen's center, and on a device `locator.scrollIntoView()` is supported. [screen.swipe](https://e2e.com/docs/reference/screen#screen-swipe)
