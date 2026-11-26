---
'@e2e-dev/web': patch
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

`browser.locator(selector, { within })` runs a CSS or XPath selector inside another locator, as Playwright's `within.locator(selector)` does: `browser.locator('td.price', { within: row })`. `within` is any locator from `screen` or `browser` and keeps its frame. Engines get the parts: a `selector` expression takes an optional `scope`, `resolveExpression` and the mobile engine answer it over the scope's descendants, and a fixture reads a test's locator with `context.expressionOf(api, locator)`. [locator](https://e2e.com/docs/reference/web#locator)
