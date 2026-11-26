---
'@e2e-dev/mobile': patch
---

`session.save()` in a `test.setup` and the `session` test option work on a `mobile()` target that runs on a local iOS simulator or Android emulator. A session holds the app's data directory and what the app keeps in the keychain or the Keystore, and restores on any simulator or emulator in the run. A device provider's devices and physical devices do not support it. [On a device](https://e2e.com/docs/authentication#on-a-device)
