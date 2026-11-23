---
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

The engine doesn't declare `tapButtons`, so a middle or right `button` on `tap` fails with `UNSUPPORTED_CAPABILITY` before it reaches the app.
