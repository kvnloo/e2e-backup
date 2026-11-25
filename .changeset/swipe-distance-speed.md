---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`screen.swipe`, `locator.swipe`, and `scrollUntilVisible` take `distance` (a share of the scroll container, or of a locator's node, on the web and on a device) and `speed` (how long each drag takes on a device). On the web, a swipe is a wheel event, so `speed` doesn't change anything there. Code that builds an engine swipe action needs `distance` and `durationMs`, though older clients that send only `momentum` still work over the engine protocol.
