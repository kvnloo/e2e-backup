---
'@e2e-dev/desktop': minor
'@e2e-dev/desktop-darwin-arm64': minor
'@e2e-dev/desktop-darwin-x64': minor
---

**Breaking:** the desktop engine no longer runs agent-desktop. It drives macOS through its own Rust driver, loaded into the test process through NAPI-RS and shipped for each Mac in `@e2e-dev/desktop-darwin-arm64` and `@e2e-dev/desktop-darwin-x64`, which npm installs with the engine. Nothing is downloaded on the first run, and the `desktop({ binary })` option is gone: remove it from your config. Keys and typing now reach an app in the background, so `press` and the keyboard capability no longer need `headed: true`. An open context menu or pop-up menu is read as part of its window, and a row scrolled out of its list reads as hidden. On Windows and Linux, a run that includes a desktop target now stops with `UNSUPPORTED_CAPABILITY` instead of `INVALID_CONFIG`: the config is valid, and the engine does not support the OS.
