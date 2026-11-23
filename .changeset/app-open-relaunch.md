---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"@e2e-dev/desktop": patch
---

With `app.open(path, { relaunch: true })`, the app is started fresh before the path is opened:

- On a device target with `app.linkBase`, the pinned app is stopped if it's running, then launched from the link. If the app isn't running, there's no error.
- On a web target, the context is recreated as in `app.restart()`, then the path is opened instead of the base URL.

On a device, that launch has two limits:

- `app.launchArguments` and `app.permissions` aren't applied.
- On an iOS simulator, an `http(s)` link is opened only after the app has launched. Only a custom-scheme link is passed as the launch URL.

The device behavior is available when `linkRelaunch: true` is declared on the engine and `{ relaunch: true }` is handled in `session.openLink(url, context, options)`. Without it, the call fails with `UNSUPPORTED_CAPABILITY` instead of opening the link in the running app. `linkRelaunch` is declared in `@e2e-dev/mobile`, and the relaunch is sent as one agent-device `open --relaunch` with the link.

`linkRelaunch` is added to the engine manifest and the `engine-manifest-1` schema. An optional `options` param is added to `session/openLink`.
