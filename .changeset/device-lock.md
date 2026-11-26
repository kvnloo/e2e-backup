---
'@e2e-dev/mobile': patch
---

`device.lock()` and `device.unlock()` lock and unlock the screen of an Android device or an iOS simulator, each as a recorded step that returns once the device reports the new state. `unlock()` never enters a PIN, pattern, password, or passcode: a lock that asks for one is `UNSUPPORTED_CAPABILITY`, and so is an Android screen lock set to None for `lock()`, a physical iPhone or iPad, and a TV. [device.lock](https://e2e.com/docs/reference/mobile#lock)
