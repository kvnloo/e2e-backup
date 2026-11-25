---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

On the web and on a device, `screen.swipe` and `screen.scrollUntilVisible` scroll the container under the screen's center. On the web, they move the pointer there first, and a `scrollUntilVisible` step is 0.65 of that container, down from 0.75 of the viewport. The agent's `scroll` moves half the container, and on the desktop it sends 5 wheel notches, up from 2.
