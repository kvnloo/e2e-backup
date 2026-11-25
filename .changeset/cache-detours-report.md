---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/html-reporter': patch
---

A replay cache recording now keeps the screen each action ran on, and a step whose recording leaves a screen and comes back to it with nothing typed, chosen, or set on the way reports it as `step.cache.detour`, for example `actions 1-3 left /settings for /settings/notifications and came back with nothing typed, chosen, or set`. That is the shape of an agent that opened the wrong page, scrolled, and backed out before it took the right one: the step passes, and every replay repeats the wrong turn. The trace page and the HTML report show the detour, and the run summary counts these steps as `detoured`. A detour changes nothing about how a step replays or records. Entries recorded by an earlier version have no screens and are read by their actions alone: a tap or a navigate, then only scrolls or hovers, then `back`. Recorded entries keep their keys, so nothing records again.
