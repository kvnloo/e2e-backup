---
'@e2e-dev/mobile': minor
---

**Breaking:** on Android, element boxes, `device.viewport()`, and the points passed to taps and swipes are now in density-independent pixels (dp), like iOS points, instead of physical pixels. Convert a hard-coded Android point to dp or use a percentage, run `--update-snapshots` for stored Android `toHaveScreenshot` baselines, and re-record Android agent steps that tap or swipe at a point.
