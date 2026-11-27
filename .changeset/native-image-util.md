---
'@e2e-dev/util': patch
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/mobile': patch
---

Screenshot pixel work (PNG decoding and encoding, resizing for the model, `toHaveScreenshot` captures and comparisons, `locator.screenshot()` crops, and mobile masking) now runs in the new `@e2e-dev/util` native addon, off the JavaScript thread. The output is byte for byte what `@napi-rs/image` and `pixelmatch` produced, so stored screenshots do not change. `@napi-rs/image` and `pixelmatch` are no longer dependencies.
