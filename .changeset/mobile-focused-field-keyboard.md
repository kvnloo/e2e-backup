---
"@e2e-dev/mobile": patch
---

Add `device.keyboard.type(text)` and `device.keyboard.press(key)` to type into the focused field without a locator, and accept `Backspace` in `press` on iOS and Android, on a field's locator and on the focused field. `Backspace` fails with `UNSUPPORTED_CAPABILITY` on a control that is not an enabled, editable text field, and on an Android device leased from BrowserStack, TestMu AI, or Revyl. Other named keys, such as `Tab`, and modifiers still fail with `UNSUPPORTED_CAPABILITY`.
