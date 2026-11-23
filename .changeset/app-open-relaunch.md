---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"@e2e-dev/desktop": patch
---

`app.open(path, { relaunch: true })` starts the app fresh before the path opens:

- On a device target with `app.linkBase`, the pinned app is stopped if it's running, so the link launches it. A stopped app isn't an error.
- On a web target, the context is recreated as in `app.restart()`, and the path opens instead of the base URL.

On a device, that launch doesn't pass `app.launchArguments`. On an iOS simulator, an `http(s)` link opens only after the app has launched, so only a custom-scheme link arrives as the launch URL there.

An engine opts in to the device behavior by declaring `linkRelaunch: true` and handling `session.openLink(url, context, { relaunch: true })`. On an engine without it, the call fails with `UNSUPPORTED_CAPABILITY` instead of opening the link in the running app. `@e2e-dev/mobile` declares it and sends one agent-device `open --relaunch` with the link. `linkRelaunch` is added to the engine manifest and the `engine-manifest-1` schema, and `session/openLink` takes an optional `options` param.
