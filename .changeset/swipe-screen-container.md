---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

On the web and on a device, `screen.swipe` and `screen.scrollUntilVisible` scroll the container under the screen's center. On web, the pointer moves there first, and a `scrollUntilVisible` step is now 0.65 of that container (down from 0.75 of the viewport). The agent's `scroll` moves half the container, or 5 scroll units on desktop (up from 2).
