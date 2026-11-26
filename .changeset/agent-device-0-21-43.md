---
"@e2e-dev/mobile": patch
"@e2e-dev/e2b": patch
"@e2e-dev/limrun": patch
"@e2e-dev/revyl": patch
"@e2e-dev/testmu": patch
---

Update agent-device to 0.21.43, which adds the lock-screen command behind `device.lock()` and `device.unlock()`. `@e2e-dev/revyl`, `@e2e-dev/testmu`, and `@e2e-dev/limrun` check that their agent-device matches the engine's, so they now need `@e2e-dev/mobile` 0.12.10 or newer.
