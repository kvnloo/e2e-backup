---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/mobile': patch
---

`app.open(path, { relaunch: true })` starts the app fresh before it opens the path. On a device target with `app.linkBase`, the app launches from the link. [app.open](https://e2e.com/docs/reference/app#open)
