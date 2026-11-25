---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

On a device, `locator.scrollIntoView()` is now supported and drags nodes cut off at their scroll container's edge toward the middle. After scrolling, `scrollUntilVisible` brings the found node into view. On a device, it also drags nodes that land far from the middle toward the center when content is hidden on that side.
