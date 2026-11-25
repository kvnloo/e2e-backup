---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`screen.swipe`, `locator.swipe`, and `scrollUntilVisible` now take `distance` (a share of the scroll container or the locator's node on web and mobile) and `speed` (how fast each drag runs on mobile). On web, a swipe is a wheel event, so `speed` doesn't change anything. Engine swipe actions now need `distance` and `durationMs`, and older clients sending only `momentum` still work over the engine protocol.
