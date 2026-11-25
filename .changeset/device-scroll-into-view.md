---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

On a device, `locator.scrollIntoView()` is supported and drags a node cut off at its scroll container's edge toward the middle. After a step, `scrollUntilVisible` brings the found node into view. On a device, a node that lands far from its container's middle is also dragged there when the container has content hidden on that side.
