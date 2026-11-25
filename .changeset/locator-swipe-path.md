---
"@e2e-dev/core": patch
---

`locator.swipe()` takes a path, `{ from, to, duration? }`, with both points relative to the node. On the web, a path is a pointer drag, so it moves a pager that ignores the wheel event a direction swipe sends.
