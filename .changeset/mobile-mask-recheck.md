---
'@e2e-dev/mobile': patch
---

Read the screen again after a device screenshot and withhold the image when a secure field moved, appeared, or went away between the read and the capture, or the screen changed size. The masks came from the read before the screenshot, so a scroll, keyboard, or screen change in between could leave a password field visible in an image counted as masked. An observation goes without pixels; `app.screenshot()` tries once more and then fails with `POLICY_DENIED`. When the read after the capture fails, an observation goes without pixels and `app.screenshot()` fails with the device's error.
