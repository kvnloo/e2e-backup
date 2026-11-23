---
"@e2e-dev/core": minor
"@e2e-dev/web": minor
"@e2e-dev/mobile": minor
---

**Breaking:** a swipe with a direction now moves the same share of the node, or of the viewport on `screen`, on the web and on a device: `slow` 0.25, `none` 0.5, `fast` 0.8 along the swipe's axis. The shares are `SWIPE_SHARE`, exported from `@e2e-dev/core/engine` for engines to read. On the web, `slow` and `fast` scrolled 0.75 and 1.5 before, so `scrollUntilVisible` now takes shorter steps there. On a device, `screen.swipe({ direction })` used agent-device's own distance of about 0.6 for every momentum, and now follows the momentum, so `screen.scrollUntilVisible` also takes shorter steps there unless given `momentum: 'none'` or `'fast'`. The agent's `scroll` verb, and `scroll_to({ text })` while it pages, now swipe with `fast`, so each swipe moves 0.8 of the list or screen: about the 0.75 they moved on the web, more than the 0.25 of a device list and the about 0.6 of a device screen.
