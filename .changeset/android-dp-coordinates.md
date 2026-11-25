---
'@e2e-dev/mobile': patch
---

Fixed Android coordinates being in physical pixels. Element boxes, `device.viewport()`, and points passed to taps and swipes are now in density-independent pixels (dp), like iOS points, so a hard-coded Android point needs dividing by the device's density (or a percentage), and stored Android screenshots need `--update-snapshots`.
