---
'@e2e-dev/mobile': patch
---

Fixed Android coordinates not lining up across screen densities. Element boxes from `boundingBox()`, `device.viewport()`, `screen.tapAt()`, `screen.swipe()`, and the agent's `swipe` tool were in physical pixels on Android, while iOS and the docs use density-independent pixels (dp). So a point that landed on an element at one density missed it at another. Values on Android are now in dp, like iOS points.

A hard-coded Android point written in physical pixels needs to be divided by the device's density, or replaced with a percentage. Android agent steps recorded with a bare point tap don't replay anymore (`REPLAY_STALE` with `--strict-cache`). Record them again with a `read-write` run.

Before a point action, a capture is taken to read the density if the screen hasn't been captured yet. Coordinates stay in physical pixels when agent-device doesn't report a density (an older Android helper). Coordinates on `device.unstable_raw` are always in physical pixels.
