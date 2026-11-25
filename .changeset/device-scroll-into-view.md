---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

On a device, `locator.scrollIntoView()` is supported, and drags a node cut off at its scroll container's edge toward the middle. After a step, `scrollUntilVisible` brings the found node into view, and on a device it also drags a node far from the middle of its container toward the middle.
