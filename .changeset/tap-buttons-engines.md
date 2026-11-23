---
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

The engine does not declare `tapButtons`, so a `tap` with a `middle` or `right` `button` fails with `UNSUPPORTED_CAPABILITY` before it reaches the device or the app.
