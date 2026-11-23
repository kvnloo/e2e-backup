---
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

`tapButtons` isn't declared, so `tap` with a middle or right `button` fails with `UNSUPPORTED_CAPABILITY` before anything reaches the app.
