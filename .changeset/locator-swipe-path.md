---
"@e2e-dev/core": patch
---

`locator.swipe()` takes a path, `{ from, to, duration? }`, with both points relative to the node. On the web, a path runs as a pointer drag, so pagers that ignore wheel events from direction swipes still move.
