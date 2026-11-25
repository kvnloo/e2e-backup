---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
'@e2e-dev/desktop': patch
---

`app.open(path, { relaunch: true })` starts the app fresh before the path is opened. On a device target with `app.linkBase`, the app is launched from the link. Engine support is declared with `linkRelaunch: true`, and `{ relaunch: true }` arrives as the third argument of `session.openLink`.
