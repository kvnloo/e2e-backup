---
'e2e': patch
'@e2e-dev/core': patch
---

`expect(value)` has the matchers a Jest or Playwright suite uses on plain values: `toThrow()` (a string, a RegExp, a class, or an error narrows what was thrown), `toStrictEqual()`, `toContainEqual()`, `toBeInstanceOf()`, and `expect.closeTo()` inside a structural comparison. `expect(promise).resolves` and `.rejects` run any value matcher on what the promise settles with: `await expect(loadOrder(-1)).rejects.toThrow('no such order')`. They also work under `.not`, `expect.soft`, and `expect.poll`. [Value matchers](https://e2e.com/docs/reference/expect#value-matchers)
