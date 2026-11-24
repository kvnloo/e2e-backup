---
"@e2e-dev/web": patch
---

Add `browser.consoleMessages()` and `browser.pageErrors()` to read the active tab's console messages (`{ type, text }`) and its uncaught errors and unhandled promise rejections (`{ message, stack }`) since the tab opened.

- Up to 200 of the latest entries of each are kept.
- The lists aren't cleared on navigation.
- After `app.restart()`, the lists only have entries from the new page.

An init script that wraps `console.error` and listens for `error` and `unhandledrejection` is no longer needed to check for console errors.
