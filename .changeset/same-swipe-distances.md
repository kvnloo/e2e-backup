---
"@e2e-dev/core": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

A swipe with a direction now moves the same share of the node, or of the viewport on `screen`, on the web and on a device: `slow` 0.25, `none` 0.5, `fast` 0.8 along the swipe's axis. The shares are `SWIPE_SHARE`, exported from `@e2e-dev/core/engine` for engines to read. On the web, `slow` and `fast` scrolled 0.75 and 1.5 before, so `scrollUntilVisible` now takes shorter steps there. On a device, `screen.swipe({ direction })` used agent-device's own distance of about 0.6 for every momentum, and now follows the momentum. The agent's `scroll` and `scroll_to` verbs now swipe with `fast`, so each moves 0.8 of the list or screen: about the 0.75 they moved on the web, more than the 0.25 of a device list and the 0.65 of a device screen.
